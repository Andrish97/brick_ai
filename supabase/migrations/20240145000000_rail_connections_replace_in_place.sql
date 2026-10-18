-- Avoid storing old and new connection rows side by side during the import. Replace
-- each train's rows in a single transaction, keeping database use within the Free cap.
create index if not exists rail_connections_trip_id_idx
  on public.rail_connections (trip_id);

create or replace function public.rail_gtfs_transform_connections_batch(
  run_id uuid,
  after_trip text
) returns table(next_trip text, done boolean) as $$
declare
  batch_trip_ids text[];
  batch_count integer;
  batch_limit constant integer := 100;
begin
  select array_agg(batch.trip_id order by batch.trip_id), count(*)::integer
    into batch_trip_ids, batch_count
  from (
    select distinct raw.trip_id
    from public.rail_raw_stop_times raw
    where raw.trip_id is not null
      and raw.trip_id <> ''
      and (after_trip is null or raw.trip_id > after_trip)
    order by raw.trip_id
    limit batch_limit
  ) batch;

  if coalesce(batch_count, 0) = 0 then
    return query select after_trip, true;
    return;
  end if;

  -- Keep only one timetable's connections for these trips, even when retrying after a
  -- previously failed import. trip_id is indexed so deletion stays bounded per batch.
  delete from public.rail_connections connections
  using public.rail_trips trips
  where connections.trip_id = trips.id
    and trips.gtfs_trip_id = any(batch_trip_ids);

  insert into public.rail_connections (
    trip_id, service_id, from_stop_id, to_stop_id, dep_seconds, arr_seconds, sync_run_id
  )
  select
    trips.id, trips.service_id, from_stop.id, to_stop.id,
    split_part(legs.departure_time, ':', 1)::int * 3600
      + split_part(legs.departure_time, ':', 2)::int * 60
      + split_part(legs.departure_time, ':', 3)::int,
    split_part(legs.next_arrival_time, ':', 1)::int * 3600
      + split_part(legs.next_arrival_time, ':', 2)::int * 60
      + split_part(legs.next_arrival_time, ':', 3)::int,
    run_id
  from (
    select
      raw.trip_id,
      raw.stop_id,
      lead(raw.stop_id) over w as next_stop_id,
      raw.departure_time,
      lead(raw.arrival_time) over w as next_arrival_time
    from public.rail_raw_stop_times raw
    where raw.trip_id = any(batch_trip_ids)
    window w as (partition by raw.trip_id order by raw.stop_sequence::integer)
  ) legs
  join public.rail_trips trips on trips.gtfs_trip_id = legs.trip_id
  join public.rail_stops from_stop on from_stop.gtfs_stop_id = legs.stop_id
  join public.rail_stops to_stop on to_stop.gtfs_stop_id = legs.next_stop_id
  where legs.next_stop_id is not null;

  next_trip := batch_trip_ids[array_length(batch_trip_ids, 1)];
  done := batch_count < batch_limit;

  update public.rail_sync_runs
  set transform_cursor = next_trip, consecutive_errors = 0
  where id = run_id;

  return next;
end;
$$ language plpgsql;
