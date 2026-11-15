import { getRandomBytesAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { apiOrigin, apiUrl } from './api';

type GuestSession = { userId: string; accessToken: string; expiresAt: number };
const keychain = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const keyPattern = /^[a-f0-9]{64}$/;
const listeners = new Set<() => void>();
let current: GuestSession | null = null;
let restored: Promise<GuestSession | null> | undefined;
let connecting: Promise<GuestSession> | undefined;

function keyName(kind: 'device' | 'session') {
  return 'peek.guest.' + apiOrigin(apiUrl).hostname + '.' + kind;
}

function validSession(value: unknown): value is GuestSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<GuestSession>;
  return typeof s.userId === 'string' && uuid.test(s.userId) &&
    typeof s.accessToken === 'string' && s.accessToken.length > 0 && s.accessToken.length < 1400 &&
    typeof s.expiresAt === 'number' && Number.isFinite(s.expiresAt) && s.expiresAt > 0;
}

function setGuest(session: GuestSession) {
  const changed = current?.userId !== session.userId;
  current = session;
  if (changed) for (const listener of listeners) listener();
}

export const guestUserId = () => current?.userId ?? null;

export function subscribeToGuest(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function restoreDeviceGuest() {
  return restored ??= (async () => {
    try {
      const value = await SecureStore.getItemAsync(keyName('session'), keychain);
      const parsed: unknown = value && JSON.parse(value);
      if (validSession(parsed)) setGuest(parsed);
    } catch {
      // Secure storage or a changed API origin can leave no restorable identity.
    }
    return current;
  })();
}

export function connectDeviceGuest(refresh = false) {
  return connecting ??= requestGuest(refresh).finally(() => { connecting = undefined; });
}

async function requestGuest(refresh: boolean): Promise<GuestSession> {
  await restoreDeviceGuest();
  if (!refresh && current && current.expiresAt > Date.now() + 60_000) return current;

  const identity = keyName('device');
  let deviceKey = await SecureStore.getItemAsync(identity, keychain);
  if (!deviceKey || !keyPattern.test(deviceKey)) {
    const random = await getRandomBytesAsync(32);
    deviceKey = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
    await SecureStore.setItemAsync(identity, deviceKey, keychain);
  }

  const response = await fetch(new URL('/v1/guest-session', apiOrigin(apiUrl)).href, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceKey }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 429) throw new Error('Guest sign-in is busy right now. Try again in a few minutes.');
    throw new Error('Could not reach guest sign-in. Try again in a moment.');
  }
  if (!validSession(body) || body.expiresAt <= Date.now()) {
    throw new Error('Peek received an invalid guest session. Try again.');
  }
  await SecureStore.setItemAsync(keyName('session'), JSON.stringify(body), keychain);
  setGuest(body);
  return body;
}
