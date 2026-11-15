-- The pose worker polls GET /v1/internal/analysis/jobs every 15 seconds. That runs
--   where analysis_status = 'pending' and clip_pathname is not null and created_at > $cutoff
--   order by created_at, user_id, session_id, shot_number limit 8
-- (ClipRepo.listPending). shot_clips keeps every analyzed shot forever and only had its primary
-- key, so each poll scanned and sorted the whole table. This partial index holds only the shots
-- still waiting for analysis, in the poll's order, so a poll reads a few index entries.
create index if not exists shot_clips_pending_analysis
  on public.shot_clips (created_at, user_id, session_id, shot_number)
  where analysis_status = 'pending' and clip_pathname is not null;
