-- Bound the reverse reachability calculation to services that run on this date
-- and to the timetable search horizon. The previous recursive CTE traversed every
-- connection in the national database for every two-hour query window, which made
-- the first RPC time out before the forward scan could inspect any connections.
create index if not exists rail_connections_to_service_dep_idx
  on public.rail_connections (to_stop_id, service_id, dep_seconds);

drop function if exists public.rail_connections_in_window(
  uuid[], int, int, uuid[], numeric, numeric, numeric, numeric, numeric, uuid[]
);

create function public.rail_connections_in_window(
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
    where c2.service_id = any(p_service_ids)
      and c2.dep_seconds >= p_dep_from
      and c2.dep_seconds < 108000
  )
  select c.trip_id, c.service_id, c.from_stop_id, c.to_stop_id, c.dep_seconds, c.arr_seconds
  from public.rail_connections c
  left join public.rail_stops s on s.id = c.to_stop_id
  where c.service_id = any(p_service_ids)
    and c.dep_seconds >= p_dep_from and c.dep_seconds < p_dep_to
    and (p_from_stop_ids is null or c.from_stop_id = any(p_from_stop_ids))
    and (
      p_origin_lat is null or s.lat is null or s.lon is null
      or (
        sqrt(power((s.lat - p_origin_lat) * 111.0, 2) + power((s.lon - p_origin_lon) * 111.0 * cos(radians((s.lat + p_origin_lat) / 2)), 2))
        + sqrt(power((s.lat - p_dest_lat) * 111.0, 2) + power((s.lon - p_dest_lon) * 111.0 * cos(radians((s.lat + p_dest_lat) / 2)), 2))
      ) <= p_max_detour_km
    )
    and (p_dest_stop_ids is null or c.to_stop_id in (select stop_id from backward))
  order by c.dep_seconds asc
  limit 10000;
$$ language sql stable;

grant execute on function public.rail_connections_in_window(
  uuid[], int, int, uuid[], numeric, numeric, numeric, numeric, numeric, uuid[]
) to authenticated, anon;
