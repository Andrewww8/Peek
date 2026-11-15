/**
 * Supabase access-token verification, shared by production and the local
 * stand-in so both reject the same tokens: wrong audience, expired, bad
 * signature, or a `sub` that is not a UUID.
 */
import { createRemoteJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AuthError, UUID, type AuthVerifier } from './deps.js';

export const SUPABASE_AUDIENCE = 'authenticated';

export interface JwtVerifierOptions {
  /** Asymmetric keys (RS256/ES256), e.g. the project's remote JWKS. */
  jwks?: JWTVerifyGetKey;
  /** Legacy HS256 secret, accepted only for tokens whose header says HS256. */
  hsSecret?: string;
  /** Expected `iss`, when known. */
  issuer?: string;
}

export function createJwtVerifier(opts: JwtVerifierOptions): AuthVerifier {
  const secret = opts.hsSecret ? new TextEncoder().encode(opts.hsSecret) : null;
  const claims = { audience: SUPABASE_AUDIENCE, ...(opts.issuer ? { issuer: opts.issuer } : {}) };
  return {
    async verify(token) {
      let alg: string | undefined;
      try {
        alg = decodeProtectedHeader(token).alg;
      } catch {
        throw new AuthError('malformed token');
      }
      let payload;
      try {
        if (alg === 'HS256') {
          if (!secret) throw new AuthError('HS256 tokens are not accepted');
          ({ payload } = await jwtVerify(token, secret, { ...claims, algorithms: ['HS256'] }));
        } else {
          if (!opts.jwks) throw new AuthError(`${alg} tokens are not accepted`);
          ({ payload } = await jwtVerify(token, opts.jwks, { ...claims, algorithms: ['RS256', 'ES256', 'EdDSA'] }));
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
        // A JWKS endpoint that times out or cannot be fetched is our failure (500), not a bad token.
        if (err instanceof errors.JWKSTimeout || !(err instanceof errors.JOSEError)) throw err;
        throw new AuthError(err.message);
      }
      if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) throw new AuthError('sub must be a UUID');
      return { userId: payload.sub.toLowerCase(), isGuest: payload.is_anonymous === true };
    },
  };
}

/** Production verifier for a Supabase project. */
export function createSupabaseVerifier(supabaseUrl: string, jwtSecret?: string, jwks?: JWTVerifyGetKey): AuthVerifier {
  const base = supabaseUrl.replace(/\/+$/, '');
  return createJwtVerifier({
    jwks: jwks ?? createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`)),
    hsSecret: jwtSecret || undefined,
    issuer: `${base}/auth/v1`,
  });
}
