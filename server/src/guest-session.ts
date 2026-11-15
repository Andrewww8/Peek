import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { decodeJwt, jwtVerify, SignJWT } from 'jose';
import { AuthError, UUID, type AuthVerifier } from './deps.js';

const deviceKeyPattern = /^[0-9a-f]{64}$/;
const guestAudience = 'peek-api:guest';
const tokenLifetimeSeconds = 3_600;
const guestMarker = 'peek_api_guest';

export type GuestSession = { userId: string; accessToken: string; expiresAt: number };

export interface GuestSessions {
  /** Trust only Vercel's own forwarded client address when running on Vercel. */
  behindVercel: boolean;
  start(deviceKey: string, clientAddress: string): Promise<GuestSession>;
}

export interface GuestAccount {
  id: string;
  email?: string;
  role?: string;
  app_metadata: Record<string, unknown>;
  banned_until?: string;
}

export interface GuestAccountStore {
  lookup(id: string): Promise<GuestAccount | null>;
  create(id: string, email: string): Promise<GuestAccount>;
}

export type GuestRateLimiter = (action: 'request' | 'provision', networkHash: string) => Promise<boolean>;

class GuestRateLimitError extends Error {}

/** IPv4 and IPv4-mapped addresses share a bucket. IPv6 addresses share their network's /64. */
function networkOf(address: string): string | undefined {
  if (address.includes('%')) return;
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return;

  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [before, after] = normalized.split('::');
  const left = before ? before.split(':') : [];
  const right = after ? after.split(':') : [];
  const parts = (after === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right])
    .map((part) => parseInt(part, 16));
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    const upper = parts[6]!;
    const lower = parts[7]!;
    return [upper >>> 8, upper & 255, lower >>> 8, lower & 255].join('.');
  }
  return parts.slice(0, 4).map((part) => part.toString(16)).join(':') + '::/64';
}

const keyed = (secret: string | Uint8Array, context: string, value: string) =>
  createHmac('sha256', secret).update(context).update('\0').update(value).digest();

function deviceId(identityKey: Uint8Array, deviceKey: string): string {
  const bytes = keyed(identityKey, 'guest-id', deviceKey).subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const lockedGuestAccount = {
  role: 'anon',
  // The API uses this record for foreign keys. Supabase does not sign guests into it.
  email_confirm: false,
  ban_duration: '876000h',
  app_metadata: { [guestMarker]: true },
} as const;

export function createGuestSessionAuth(options: {
  secret: string;
  projectOrigin: string;
  behindVercel: boolean;
  accounts: GuestAccountStore;
  permit: GuestRateLimiter;
  accountAuth: AuthVerifier;
}): { guestSessions: GuestSessions; auth: AuthVerifier } {
  const { secret, projectOrigin, accounts, permit, accountAuth } = options;
  const issuer = 'urn:peek:guest:v1:' + new URL(projectOrigin).hostname;
  const identityKey = keyed(secret, 'peek/guest/identity/v1', issuer);
  const signingKey = keyed(secret, 'peek/guest/signing/v1', issuer);
  const networkKey = keyed(secret, 'peek/guest/network/v1', issuer);

  return {
    guestSessions: {
      behindVercel: options.behindVercel,
      async start(deviceKey, clientAddress) {
        if (!deviceKeyPattern.test(deviceKey)) throw new AuthError('invalid guest device key');
        const network = networkOf(clientAddress);
        if (!network) throw new Error('Trusted guest client address unavailable');
        const networkHash = keyed(networkKey, 'network', network).toString('hex');
        if (!await permit('request', networkHash)) throw new GuestRateLimitError();
        const userId = deviceId(identityKey, deviceKey);
        const email = `guest-${userId}@peek.invalid`;
        let account = await accounts.lookup(userId);
        if (!account) {
          if (!await permit('provision', networkHash)) throw new GuestRateLimitError();
          try {
            account = await accounts.create(userId, email);
          } catch (error) {
            // Concurrent installs with the same key or a retry after a lost response can already own this ID.
            account = await accounts.lookup(userId);
            if (!account) throw error;
          }
        }

        const issuedAt = Math.floor(Date.now() / 1000);
        const expires = issuedAt + tokenLifetimeSeconds;
        if (account.id !== userId || account.email !== email || account.role !== lockedGuestAccount.role ||
            account.app_metadata[guestMarker] !== true || !(Date.parse(account.banned_until ?? '') > expires * 1000)) {
          throw new Error('Managed guest account does not match its restricted identity');
        }
        const accessToken = await new SignJWT({})
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .setIssuer(issuer).setAudience(guestAudience).setSubject(userId)
          .setIssuedAt(issuedAt).setExpirationTime(expires).sign(signingKey);
        return { userId, accessToken, expiresAt: expires * 1000 };
      },
    },
    auth: {
      async verify(token) {
        let claimedIssuer: string | undefined;
        try {
          claimedIssuer = decodeJwt(token).iss;
        } catch {
          throw new AuthError('invalid access token');
        }
        if (claimedIssuer !== issuer) return accountAuth.verify(token);
        try {
          const { payload } = await jwtVerify(token, signingKey, {
            issuer, audience: guestAudience, algorithms: ['HS256'],
            requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
            maxTokenAge: tokenLifetimeSeconds,
          });
          if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) throw new AuthError('invalid guest subject');
          return { userId: payload.sub, isGuest: true };
        } catch {
          throw new AuthError('invalid guest access token');
        }
      },
    },
  };
}

export function registerGuestSessionRoute(app: FastifyInstance, sessions?: GuestSessions) {
  app.post<{ Body: { deviceKey?: unknown } }>(
    '/v1/guest-session',
    { bodyLimit: 256 },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const key = request.body?.deviceKey;
      if (typeof key !== 'string' || !deviceKeyPattern.test(key)) {
        return reply.code(400).send({ error: 'invalid_guest_device', message: 'A valid guest device key is required.' });
      }
      if (!sessions) return reply.code(503).send({ error: 'guest_session_unavailable', message: 'Guest access is unavailable right now.' });
      const address = sessions.behindVercel ? request.headers['x-vercel-forwarded-for'] : request.ip;
      if (typeof address !== 'string' || !networkOf(address)) {
        return reply.code(503).send({ error: 'guest_session_unavailable', message: 'Guest access is unavailable right now.' });
      }
      try {
        return await sessions.start(key, address);
      } catch (error) {
        if (error instanceof GuestRateLimitError) {
          return reply.code(429).send({ error: 'guest_session_rate_limit', message: 'Too many guest session requests. Try again later.' });
        }
        request.log.error({ err: error }, 'Guest session unavailable');
        return reply.code(503).send({ error: 'guest_session_unavailable', message: 'Guest access is unavailable right now.' });
      }
    },
  );
}
