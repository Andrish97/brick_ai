-- Disable the local GTFS timetable import and free its storage.
-- The SMS assistant no longer offers the local multi-transfer train planner
-- (plan_train_journey); station boards, train status and disruptions use the
-- live PKP API and journeys use Google, so none of them need these tables.
-- Tables and functions stay (empty) so the schema and admin panel keep working;
-- re-enabling means re-scheduling the cron jobs and running a fresh sync.
do $$
declare
  v_job record;
begin
  for v_job in select jobid from cron.job where jobname like 'rail-gtfs-sync%' loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

truncate table
  public.rail_sync_blobs,
  public.rail_connections,
  public.rail_stop_times,
  public.rail_trips,
  public.rail_calendar_dates,
  public.rail_calendar,
  public.rail_routes,
  public.rail_stops,
  public.rail_raw_stops,
  public.rail_raw_routes,
  public.rail_raw_calendar,
  public.rail_raw_calendar_dates,
  public.rail_raw_trips,
  public.rail_raw_stop_times,
  public.rail_sync_runs;

update public.rail_sync_worker_lock set locked_until = null;

-- Old sync log rows are no longer useful either.
delete from public.logs where type in ('rail_sync', 'rail_local_entry', 'rail_local_skip', 'rail_local_station_resolved');
