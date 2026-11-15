import type { CloudSyncIssue } from './database';
import { RECORD_LIMIT_SECONDS, RECORD_MAX_BYTES } from './practice';

const descriptions: Record<CloudSyncIssue, string> = {
  missing_recording: 'The original recording is missing from this iPhone.',
  unsupported_recording: 'Cloud analysis requires a MOV, MP4, or M4V recording.',
  recording_too_large: `Cloud analysis accepts recordings up to ${RECORD_MAX_BYTES / 1_000_000} MB.`,
  recording_too_long: `Cloud analysis accepts recordings up to ${RECORD_LIMIT_SECONDS} seconds.`,
  recording_unreadable: 'The server couldn’t open this recording.',
  release_after_end: 'The tagged release is past the end of the recording. Mark the release inside the video.',
  invalid_shot: 'The cloud service rejected this shot tag. Mark the release again in Session details.',
  cloud_clip_missing: 'The server no longer has a copy of this shot.',
};

export function cloudIssueText(issue?: CloudSyncIssue | null) {
  return issue ? descriptions[issue] : 'Cloud analysis is unavailable for this shot.';
}
