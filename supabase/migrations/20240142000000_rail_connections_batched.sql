-- Large connection builds repeatedly exceeded the production statement timeout.
-- Process a bounded number of trips per tick and persist the cursor in the same
-- transaction as each inserted batch so retries cannot duplicate connections.
alter table public.rail_sync_runs
  add column if not exists transform_cursor uuid;

create or replace function public.rail_gtfs_transform_connections_batch(
  run_id uuid,
  after_trip uuid
) returns table(next_trip uuid, done boolean) as $$
declare
  batch_trip_ids uuid[];
  batch_count integer;
  batch_limit constant integer := 1000;
begin
  select array_agg(batch.trip_id order by batch.trip_id), count(*)::integer
    into batch_trip_ids, batch_count
  from (
    select distinct st.trip_id
    from public.rail_stop_times st
    where st.sync_run_id = run_id
      and (after_trip is null or st.trip_id > after_trip)
    order by st.trip_id
    limit batch_limit
  ) batch;

  if coalesce(batch_count, 0) = 0 then
    return query select after_trip, true;
    return;
  end if;

  insert into public.rail_connections (
    trip_id, service_id, from_stop_id, to_stop_id, dep_seconds, arr_seconds, sync_run_id
  )
  select trip_id, service_id, stop_id, next_stop_id, departure_seconds, next_arrival_seconds, run_id
  from (
    select
      st.trip_id,
      trip.service_id,
      st.stop_id,
      lead(st.stop_id) over w as next_stop_id,
      st.departure_seconds,
      lead(st.arrival_seconds) over w as next_arrival_seconds
    from public.rail_stop_times st
    join public.rail_trips trip on trip.id = st.trip_id
    where st.sync_run_id = run_id
      and st.trip_id = any(batch_trip_ids)
    window w as (partition by st.trip_id order by st.stop_sequence)
  ) legs
  where next_stop_id is not null;

  next_trip := batch_trip_ids[array_length(batch_trip_ids, 1)];
  done := batch_count < batch_limit;

  update public.rail_sync_runs
  set transform_cursor = next_trip, consecutive_errors = 0
  where id = run_id;

  return next;
end;
$$ language plpgsql;
