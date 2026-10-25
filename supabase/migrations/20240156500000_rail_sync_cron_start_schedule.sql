-- Check for feed updates and retry failed runs every six hours.
select cron.schedule(
  'rail-gtfs-sync-start-periodic',
  '0 */6 * * *',
  $$select public.rail_gtfs_enqueue_sync_action('start');$$
);
