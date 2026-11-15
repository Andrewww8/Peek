-- Explicit Data API grants for the API and its ingest scripts. RLS and
-- client roles' existing privileges stay in effect.
grant select, insert, update, delete on table public.shot_clips to service_role;
grant select, insert, update on table public.reference_clips, public.reference_templates, public.coach_usage to service_role;
grant select, insert, update, delete on table public.reference_shots to service_role;
grant execute on function public.coach_consume(uuid, date, integer) to service_role;
grant execute on function public.coach_record_usage(uuid, date, bigint, bigint, bigint, bigint) to service_role;
