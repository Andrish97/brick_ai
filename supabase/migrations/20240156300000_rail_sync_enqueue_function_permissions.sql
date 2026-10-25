-- Cron runs as the owner; the RPC helper must not be callable by API roles.
revoke all on function public.rail_gtfs_enqueue_sync_action(text) from public, anon, authenticated;
