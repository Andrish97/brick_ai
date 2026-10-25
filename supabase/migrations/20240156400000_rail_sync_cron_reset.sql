-- Remove the capped daily driver and any earlier competing tick jobs.
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
