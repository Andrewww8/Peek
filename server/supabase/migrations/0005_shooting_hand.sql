-- The player's declared shooting hand (sent with POST /v1/recordings/:uploadId/clips as
-- `shootingHand: "R" | "L"`). When set, shot analysis uses it; otherwise it detects the hand.
alter table public.shot_clips add column if not exists shooting_hand text;
alter table public.shot_clips drop constraint if exists shot_clips_shooting_hand_check;
alter table public.shot_clips add constraint shot_clips_shooting_hand_check
  check (shooting_hand is null or shooting_hand in ('right', 'left'));
