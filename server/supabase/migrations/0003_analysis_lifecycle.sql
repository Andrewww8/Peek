-- Shot analysis lifecycle and coach usage (PROJECT_CONTEXT.md, "Shot analysis" and "AI coach").
-- Shot clips are temporary: after analysis the mp4 and npz are deleted, clip_pathname becomes
-- null and media_deleted_at records when. Only shot_clips.analysis is kept.
-- The coach's conversation history lives in the LangGraph Postgres checkpointer, which creates
-- its own tables (checkpoints, checkpoint_blobs, checkpoint_writes, checkpoint_migrations) via setup().

alter table public.shot_clips alter column clip_pathname drop not null;
alter table public.shot_clips add column if not exists media_deleted_at timestamptz;

alter table public.shot_clips drop constraint if exists shot_clips_analysis_status_check;
alter table public.shot_clips add constraint shot_clips_analysis_status_check
  check (analysis_status in ('pending', 'complete', 'failed', 'expired'));

-- A clip row either still points at its media, or records when the media was deleted.
alter table public.shot_clips drop constraint if exists shot_clips_media_check;
alter table public.shot_clips add constraint shot_clips_media_check
  check (clip_pathname is not null or media_deleted_at is not null);

create table if not exists public.coach_usage (
  user_id                uuid    not null references auth.users (id) on delete cascade,
  day                    date    not null,
  messages               integer not null default 0 check (messages >= 0),
  turns                  integer not null default 0,
  input_tokens           bigint  not null default 0,
  output_tokens          bigint  not null default 0,
  cache_read_tokens      bigint  not null default 0,
  cache_creation_tokens  bigint  not null default 0,
  updated_at             timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.coach_usage enable row level security;
drop policy if exists "coach_usage_select_own" on public.coach_usage;
create policy "coach_usage_select_own" on public.coach_usage
  for select to authenticated using (user_id = (select auth.uid()));

-- Counts one coach message for (user, day) unless the daily limit is reached, atomically.
create or replace function public.coach_consume(p_user uuid, p_day date, p_limit integer)
returns table (allowed boolean, messages integer)
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  insert into public.coach_usage as u (user_id, day, messages)
  values (p_user, p_day, 1)
  on conflict (user_id, day) do update
    set messages = u.messages + 1, updated_at = now()
    where u.messages < p_limit
  returning u.messages into n;
  if n is null then
    select u.messages into n from public.coach_usage u where u.user_id = p_user and u.day = p_day;
    return query select false, coalesce(n, 0);
  else
    return query select true, n;
  end if;
end;
$$;

-- Adds one turn's token usage, for cost tracking.
create or replace function public.coach_record_usage(
  p_user uuid, p_day date, p_input bigint, p_output bigint, p_cache_read bigint, p_cache_creation bigint
)
returns void
language sql
set search_path = ''
as $$
  insert into public.coach_usage as u (user_id, day, turns, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
  values (p_user, p_day, 1, p_input, p_output, p_cache_read, p_cache_creation)
  on conflict (user_id, day) do update set
    turns = u.turns + 1,
    input_tokens = u.input_tokens + excluded.input_tokens,
    output_tokens = u.output_tokens + excluded.output_tokens,
    cache_read_tokens = u.cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = u.cache_creation_tokens + excluded.cache_creation_tokens,
    updated_at = now();
$$;

-- Only the API (service role) may call these.
revoke execute on function public.coach_consume(uuid, date, integer) from public, anon, authenticated;
revoke execute on function public.coach_record_usage(uuid, date, bigint, bigint, bigint, bigint) from public, anon, authenticated;
