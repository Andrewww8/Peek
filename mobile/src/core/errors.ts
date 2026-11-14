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
  /** The build has no laptop URL (EXPO_PUBLIC_API_URL); only the 3D demo download is affected. */
  | 'not_configured';

export class BackendError extends Error {
  constructor(
    readonly code: BackendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export const codeOf = (err: unknown): BackendErrorCode =>
  err instanceof BackendError ? err.code : 'download_failed';
