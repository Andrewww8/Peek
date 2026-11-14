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
