-- Return a single JSON value to PostgREST so its max-rows setting does not split
-- each local time window into many RPCs. The candidate trip frontier keeps this
-- payload bounded to trains boardable from stations already reached by the CSA scan.
create or replace function public.rail_connections_in_window_compact(
  p_service_ids uuid[], p_dep_from int, p_dep_to int, p_from_stop_ids uuid[] default null,
  p_origin_lat numeric default null, p_origin_lon numeric default null,
  p_dest_lat numeric default null, p_dest_lon numeric default null,
  p_max_detour_km numeric default null
) returns jsonb as $$
  with candidate_trips as (
    select distinct frontier.trip_id
    from public.rail_connections frontier
    where frontier.service_id = any(p_service_ids)
      and frontier.dep_seconds >= p_dep_from and frontier.dep_seconds < p_dep_to
      and (p_from_stop_ids is null or frontier.from_stop_id = any(p_from_stop_ids))
  ), window_connections as (
    select c.trip_id, c.service_id, c.from_stop_id, c.to_stop_id, c.dep_seconds, c.arr_seconds
    from public.rail_connections c
    left join public.rail_stops s on s.id = c.to_stop_id
    where c.service_id = any(p_service_ids)
      and c.dep_seconds >= p_dep_from and c.dep_seconds < p_dep_to
      and (p_from_stop_ids is null or c.trip_id in (select trip_id from candidate_trips))
      and (
        p_origin_lat is null or p_origin_lon is null or p_dest_lat is null or p_dest_lon is null
        or p_max_detour_km is null or s.lat is null or s.lon is null
        or (
          sqrt(power((s.lat - p_origin_lat) * 111.0, 2) + power((s.lon - p_origin_lon) * 111.0 * cos(radians((s.lat + p_origin_lat) / 2)), 2))
          + sqrt(power((s.lat - p_dest_lat) * 111.0, 2) + power((s.lon - p_dest_lon) * 111.0 * cos(radians((s.lat + p_dest_lat) / 2)), 2))
        ) <= p_max_detour_km
      )
    order by c.dep_seconds asc
    limit 10000
  )
  select coalesce(jsonb_agg(to_jsonb(window_connections) order by dep_seconds), '[]'::jsonb)
  from window_connections;
$$ language sql stable;

grant execute on function public.rail_connections_in_window_compact(
  uuid[], int, int, uuid[], numeric, numeric, numeric, numeric, numeric
) to authenticated, anon;
