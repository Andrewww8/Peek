-- Shot clips cut from tagged practice recordings (PROJECT_CONTEXT.md, "Authenticated endpoints").
-- The API writes with the service-role key (which bypasses RLS) and always filters on user_id;
-- RLS keeps any client-side access limited to the player's own rows.

create table if not exists public.shot_clips (
  user_id          uuid        not null references auth.users (id) on delete cascade,
  session_id       uuid        not null,
  shot_number      integer     not null check (shot_number > 0),
  shot_type        text        not null check (shot_type ~ '^[a-z0-9_]{1,64}$'),
  release_ms       integer     not null check (release_ms >= 0),
  outcome          text        not null check (outcome in ('made', 'missed', 'unmarked')),
  clip_pathname    text        not null,
  start_ms         integer     not null check (start_ms >= 0),
  end_ms           integer     not null check (end_ms > start_ms),
  size_bytes       bigint      not null check (size_bytes > 0),
  analysis_status  text        not null default 'pending',
  analysis         jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, session_id, shot_number)
);

create or replace function public.shot_clips_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists shot_clips_updated_at on public.shot_clips;
create trigger shot_clips_updated_at
  before update on public.shot_clips
  for each row execute function public.shot_clips_set_updated_at();

alter table public.shot_clips enable row level security;

drop policy if exists "shot_clips_select_own" on public.shot_clips;
create policy "shot_clips_select_own" on public.shot_clips
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "shot_clips_insert_own" on public.shot_clips;
create policy "shot_clips_insert_own" on public.shot_clips
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "shot_clips_update_own" on public.shot_clips;
create policy "shot_clips_update_own" on public.shot_clips
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "shot_clips_delete_own" on public.shot_clips;
create policy "shot_clips_delete_own" on public.shot_clips
  for delete to authenticated using (user_id = (select auth.uid()));
