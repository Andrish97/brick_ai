-- Restore the trip_id index dropped in 20240157000000. It is still required:
-- * rail_connections.trip_id has a foreign key to rail_trips(id), so every row
--   deleted from rail_trips during publish cleanup checks rail_connections by
--   trip_id. Without this index each check is a full table scan, which made
--   rail_gtfs_publish_atomic hit statement_timeout on every run since 2026-10-25;
-- * rail_gtfs_transform_connections_batch deletes connections by trip_id.
-- to_stop_id stays covered by rail_connections_to_service_dep_idx.
create index if not exists rail_connections_trip_id_idx
  on public.rail_connections (trip_id);
