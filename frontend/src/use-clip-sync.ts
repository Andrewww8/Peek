import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { apiUrl } from './api';
import { accessToken } from './auth';
import { GuestQuotaError, syncCloudClips } from './clip-sync';
import type { PracticeStore } from './database';
import { localVideoUri, uploadRecording } from './device-storage';

export function useClipSync(store: PracticeStore, userId: string | null) {
  const running = useRef<Promise<void>>(Promise.resolve());
  const kick = useRef<() => void>(() => {});
  const [limit, setLimit] = useState<{ userId: string; message: string }>();

  useEffect(() => {
    const accountId = userId;
    if (!accountId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let syncing = false;
    let syncAgain = false;

    function schedule(delay: number) {
      if (!accountId || signal.aborted || AppState.currentState === 'background') return;
      if (syncing) {
        syncAgain = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        syncing = true;
        syncAgain = false;
        let retryIn = 30_000;
        running.current = running.current.then(async () => {
          if (!signal.aborted && AppState.currentState !== 'background' && store.hasCloudWork(accountId)) {
            await syncCloudClips({
              baseUrl: apiUrl,
              store,
              account: { id: accountId, accessToken: (refresh) => accessToken(accountId, refresh) },
              upload: uploadRecording,
              hasRecording: (path) => localVideoUri(path) !== null,
              signal,
            });
            if (!signal.aborted) setLimit(undefined);
          }
        }).catch((error: unknown) => {
          if (!signal.aborted && error instanceof GuestQuotaError) {
            setLimit({ userId: accountId, message: error.message });
            const dayMs = 86_400_000;
            retryIn = dayMs - (Date.now() % dayMs) + 1000;
          }
          // The SQLite queue retains unfinished work. A new tag or foreground event can restart it.
        }).finally(() => {
          syncing = false;
          if (!signal.aborted && store.hasCloudWork(accountId)) schedule(syncAgain ? 800 : retryIn);
        });
      }, delay);
    }

    kick.current = () => schedule(800);
    schedule(0);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') schedule(0);
      else if (state === 'background') clearTimeout(timer);
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      listener.remove();
      kick.current = () => {};
    };
  }, [store, userId]);

  return { schedule: () => kick.current(), guestLimit: limit?.userId === userId ? limit?.message : undefined };
}
