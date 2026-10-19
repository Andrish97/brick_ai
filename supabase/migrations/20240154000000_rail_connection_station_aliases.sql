-- Different GTFS sources may publish separate stop IDs for the same physical
-- station. Expand the current frontier using matching station names and nearby
-- coordinates, and return station metadata so the CSA scan can merge those IDs.
create or replace function public.rail_connections_in_window_compact(
  p_service_ids uuid[], p_dep_from int, p_dep_to int, p_from_stop_ids uuid[] default null,
  p_origin_lat numeric default null, p_origin_lon numeric default null,
  p_dest_lat numeric default null, p_dest_lon numeric default null,
  p_max_detour_km numeric default null
) returns jsonb as $$
  with frontier_stops as (
    select s.name, s.lat, s.lon
    from public.rail_stops s
    where p_from_stop_ids is not null and s.id = any(p_from_stop_ids)
      and s.name is not null and s.lat is not null and s.lon is not null
  ), frontier_aliases as (
    select distinct alias.id
    from public.rail_stops alias
    join frontier_stops reached on lower(alias.name) = lower(reached.name)
    where alias.lat is not null and alias.lon is not null
      and sqrt(
        power((alias.lat - reached.lat) * 111.0, 2)
        + power((alias.lon - reached.lon) * 111.0 * cos(radians((alias.lat + reached.lat) / 2)), 2)
      ) <= 0.25
  ), candidate_trips as (
    select distinct frontier.trip_id
    from public.rail_connections frontier
    where frontier.service_id = any(p_service_ids)
      and frontier.dep_seconds >= p_dep_from and frontier.dep_seconds < p_dep_to
      and (
        p_from_stop_ids is null
        or frontier.from_stop_id = any(p_from_stop_ids)
        or frontier.from_stop_id in (select id from frontier_aliases)
      )
  ), window_connections as (
    select c.trip_id, c.service_id, c.from_stop_id, c.to_stop_id, c.dep_seconds, c.arr_seconds,
      f.name as from_station_name, f.lat as from_lat, f.lon as from_lon,
      t.name as to_station_name, t.lat as to_lat, t.lon as to_lon
    from public.rail_connections c
    join public.rail_stops f on f.id = c.from_stop_id
    join public.rail_stops t on t.id = c.to_stop_id
    where c.service_id = any(p_service_ids)
      and c.dep_seconds >= p_dep_from and c.dep_seconds < p_dep_to
      and (p_from_stop_ids is null or c.trip_id in (select trip_id from candidate_trips))
      and (
        p_origin_lat is null or p_origin_lon is null or p_dest_lat is null or p_dest_lon is null
        or p_max_detour_km is null or t.lat is null or t.lon is null
        or (
          sqrt(power((t.lat - p_origin_lat) * 111.0, 2) + power((t.lon - p_origin_lon) * 111.0 * cos(radians((t.lat + p_origin_lat) / 2)), 2))
          + sqrt(power((t.lat - p_dest_lat) * 111.0, 2) + power((t.lon - p_dest_lon) * 111.0 * cos(radians((t.lat + p_dest_lat) / 2)), 2))
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
