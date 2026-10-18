-- A service that exists only in calendar_dates can already have a calendar row
-- from an earlier import. Mark that row as belonging to this run so cleanup does
-- not remove a parent that is referenced by this run's exception dates.
create or replace function public.rail_gtfs_transform_calendar(run_id uuid) returns void as $$
begin
  insert into public.rail_calendar (
    gtfs_service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
    start_date, end_date, sync_run_id
  )
  select
    service_id, monday = '1', tuesday = '1', wednesday = '1', thursday = '1',
    friday = '1', saturday = '1', sunday = '1',
    to_date(start_date, 'YYYYMMDD'), to_date(end_date, 'YYYYMMDD'), run_id
  from public.rail_raw_calendar
  where service_id is not null and service_id <> ''
  on conflict (gtfs_service_id) do update set
    monday = excluded.monday, tuesday = excluded.tuesday, wednesday = excluded.wednesday,
    thursday = excluded.thursday, friday = excluded.friday, saturday = excluded.saturday,
    sunday = excluded.sunday, start_date = excluded.start_date, end_date = excluded.end_date,
    sync_run_id = excluded.sync_run_id;

  -- Calendar-dates-only services may already have a parent from a previous sync.
  -- Update it in place instead of leaving it marked stale for cleanup.
  insert into public.rail_calendar (
    gtfs_service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
    start_date, end_date, sync_run_id
  )
  select distinct r.service_id, false, false, false, false, false, false, false,
    date '2020-01-01', date '2035-12-31', run_id
  from public.rail_raw_calendar_dates r
  where r.service_id is not null and r.service_id <> ''
    and not exists (
      select 1 from public.rail_raw_calendar c where c.service_id = r.service_id
    )
  on conflict (gtfs_service_id) do update set
    monday = excluded.monday, tuesday = excluded.tuesday, wednesday = excluded.wednesday,
    thursday = excluded.thursday, friday = excluded.friday, saturday = excluded.saturday,
    sunday = excluded.sunday, start_date = excluded.start_date, end_date = excluded.end_date,
    sync_run_id = excluded.sync_run_id;
end;
$$ language plpgsql;

create or replace function public.rail_gtfs_transform_cleanup(run_id uuid) returns void as $$
begin
  -- Delete all exception rows that reference calendars about to be removed,
  -- including stale exceptions whose own sync_run_id is unexpectedly current.
  delete from public.rail_calendar_dates dates
  using public.rail_calendar calendar
  where dates.service_id = calendar.id
    and calendar.sync_run_id <> run_id;

  delete from public.rail_connections where sync_run_id <> run_id;
  delete from public.rail_stop_times where sync_run_id <> run_id;
  delete from public.rail_trips where sync_run_id <> run_id;
  delete from public.rail_calendar_dates where sync_run_id <> run_id;
  delete from public.rail_calendar where sync_run_id <> run_id;
  delete from public.rail_routes where sync_run_id <> run_id;
  delete from public.rail_stops where sync_run_id <> run_id;

  truncate public.rail_stop_times;
  truncate public.rail_raw_stops, public.rail_raw_routes, public.rail_raw_calendar,
    public.rail_raw_calendar_dates, public.rail_raw_trips, public.rail_raw_stop_times;
end;
$$ language plpgsql;
