import { createClient, processLock } from '@supabase/supabase-js';
import type { Session } from '@supabase/supabase-js';
import { AESEncryptionKey, aesDecryptAsync, aesEncryptAsync, AESSealedData } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { SQLiteStorage } from 'expo-sqlite/kv-store';

const storage = new SQLiteStorage('perspective-auth');
const keychain = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let savedSession: Session | null = null;
let authStorageKey: string | undefined;

function rememberSession(name: string, value: string | null) {
  if (name !== authStorageKey) return;
  try {
    const session = value ? JSON.parse(value) as Session : null;
    savedSession = session?.user?.id && session.refresh_token ? session : null;
  } catch {
    savedSession = null;
  }
}

// Supabase sessions can exceed Keychain item limits. Keep the AES-GCM key in
// Keychain and store only the sealed session in the existing SQLite module.
const encryptedStorage = {
  async getItem(name: string) {
    const ciphertext = await storage.getItem(name);
    if (!ciphertext) {
      rememberSession(name, null);
      return null;
    }
    const secret = await SecureStore.getItemAsync(name, keychain);
    if (!secret) {
      rememberSession(name, null);
      await storage.removeItem(name);
      return null;
    }

    try {
      const key = await AESEncryptionKey.import(secret, 'base64');
      const value = await aesDecryptAsync(AESSealedData.fromCombined(ciphertext), key, {
        additionalData: encoder.encode(name),
      });
      const session = decoder.decode(value);
      rememberSession(name, session);
      return session;
    } catch {
      await encryptedStorage.removeItem(name);
      return null;
    }
  },

  async setItem(name: string, value: string) {
    const secret = await SecureStore.getItemAsync(name, keychain);
    const key = secret ? await AESEncryptionKey.import(secret, 'base64') : await AESEncryptionKey.generate();
    const sealed = await aesEncryptAsync(encoder.encode(value), key, { additionalData: encoder.encode(name) });
    if (!secret) {
      await SecureStore.setItemAsync(name, await key.encoded('base64'), keychain);
    }
    await storage.setItem(name, await sealed.combined('base64'));
    rememberSession(name, value);
  },

  async removeItem(name: string) {
    await SecureStore.deleteItemAsync(name, keychain);
    rememberSession(name, null);
    await storage.removeItem(name);
  },
};

function createAuthClient() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const publishable = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const key = publishable?.startsWith('sb_publishable_') ? publishable : validAnonKey(anon) ? anon : undefined;
  if (!url || !key) return null;

  try {
    const project = new URL(url);
    if (project.protocol !== 'https:' || project.username || project.password || project.search || project.hash ||
        project.pathname !== '/') return null;
    authStorageKey = `perspective-auth.${project.hostname}`;
    return createClient(project.origin, key, {
      global: {
        fetch: (input, init) => {
          const timeout = AbortSignal.timeout(12_000);
          return fetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
        },
      },
      auth: {
        storage: encryptedStorage,
        storageKey: authStorageKey,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        lock: processLock,
      },
    });
  } catch {
    return null;
  }
}

function validAnonKey(value: string | undefined) {
  const payload = value?.split('.')[1];
  if (!payload || value?.split('.').length !== 3) return false;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))).role === 'anon';
  } catch {
    return false;
  }
}

export const supabase = createAuthClient();

export function storedSession() {
  return savedSession;
}

export async function accessToken(userId: string, refresh: boolean) {
  if (!supabase || savedSession?.user.id !== userId) return null;
  const { data, error } = refresh ? await supabase.auth.refreshSession() : await supabase.auth.getSession();
  if (error) {
    if (error.name === 'AuthSessionMissingError' || error.status === 400 || error.status === 401 || error.status === 403) {
      return null;
    }
    throw new Error('Could not reach sign-in. Check your connection and try again.');
  }
  return data.session?.user.id === userId && savedSession?.user.id === userId ? data.session.access_token : null;
}
