-- Increase the resumable tick rate. Worker lock skips a scheduled request if a
-- previous bounded tick is still running, so this cannot create parallel imports.
do $do$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'rail-gtfs-sync-tick';
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
  perform cron.schedule(
    'rail-gtfs-sync-tick',
    '* * * * *',
    $$select public.rail_gtfs_enqueue_sync_action('tick');$$
  );
end;
$do$;
