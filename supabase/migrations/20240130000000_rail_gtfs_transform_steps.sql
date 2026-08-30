-- Realny dowód z produkcji: nawet PO fixie rail_connections (poprzednia migracja,
-- zweryfikowana lokalnie na ~48s przy realnej skali) i PO jawnym wydłużeniu
-- statement_timeout na połączeniu do 5 minut, ten sam błąd ("canceling statement due to
-- statement timeout") wystąpił znowu, tym razem po ~295s — bardzo blisko nowego limitu.
-- Wniosek: prawdziwa baza produkcyjna (wolniejsza niż lokalne środowisko testowe) po
-- prostu NIE MIEŚCI całej transformacji (7 insertów + mark-and-sweep + truncate na
-- ~600k wierszach) w jednym wywołaniu, niezależnie od tego, jak wysoko podkręcimy
-- statement_timeout — a i tak nie ma sensu podkręcać go wyżej niż ~400s, bo to i tak
-- twardy sufit czasu ściany całego wywołania Edge Function.
--
-- Jedyna prawdziwa naprawa: ten sam wzorzec, który już działa dla pobierania, rozpakowania
-- i parsowania — rozbić Etap B na osobne kroki, po jednym na tick, zamiast jednej funkcji
-- robiącej wszystko naraz. rail_gtfs_transform(run_id) zastąpione ośmioma mniejszymi
-- funkcjami, każda z nich osobnym, samodzielnym zapytaniem — sterowanie kolejnością i
-- postępem (rail_sync_runs.transform_step) po stronie Edge Function (zob. index.ts).
drop function if exists public.rail_gtfs_transform(uuid);

create or replace function public.rail_gtfs_transform_stops(run_id uuid) returns void as $$
begin
  insert into public.rail_stops (gtfs_stop_id, name, lat, lon, sync_run_id)
  select stop_id, name, nullif(lat, '')::numeric, nullif(lon, '')::numeric, run_id
  from public.rail_raw_stops
  where stop_id is not null and stop_id <> ''
  on conflict (gtfs_stop_id) do update set
    name = excluded.name, lat = excluded.lat, lon = excluded.lon,
    sync_run_id = excluded.sync_run_id, updated_at = now();
end;
$$ language plpgsql;

create or replace function public.rail_gtfs_transform_routes(run_id uuid) returns void as $$
begin
  insert into public.rail_routes (gtfs_route_id, short_name, long_name, route_type, sync_run_id)
  select route_id, short_name, long_name, nullif(route_type, '')::smallint, run_id
  from public.rail_raw_routes
  where route_id is not null and route_id <> ''
  on conflict (gtfs_route_id) do update set
    short_name = excluded.short_name, long_name = excluded.long_name,
    route_type = excluded.route_type, sync_run_id = excluded.sync_run_id;
end;
$$ language plpgsql;

create or replace function public.rail_gtfs_transform_calendar(run_id uuid) returns void as $$
begin
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
end;
$$ language plpgsql;

create or replace function public.rail_gtfs_transform_calendar_dates(run_id uuid) returns void as $$
begin
  insert into public.rail_calendar_dates (service_id, date, exception_type, sync_run_id)
  select c.id, to_date(r.date, 'YYYYMMDD'), r.exception_type::smallint, run_id
  from public.rail_raw_calendar_dates r
  join public.rail_calendar c on c.gtfs_service_id = r.service_id
  where r.service_id is not null and r.service_id <> '';
end;
$$ language plpgsql;

create or replace function public.rail_gtfs_transform_trips(run_id uuid) returns void as $$
begin
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
end;
$$ language plpgsql;

create or replace function public.rail_gtfs_transform_stop_times(run_id uuid) returns void as $$
begin
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
end;
$$ language plpgsql;

create or replace function public.rail_gtfs_transform_connections(run_id uuid) returns void as $$
begin
  -- lead() zamiast self-joina + skorelowanego podzapytania (zob. migracja 20240129) —
  -- jedno przejście, partycjonowane po trip_id, posortowane po stop_sequence.
  insert into public.rail_connections (trip_id, service_id, from_stop_id, to_stop_id, dep_seconds, arr_seconds, sync_run_id)
  select trip_id, service_id, stop_id, next_stop_id, departure_seconds, next_arrival_seconds, run_id
  from (
    select
      a.trip_id, tr.service_id, a.stop_id,
      lead(a.stop_id) over w as next_stop_id,
      a.departure_seconds,
      lead(a.arrival_seconds) over w as next_arrival_seconds
    from public.rail_stop_times a
    join public.rail_trips tr on tr.id = a.trip_id
    where a.sync_run_id = run_id
    window w as (partition by a.trip_id order by a.stop_sequence)
  ) legs
  where next_stop_id is not null;
end;
$$ language plpgsql;

create or replace function public.rail_gtfs_transform_cleanup(run_id uuid) returns void as $$
begin
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

alter table public.rail_sync_runs
  add column if not exists transform_step text;
