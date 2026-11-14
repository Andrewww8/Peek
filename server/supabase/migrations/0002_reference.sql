-- Professional reference library (PROJECT_CONTEXT.md, "Professional reference library").
-- Server-only: RLS is enabled with no policies, so only the service role (the API and
-- the reference-ingest / reference-review scripts) can read or write these tables.

create table if not exists public.reference_clips (
  id              uuid        primary key,
  title           text        not null,
  source          text        not null,
  rights_note     text        not null,
  -- Private Blob paths under reference/<id>/; null once reviewed and deleted (--finalize).
  video_pathname  text,
  npz_pathname    text,
  fps             double precision not null check (fps > 0),
  created_at      timestamptz not null default now()
);

create table if not exists public.reference_shots (
  id             uuid        primary key,
  clip_id        uuid        not null references public.reference_clips (id) on delete cascade,
  track          integer     not null,
  release_frame  integer     not null,
  shot_type      text        not null check (shot_type ~ '^[a-z0-9_]{1,64}$'),
  -- The coach uses only verified shots.
  verified       boolean     not null default false,
  -- Same shape as shot_clips.analysis: metrics, quality flags and the compact shooter pose.
  metrics        jsonb       not null,
  created_at     timestamptz not null default now(),
  unique (clip_id, track, release_frame)
);

create index if not exists reference_shots_verified on public.reference_shots (shot_type) where verified;

alter table public.reference_clips enable row level security;
alter table public.reference_shots enable row level security;
