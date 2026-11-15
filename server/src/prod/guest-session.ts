import type { SupabaseClient } from '@supabase/supabase-js';
import type { Pool } from 'pg';
import { lockedGuestAccount, type GuestAccountStore, type GuestRateLimiter } from '../guest-session.js';

export function createSupabaseGuestAccounts(db: SupabaseClient): GuestAccountStore {
  return {
    async lookup(id) {
      const { data, error } = await db.auth.admin.getUserById(id);
      if (error?.status === 404 || error?.code === 'user_not_found') return null;
      if (error) throw new Error(`Could not look up guest identity: ${error.code ?? error.status ?? 'unknown'}`);
      return data.user;
    },
    async create(id, email) {
      const { data, error } = await db.auth.admin.createUser({ id, email, ...lockedGuestAccount });
      if (error || !data.user) throw new Error(`Could not provision guest identity: ${error?.code ?? error?.status ?? 'unknown'}`);
      return data.user;
    },
  };
}

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const limits = {
  request: { bucketMs: hourMs, global: 2_000, network: 100 },
  provision: { bucketMs: dayMs, global: 200, network: 20 },
} as const;

export function createPostgresGuestRateLimiter(pool: Pool): GuestRateLimiter {
  let ready: Promise<void> | undefined;

  async function setup() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('peek_guest_private.issuance.v1'))");
      await client.query(`
        CREATE SCHEMA IF NOT EXISTS peek_guest_private;
        REVOKE ALL ON SCHEMA peek_guest_private FROM PUBLIC;
        CREATE TABLE IF NOT EXISTS peek_guest_private.issuance (
          bucket_end timestamptz NOT NULL,
          scope text NOT NULL,
          uses integer NOT NULL CHECK (uses > 0),
          PRIMARY KEY (bucket_end, scope)
        );
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return async (action, networkHash) => {
    await (ready ??= setup().catch((error) => {
      ready = undefined;
      throw error;
    }));
    const limit = limits[action];
    const bucketEnd = new Date((Math.floor(Date.now() / limit.bucketMs) + 1) * limit.bucketMs);
    const global = `${action}:global`;
    const network = `${action}:network:${networkHash}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Both limits must admit this request. In a rejection neither allowance is charged.
      const taken = await client.query(`
        INSERT INTO peek_guest_private.issuance AS bucket (bucket_end, scope, uses)
          VALUES ($1, $2, 1), ($1, $3, 1)
        ON CONFLICT (bucket_end, scope) DO UPDATE SET uses = bucket.uses + 1
          WHERE bucket.uses < CASE WHEN bucket.scope = $2 THEN $4::integer ELSE $5::integer END
        RETURNING scope
      `, [bucketEnd, global, network, limit.global, limit.network]);
      if (taken.rowCount !== 2) {
        await client.query('ROLLBACK');
        return false;
      }
      if (action === 'provision') await client.query(`DELETE FROM peek_guest_private.issuance WHERE bucket_end < now() - interval '1 day'`);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}
