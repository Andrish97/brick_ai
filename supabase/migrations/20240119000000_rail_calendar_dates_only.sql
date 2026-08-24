-- Realny sync (polish_trains.zip z mkuran.pl) ujawnił, że ten konkretny feed nie ma
-- w ogóle calendar.txt — cały kalendarz jest wyrażony przez calendar_dates.txt (dozwolone
-- przez spec GTFS: calendar.txt jest opcjonalny, jeśli calendar_dates.txt pokrywa
-- wszystkie dni). rail-gtfs-sync/index.ts już toleruje brak pliku (traktuje jako pusty),
-- ale rail_gtfs_transform() zakładał, że KAŻDY service_id ma wiersz w rail_calendar —
-- bez tego insert do rail_calendar_dates (i pośrednio rail_trips) nie miał czego dołączyć.
--
-- Poprawka: po wstawieniu prawdziwych wierszy z calendar.txt (jeśli był), dosyntetyzuj
-- brakujące rail_calendar dla service_id znanych WYŁĄCZNIE z calendar_dates.txt — z
-- wszystkimi dniami tygodnia = false (nigdy nie aktywny "z automatu"), tak żeby jedyną
-- drogą aktywacji był wyjątek exception_type=1 w calendar_dates — dokładnie ta sama
-- logika już działa poprawnie w activeServiceIds() w csa.ts (baza + nakładka wyjątków),
-- brakowało tylko samego wiersza rail_calendar żeby FK się zgadzały.
create or replace function public.rail_gtfs_transform(run_id uuid) returns void as $$
begin
  insert into public.rail_stops (gtfs_stop_id, name, lat, lon, sync_run_id)
  select stop_id, name, nullif(lat, '')::numeric, nullif(lon, '')::numeric, run_id
  from public.rail_raw_stops
  where stop_id is not null and stop_id <> ''
  on conflict (gtfs_stop_id) do update set
    name = excluded.name, lat = excluded.lat, lon = excluded.lon,
    sync_run_id = excluded.sync_run_id, updated_at = now();

  insert into public.rail_routes (gtfs_route_id, short_name, long_name, route_type, sync_run_id)
  select route_id, short_name, long_name, nullif(route_type, '')::smallint, run_id
  from public.rail_raw_routes
  where route_id is not null and route_id <> ''
  on conflict (gtfs_route_id) do update set
    short_name = excluded.short_name, long_name = excluded.long_name,
    route_type = excluded.route_type, sync_run_id = excluded.sync_run_id;

  insert into public.rail_calendar (
    gtfs_service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
    start_date, end_date, sync_run_id
  )
  select
    service_id, monday = '1', tuesday = '1', wednesday = '1', thursday = '1',
    friday = '1', saturday = '1', sunday = '1',
    to_date(start_date, 'YYYYMMDD'), to_date(end_date, 'YYYYMMDD'), run_id
  from public.rail_raw_calendar
  where service_id is not null and service_id <> ''
  on conflict (gtfs_service_id) do update set
    monday = excluded.monday, tuesday = excluded.tuesday, wednesday = excluded.wednesday,
    thursday = excluded.thursday, friday = excluded.friday, saturday = excluded.saturday,
    sunday = excluded.sunday, start_date = excluded.start_date, end_date = excluded.end_date,
    sync_run_id = excluded.sync_run_id;

  -- Dosyntetyzuj rail_calendar dla service_id, których w ogóle nie było w calendar.txt
  -- (albo pliku nie było wcale) — aktywne WYŁĄCZNIE przez wyjątki w calendar_dates.
  insert into public.rail_calendar (
    gtfs_service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
    start_date, end_date, sync_run_id
  )
  select distinct r.service_id, false, false, false, false, false, false, false,
    date '2020-01-01', date '2035-12-31', run_id
  from public.rail_raw_calendar_dates r
  where r.service_id is not null and r.service_id <> ''
    and not exists (select 1 from public.rail_calendar c where c.gtfs_service_id = r.service_id)
  on conflict (gtfs_service_id) do nothing;

  insert into public.rail_calendar_dates (service_id, date, exception_type, sync_run_id)
  select c.id, to_date(r.date, 'YYYYMMDD'), r.exception_type::smallint, run_id
  from public.rail_raw_calendar_dates r
  join public.rail_calendar c on c.gtfs_service_id = r.service_id
  where r.service_id is not null and r.service_id <> '';

  insert into public.rail_trips (gtfs_trip_id, route_id, service_id, short_name, headsign, sync_run_id)
  select t.trip_id, ro.id, c.id, t.short_name, t.headsign, run_id
  from public.rail_raw_trips t
  join public.rail_routes ro on ro.gtfs_route_id = t.route_id
  join public.rail_calendar c on c.gtfs_service_id = t.service_id
  where t.trip_id is not null and t.trip_id <> ''
  on conflict (gtfs_trip_id) do update set
    route_id = excluded.route_id, service_id = excluded.service_id,
    short_name = excluded.short_name, headsign = excluded.headsign,
    sync_run_id = excluded.sync_run_id;

  insert into public.rail_stop_times (trip_id, stop_id, stop_sequence, arrival_seconds, departure_seconds, sync_run_id)
  select
    tr.id, s.id, st.stop_sequence::int,
    split_part(st.arrival_time, ':', 1)::int * 3600 + split_part(st.arrival_time, ':', 2)::int * 60 + split_part(st.arrival_time, ':', 3)::int,
    split_part(st.departure_time, ':', 1)::int * 3600 + split_part(st.departure_time, ':', 2)::int * 60 + split_part(st.departure_time, ':', 3)::int,
    run_id
  from public.rail_raw_stop_times st
  join public.rail_trips tr on tr.gtfs_trip_id = st.trip_id
  join public.rail_stops s on s.gtfs_stop_id = st.stop_id
  where st.trip_id is not null and st.trip_id <> '';

  insert into public.rail_connections (trip_id, service_id, from_stop_id, to_stop_id, dep_seconds, arr_seconds, sync_run_id)
  select
    a.trip_id, tr.service_id, a.stop_id, b.stop_id, a.departure_seconds, b.arrival_seconds, run_id
  from public.rail_stop_times a
  join public.rail_stop_times b on b.trip_id = a.trip_id and b.stop_sequence = (
    select min(stop_sequence) from public.rail_stop_times where trip_id = a.trip_id and stop_sequence > a.stop_sequence
  )
  join public.rail_trips tr on tr.id = a.trip_id
  where a.sync_run_id = run_id;

  delete from public.rail_connections where sync_run_id <> run_id;
  delete from public.rail_stop_times where sync_run_id <> run_id;
  delete from public.rail_trips where sync_run_id <> run_id;
  delete from public.rail_calendar_dates where sync_run_id <> run_id;
  delete from public.rail_calendar where sync_run_id <> run_id;
  delete from public.rail_routes where sync_run_id <> run_id;
  delete from public.rail_stops where sync_run_id <> run_id;

  truncate public.rail_raw_stops, public.rail_raw_routes, public.rail_raw_calendar,
    public.rail_raw_calendar_dates, public.rail_raw_trips, public.rail_raw_stop_times;
end;
$$ language plpgsql;
