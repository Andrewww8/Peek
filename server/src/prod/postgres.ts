import pg from 'pg';

export function createPostgresPool(url: string, max = 2) {
  // Supabase's pooler certificate is not chained to a public root by node-postgres.
  const connection = new URL(url);
  const wantsSsl = connection.searchParams.has('sslmode') || /supabase/.test(connection.hostname);
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'supa', 'pgbouncer']) connection.searchParams.delete(key);
  return new pg.Pool({
    connectionString: connection.toString(), max, idleTimeoutMillis: 10_000,
    ...(wantsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}
