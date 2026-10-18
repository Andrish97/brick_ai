-- rail_stop_times is only an intermediate table used to build rail_connections.
-- Runtime journey search reads rail_connections, calendar, trips and stops; it never
-- reads rail_stop_times. Keep stop_times during transformation, then release its
-- hundreds of MB after the new connections have been created.
create or replace function public.rail_gtfs_transform_cleanup(run_id uuid) returns void as $$
begin
  delete from public.rail_connections where sync_run_id <> run_id;
  delete from public.rail_stop_times where sync_run_id <> run_id;
  delete from public.rail_trips where sync_run_id <> run_id;
  delete from public.rail_calendar_dates where sync_run_id <> run_id;
  delete from public.rail_calendar where sync_run_id <> run_id;
  delete from public.rail_routes where sync_run_id <> run_id;
  delete from public.rail_stops where sync_run_id <> run_id;

  -- Connections now contain all data needed by search. The stop-time rows are
  -- intentionally ephemeral and are rebuilt on the next successful GTFS import.
  truncate public.rail_stop_times;

  truncate public.rail_raw_stops, public.rail_raw_routes, public.rail_raw_calendar,
    public.rail_raw_calendar_dates, public.rail_raw_trips, public.rail_raw_stop_times;
end;
$$ language plpgsql;
