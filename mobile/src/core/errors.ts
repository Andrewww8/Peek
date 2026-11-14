export type BackendErrorCode =
  | 'recording_missing'
  | 'insufficient_space'
  | 'not_found'
  | 'invalid_input'
  | 'unreachable'
  | 'timeout'
  | 'http_error'
  | 'invalid_catalog'
  | 'size_mismatch'
  | 'download_failed'
  /** The build has no API URL (EXPO_PUBLIC_API_URL): demo downloads and clip sync are off. */
  | 'not_configured'
  /** The API refused the access token (401): signed out, expired or invalid. */
  | 'unauthorized'
  /** An authenticated API call answered with a body that does not match the contract. */
  | 'invalid_response'
  /** An unexpected local failure during clip sync; the work stays queued. */
  | 'sync_failed';

export class BackendError extends Error {
  constructor(
    readonly code: BackendErrorCode,
    message: string,
    /** HTTP status, for http_error. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export const codeOf = (err: unknown): BackendErrorCode =>
  err instanceof BackendError ? err.code : 'download_failed';
