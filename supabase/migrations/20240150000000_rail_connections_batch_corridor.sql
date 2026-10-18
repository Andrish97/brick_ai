-- Return the bounded destination-reachable graph for one time window. The client
-- scans it from the origin in one pass; repeated frontier RPCs were consuming the
-- Edge Function resource budget.
create or replace function public.rail_connections_in_window(
  p_service_ids uuid[], p_dep_from int, p_dep_to int, p_from_stop_ids uuid[] default null,
  p_origin_lat numeric default null, p_origin_lon numeric default null,
  p_dest_lat numeric default null, p_dest_lon numeric default null,
  p_max_detour_km numeric default null,
  p_dest_stop_ids uuid[] default null
) returns table (
  trip_id uuid, service_id uuid, from_stop_id uuid, to_stop_id uuid, dep_seconds int, arr_seconds int
) as $$
  with recursive backward(stop_id) as (
    select unnest(p_dest_stop_ids)
    where p_dest_stop_ids is not null
    union
    select c2.from_stop_id
    from public.rail_connections c2
    join backward b on c2.to_stop_id = b.stop_id
    left join public.rail_stops s2 on s2.id = c2.from_stop_id
    where c2.service_id = any(p_service_ids)
      and c2.dep_seconds >= p_dep_from
      and c2.dep_seconds < 108000
      and (
        p_origin_lat is null or p_origin_lon is null or p_dest_lat is null or p_dest_lon is null
        or p_max_detour_km is null or s2.lat is null or s2.lon is null
        or (
          sqrt(power((s2.lat - p_origin_lat) * 111.0, 2) + power((s2.lon - p_origin_lon) * 111.0 * cos(radians((s2.lat + p_origin_lat) / 2)), 2))
          + sqrt(power((s2.lat - p_dest_lat) * 111.0, 2) + power((s2.lon - p_dest_lon) * 111.0 * cos(radians((s2.lat + p_dest_lat) / 2)), 2))
        ) <= p_max_detour_km
      )
  )
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
    and (p_dest_stop_ids is null or c.from_stop_id in (select stop_id from backward))
  order by c.dep_seconds asc
  limit 10000;
$$ language sql stable;
