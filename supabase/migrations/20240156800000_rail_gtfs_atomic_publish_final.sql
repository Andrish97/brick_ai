create or replace function public.rail_gtfs_publish_atomic(p_run_id uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_current_file text;
  v_transform_step text;
  v_rows_processed bigint;
begin
  select status, current_file, transform_step
    into v_status, v_current_file, v_transform_step
  from public.rail_sync_runs
  where id = p_run_id
  for update;

  if not found or v_status <> 'running' or v_current_file is not null or v_transform_step <> 'publish' then
    raise exception 'rail_atomic_publish_invalid_state run=% status=% file=% step=%',
      p_run_id, v_status, v_current_file, v_transform_step;
  end if;

  -- Built connections are isolated by sync_run_id. Cleanup and changing the
  -- active snapshot happen together, so readers see either complete snapshot.
  perform public.rail_gtfs_transform_cleanup(p_run_id);

  update public.rail_sync_runs set atomic_published = false
  where atomic_published and id <> p_run_id;

  update public.rail_sync_runs
  set status = 'success', transform_step = null, transform_cursor = null,
      atomic_published = true, consecutive_errors = 0, error = null, finished_at = now()
  where id = p_run_id;

  select rows_processed into v_rows_processed
  from public.rail_sync_runs where id = p_run_id;

  insert into public.logs (type, data)
  values ('rail_sync', jsonb_build_object(
    'event', 'finished', 'runId', p_run_id, 'rowsProcessed', v_rows_processed,
    'atomic', true
  ));

  return jsonb_build_object('runId', p_run_id, 'atomic', true);
end;
$$;
