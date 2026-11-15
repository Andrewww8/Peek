export const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim() || 'https://perspective-api-eta.vercel.app';

export function httpsUrl(value: string, base?: URL) {
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function apiOrigin(value: string) {
  const url = httpsUrl(value);
  if (!url || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Set EXPO_PUBLIC_API_URL to the Vercel HTTPS API origin.');
  }
  return url;
}

type AccessToken = (refresh: boolean) => Promise<string | null>;

export function accountFetch(baseUrl: string, accessToken: AccessToken, fetchApi: typeof fetch = fetch) {
  const origin = apiOrigin(baseUrl);
  let refreshed: string | null = null;

  return async (path: string, init: RequestInit) => {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin) throw new Error('Invalid API destination.');
    const headers = new Headers(init.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    const send = (token: string) => {
      init.signal?.throwIfAborted();
      headers.set('Authorization', `Bearer ${token}`);
      return fetchApi(url.href, { ...init, headers: new Headers(headers), redirect: 'error' });
    };

    const token = refreshed ?? await accessToken(false);
    if (!token) throw new Error('Sign in to connect to the clip service.');
    const response = await send(token);
    if (response.status !== 401 || refreshed) return response;

    await response.body?.cancel();
    init.signal?.throwIfAborted();
    refreshed = await accessToken(true);
    if (!refreshed) throw new Error('Sign in to connect to the clip service.');
    return send(refreshed);
  };
}
