import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { decodeJwt, SignJWT } from 'jose';
import { AuthError, UUID } from './deps.js';
import { createGuestSessionAuth, lockedGuestAccount, registerGuestSessionRoute, type GuestAccount, type GuestRateLimiter } from './guest-session.js';
import { createJwtVerifier, SUPABASE_AUDIENCE } from './jwt.js';
import { createSupabaseGuestAccounts } from './prod/guest-session.js';
import { createSupabaseClient } from './prod/supabaseRepo.js';

const projectOrigin = 'https://peek-project.supabase.co';
const issuer = projectOrigin + '/auth/v1';
const staffSecret = 'test-supabase-secret';

function fixture(permit: GuestRateLimiter = async () => true) {
  const accounts = new Map<string, GuestAccount>();
  let creations = 0;
  const service = createGuestSessionAuth({
    secret: 'test-guest-secret', projectOrigin, behindVercel: true, permit,
    accountAuth: createJwtVerifier({ hsSecret: staffSecret, issuer }),
    accounts: {
      async lookup(id) { return accounts.get(id) ?? null; },
      async create(id, email) {
        creations++;
        const account = {
          id, email, role: lockedGuestAccount.role, app_metadata: lockedGuestAccount.app_metadata,
          banned_until: '2105-01-01T00:00:00.000Z',
        };
        accounts.set(id, account);
        return account;
      },
    },
  });
  return { ...service, accounts, creations: () => creations };
}

test('managed guests restore the same private identity and cannot impersonate another user', async () => {
  const service = fixture();
  const device = randomBytes(32).toString('hex');
  const first = await service.guestSessions.start(device, '203.0.113.10');
  const restored = await service.guestSessions.start(device, '203.0.113.11');
  const other = await service.guestSessions.start(randomBytes(32).toString('hex'), '203.0.113.10');
  assert.match(first.userId, UUID);
  assert.equal(restored.userId, first.userId);
  assert.notEqual(other.userId, first.userId);
  assert.equal(service.creations(), 2);
  assert.deepEqual(await service.auth.verify(first.accessToken), { userId: first.userId, isGuest: true });
  const claims = decodeJwt(first.accessToken);
  assert.equal(claims.aud, 'peek-api:guest');
  assert.equal(claims.exp! * 1000, first.expiresAt);
  assert.equal(claims.role, undefined);
  assert.equal(claims.email, undefined);
  const parts = first.accessToken.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...claims, sub: other.userId })).toString('base64url');
  await assert.rejects(service.auth.verify(parts.join('.')), AuthError);

  const signSupabase = (isGuest: boolean) => new SignJWT({ is_anonymous: isGuest })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setAudience(SUPABASE_AUDIENCE)
    .setSubject(other.userId).setExpirationTime('1h').sign(Buffer.from(staffSecret));
  assert.deepEqual(await service.auth.verify(await signSupabase(false)), { userId: other.userId, isGuest: false });
  assert.deepEqual(await service.auth.verify(await signSupabase(true)), { userId: other.userId, isGuest: true });

  const account = service.accounts.get(first.userId)!;
  service.accounts.set(first.userId, { ...account, role: 'authenticated', app_metadata: {} });
  await assert.rejects(service.guestSessions.start(device, '203.0.113.10'), /restricted identity/);
});

test('guest endpoint admits only well-formed device requests and uses the trusted client network', async (t) => {
  const actions: [string, string][] = [];
  let allowCreate = true;
  const service = fixture(async (action, network) => {
    actions.push([action, network]);
    return action === 'request' || allowCreate;
  });
  const app = Fastify();
  t.after(() => app.close());
  registerGuestSessionRoute(app, service.guestSessions);
  const deviceKey = randomBytes(32).toString('hex');
  const send = (ip?: string, key = deviceKey) => app.inject({
    method: 'POST', url: '/v1/guest-session', payload: { deviceKey: key },
    headers: ip ? { 'x-vercel-forwarded-for': ip, 'x-forwarded-for': '198.51.100.1' } : {},
  });
  assert.equal((await send('203.0.113.10', 'short')).statusCode, 400);
  assert.equal((await send()).statusCode, 503);
  assert.deepEqual(actions, []);
  const admitted = await send('203.0.113.10');
  assert.equal(admitted.statusCode, 200);
  assert.equal(admitted.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(admitted.json()).sort(), ['accessToken', 'expiresAt', 'userId']);
  assert.equal(actions[0]![1], actions[1]![1]);
  allowCreate = false;
  assert.equal((await send('::ffff:203.0.113.10')).json().userId, admitted.json().userId);
  assert.equal(actions[0]![1], actions[2]![1]);
  const denied = await send('203.0.113.10', randomBytes(32).toString('hex'));
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().error, 'guest_session_rate_limit');
  assert.equal(service.creations(), 1);
});

test('the Supabase adapter provisions only locked, unconfirmed internal accounts', async () => {
  const id = '89b3c66c-606e-44fd-a7f7-2ddda73e794f';
  const email = `guest-${id}@peek.invalid`;
  const guest = { id, email, role: 'anon', app_metadata: { peek_api_guest: true }, banned_until: '2105-01-01T00:00:00.000Z' };
  const db = createSupabaseClient(projectOrigin, 'fixture-service-role', async (input, init) => {
    const req = new Request(input, init);
    assert.equal(new URL(req.url).origin, projectOrigin);
    assert.equal(req.headers.get('authorization'), 'Bearer fixture-service-role');
    if (req.method === 'GET') {
      assert.equal(new URL(req.url).pathname, `/auth/v1/admin/users/${id}`);
      return Response.json({ code: 'user_not_found', msg: 'fixture user missing' }, { status: 404 });
    }
    assert.equal(req.method, 'POST');
    assert.equal(new URL(req.url).pathname, '/auth/v1/admin/users');
    assert.deepEqual(await req.json(), { id, email, ...lockedGuestAccount });
    return Response.json(guest);
  });
  const accounts = createSupabaseGuestAccounts(db);
  assert.equal(await accounts.lookup(id), null);
  assert.deepEqual(await accounts.create(id, email), guest);
});
