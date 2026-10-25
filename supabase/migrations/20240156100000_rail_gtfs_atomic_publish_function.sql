-- Publish derived GTFS tables, cleanup, success status, and audit event in one transaction.
create or replace function public.rail_gtfs_transform_atomic(p_run_id uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_current_file text;
  v_transform_step text;
  v_cursor text := null;
  v_next_trip text;
  v_done boolean := false;
  v_batches integer := 0;
  v_rows_processed bigint;
begin
  select status, current_file, transform_step
    into v_status, v_current_file, v_transform_step
  from public.rail_sync_runs
  where id = p_run_id
  for update;

  if not found or v_status <> 'running' or v_current_file is not null or v_transform_step is null then
    raise exception 'rail_atomic_publish_invalid_state run=% status=% file=% step=%',
      p_run_id, v_status, v_current_file, v_transform_step;
  end if;

  -- All writes below, including the final status and mark-and-sweep, are part of
  -- this call's implicit transaction. Any exception rolls back the entire publish.
  perform public.rail_gtfs_transform_stops(p_run_id);
  perform public.rail_gtfs_transform_routes(p_run_id);
  perform public.rail_gtfs_transform_calendar(p_run_id);
  perform public.rail_gtfs_transform_calendar_dates(p_run_id);
  perform public.rail_gtfs_transform_trips(p_run_id);

  loop
    select batch.next_trip, batch.done
      into v_next_trip, v_done
    from public.rail_gtfs_transform_connections_batch(p_run_id, v_cursor) as batch;
    v_batches := v_batches + 1;
    exit when coalesce(v_done, false);
    v_cursor := v_next_trip;
  end loop;

  perform public.rail_gtfs_transform_cleanup(p_run_id);

  update public.rail_sync_runs
  set status = 'success', transform_step = null, transform_cursor = null,
      atomic_published = true,
      consecutive_errors = 0, error = null, finished_at = now()
  where id = p_run_id;

  select rows_processed into v_rows_processed
  from public.rail_sync_runs where id = p_run_id;

  insert into public.logs (type, data)
  values ('rail_sync', jsonb_build_object(
    'event', 'finished', 'runId', p_run_id, 'rowsProcessed', v_rows_processed,
    'connectionBatches', v_batches, 'atomic', true
  ));

  return jsonb_build_object('runId', p_run_id, 'connectionBatches', v_batches, 'atomic', true);
end;
$$;
