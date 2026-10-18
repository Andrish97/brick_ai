-- The destination-wide recursive reverse search still timed out on production even
-- after limiting it to active services and the travel horizon. Forward CSA already
-- carries the set of reachable departure stations, so bound returned legs by an
-- origin-destination geographic corridor instead of recursively traversing the graph.
drop index if exists public.rail_connections_to_service_dep_idx;
drop function if exists public.rail_connections_in_window(
  uuid[], int, int, uuid[], numeric, numeric, numeric, numeric, numeric, uuid[]
);
drop function if exists public.rail_connections_in_window(
  uuid[], int, int, uuid[], numeric, numeric, numeric, numeric, numeric
);

create function public.rail_connections_in_window(
  p_service_ids uuid[], p_dep_from int, p_dep_to int, p_from_stop_ids uuid[] default null,
  p_origin_lat numeric default null, p_origin_lon numeric default null,
  p_dest_lat numeric default null, p_dest_lon numeric default null,
  p_max_detour_km numeric default null
) returns table (
  trip_id uuid, service_id uuid, from_stop_id uuid, to_stop_id uuid, dep_seconds int, arr_seconds int
) as $$
  select c.trip_id, c.service_id, c.from_stop_id, c.to_stop_id, c.dep_seconds, c.arr_seconds
  from public.rail_connections c
  left join public.rail_stops s on s.id = c.to_stop_id
  where c.service_id = any(p_service_ids)
    and c.dep_seconds >= p_dep_from and c.dep_seconds < p_dep_to
    and (p_from_stop_ids is null or c.from_stop_id = any(p_from_stop_ids))
    and (
      p_origin_lat is null or p_origin_lon is null or p_dest_lat is null or p_dest_lon is null
      or p_max_detour_km is null or s.lat is null or s.lon is null
      or (
        sqrt(power((s.lat - p_origin_lat) * 111.0, 2) + power((s.lon - p_origin_lon) * 111.0 * cos(radians((s.lat + p_origin_lat) / 2)), 2))
        + sqrt(power((s.lat - p_dest_lat) * 111.0, 2) + power((s.lon - p_dest_lon) * 111.0 * cos(radians((s.lat + p_dest_lat) / 2)), 2))
      ) <= p_max_detour_km
    )
  order by c.dep_seconds asc
  limit 10000;
$$ language sql stable;

grant execute on function public.rail_connections_in_window(
  uuid[], int, int, uuid[], numeric, numeric, numeric, numeric, numeric
) to authenticated, anon;
