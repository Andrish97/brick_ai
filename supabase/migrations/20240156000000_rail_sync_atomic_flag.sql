-- Only successful transactional publications are trusted by the search planner.
alter table public.rail_sync_runs add column if not exists atomic_published boolean not null default false;
