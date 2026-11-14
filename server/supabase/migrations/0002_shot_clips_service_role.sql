-- Supabase projects may omit the implicit Data API grants for new tables.
-- The Vercel API reads and writes clips with service_role, so grant its four
-- required operations explicitly. This does not change client access or RLS.
grant select, insert, update, delete on table public.shot_clips to service_role;
