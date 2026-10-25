-- Resume one persisted ingest step every two minutes.
select cron.schedule(
  'rail-gtfs-sync-tick',
  '*/2 * * * *',
  $$select public.rail_gtfs_enqueue_sync_action('tick');$$
);
