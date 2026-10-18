-- A daily HEAD check may confirm that the GTFS feed is unchanged. Track that check
-- separately from finished_at, which records when the timetable was actually imported.
alter table public.rail_sync_runs
  add column if not exists feed_checked_at timestamptz;
