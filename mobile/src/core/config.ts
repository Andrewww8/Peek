export const RECORDING = {
  resolution: '720p',
  maxDurationMs: 30_000,
  targetVideoBitrate: 4_000_000,
  /** 30 s × 4 Mbps ≈ 15 MB, plus room for audio and container overhead. */
  reserveBytes: 20_000_000,
} as const;

/** Never fill the phone completely; keep this much free after any write. */
export const FREE_SPACE_HEADROOM_BYTES = 50_000_000;

export const NETWORK = {
  catalogTimeoutMs: 4_000,
  healthTimeoutMs: 2_500,
  /** Max time for a model download to complete. */
  downloadTimeoutMs: 120_000,
  /**
   * How long tagging waits to learn whether a player is signed in. Signed out
   * answers at once (no stored session); only a stored session can need a
   * network refresh, so running out of time means "signed in".
   */
  authProbeMs: 500,
  /** Authenticated JSON calls (upload URL, PATCH, DELETE). */
  apiTimeoutMs: 15_000,
  /** POST …/clips: the API cuts every clip before it answers. */
  clipCutTimeoutMs: 120_000,
  /** PUT of one recording (cap 60 MB) straight to Blob storage. */
  recordingUploadTimeoutMs: 300_000,
} as const;

export const DIRS = {
  videos: 'videos/',
  models: 'models/',
  /** Under cacheUri: partial downloads. */
  downloads: 'perspective-downloads/',
  /**
   * Under cacheUri: videos being deleted. A video is moved here before its row
   * changes, so an interrupted delete never leaves an orphan in videos/ (which
   * launch recovery adopts as a session).
   */
  trash: 'perspective-trash/',
} as const;

export const DEFAULT_SHOT_TYPE = 'three_point';
