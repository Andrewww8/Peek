-- Averaged pro shot templates (PROJECT_CONTEXT.md, "Professional reference library: averaged pro
-- shot templates"). One row per (player, shot type), written by scripts/reference-templates-ingest.ts.
-- Server-only: RLS is enabled with no policies, so only the service role reads or writes.

create table if not exists public.reference_templates (
  id                        uuid        primary key default gen_random_uuid(),
  player                    text        not null,
  shot_type                 text        not null check (shot_type in ('three_point', 'midrange')),
  shooting_hand             text        not null check (shooting_hand in ('right', 'left')),
  fps                       double precision not null check (fps > 0),
  release_index             integer     not null check (release_index >= 0),
  shots_averaged            integer     not null check (shots_averaged > 0),
  shots_confident_distance  integer     not null check (shots_confident_distance >= 0),
  -- Same metric definitions as a player's analysis.comparison.metrics.
  metrics                   jsonb       not null,
  -- Release-aligned curves on the template grid: elbow, knee, wrist height, pelvis rise, per-frame spread.
  curves                    jsonb       not null,
  -- Compact canonical pose + extremities + pelvis rise + joint spread (base64 int16), for comparisons.
  template                  jsonb       not null,
  source_file               text        not null,
  -- Averaged from fewer than 10 shots: down-weighted in the calibration.
  low_confidence            boolean     not null,
  -- No shot with a confident distance: the shot-type label is uncertain.
  uncertain_distance        boolean     not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (player, shot_type)
);

create or replace function public.reference_templates_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists reference_templates_updated_at on public.reference_templates;
create trigger reference_templates_updated_at
  before update on public.reference_templates
  for each row execute function public.reference_templates_set_updated_at();

alter table public.reference_templates enable row level security;
