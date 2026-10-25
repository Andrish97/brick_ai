-- Keep GTFS ingestion resumable across cron invocations, then publish the new
-- derived timetable in one database transaction. The old active timetable remains
-- visible until every transform and cleanup statement commits together.

alter table public.rail_sync_runs
  add column if not exists atomic_published boolean not null default false;

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

-- The old driver tried to complete a full import in at most 60 HTTP ticks. A
-- connections batch contains only 100 trips, so a national timetable needs far
-- more than 60 calls. Restarting every day discarded the raw staging state.
-- Retry start every six hours and resume exactly one tick every two minutes.
create or replace function public.rail_gtfs_enqueue_sync_action(p_action text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  if p_action not in ('start', 'tick') then
    raise exception 'unsupported rail sync action';
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'internal_secret';
  if v_secret is null then
    raise exception 'internal_secret_missing';
  end if;

  v_request_id := net.http_post(
    url := 'https://rjnqpenbjyeiygedjvzk.supabase.co/functions/v1/rail-gtfs-sync',
    body := jsonb_build_object('action', p_action),
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    timeout_milliseconds := 60000
  );
  return v_request_id;
end;
$$;
revoke all on function public.rail_gtfs_enqueue_sync_action(text) from public, anon, authenticated;

do $$
declare
  job record;
begin
  for job in
    select jobid from cron.job
    where jobname in (
      'rail-gtfs-sync-start-daily', 'rail-gtfs-sync-tick',
      'rail-gtfs-sync-tick-driver', 'rail-gtfs-sync-daily'
    )
  loop
    perform cron.unschedule(job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'rail-gtfs-sync-start-periodic',
  '0 */6 * * *',
  $$select public.rail_gtfs_enqueue_sync_action('start');$$
);

select cron.schedule(
  'rail-gtfs-sync-tick',
  '*/2 * * * *',
  $$select public.rail_gtfs_enqueue_sync_action('tick');$$
);
