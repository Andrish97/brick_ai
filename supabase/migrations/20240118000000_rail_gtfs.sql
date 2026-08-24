-- Lokalna kopia rozkładu kolejowego (GTFS z https://mkuran.pl/gtfs/polish_trains.zip,
-- ten sam pierwotny źródłowy PKP PLK "Otwarte Dane Kolejowe" co żywe API, tylko
-- wstępnie zagregowany przez community maintainera) — pozwala liczyć trasy
-- z przesiadkami lokalnym algorytmem (CSA) zamiast żywymi zapytaniami ograniczonymi
-- limitem PKP (Basic: 100/h, 1000/dzień). Podzbiór GTFS: tylko pola faktycznie
-- potrzebne CSA i istniejącym formatterom (bez agency/shapes/fares).
--
-- Dwuetapowy sync (rail-gtfs-sync): Etap A (Edge Function) wlewa surowe wiersze CSV
-- do tabel rail_raw_* przez bezpośrednie połączenie Postgres (COPY FROM STDIN) —
-- prawie zero pracy CPU w JS, żeby zmieścić się w limicie 2s na wywołanie Edge
-- Function. Etap B (czysty SQL, bez limitu CPU) transformuje raw -> tabele docelowe
-- i buduje rail_connections. Rail_raw_* mają identyczny kształt kolumn co pliki CSV
-- GTFS (wszystko text) — bez FK, bez walidacji, to tylko przystanek pośredni.

create table if not exists public.rail_sync_runs (
  id                  uuid primary key default gen_random_uuid(),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running' check (status in ('running', 'success', 'failed')),
  current_file        text,                          -- który plik GTFS przetwarza aktualny krok
  current_offset      bigint not null default 0,      -- offset w BAJTACH w obiekcie Storage danego pliku, od którego wznowić
  current_header      jsonb,                          -- nagłówek CSV pliku aktualnie przetwarzanego w kawałkach (stop_times.txt) — parsowany raz, trzymany między "tickami"
  feed_last_modified  timestamptz,                    -- Last-Modified źródłowego zip, do wykrycia braku zmian
  rows_processed      bigint not null default 0,
  error               text
);

alter table public.rail_sync_runs enable row level security;
create policy "auth_rail_sync_runs_all" on public.rail_sync_runs
  for all to authenticated using (true) with check (true);
create index if not exists rail_sync_runs_status_idx on public.rail_sync_runs (status);

-- Zdekompresowane pliki GTFS (czysty tekst CSV) między Etapem A (pobranie+rozpakowanie,
-- jednorazowo w akcji "start") a Etapem B (parsowanie+wstawianie w kawałkach, po jednym
-- w każdym "tick") — Storage zamiast tabeli Postgres, żeby każdy "tick" mógł pobrać tylko
-- potrzebny zakres bajtów (Range request) zamiast całego pliku za każdym razem.
insert into storage.buckets (id, name, public)
values ('rail-gtfs-raw', 'rail-gtfs-raw', false)
on conflict (id) do nothing;

-- --- Tabele surowe (staging) — 1:1 z kolumnami CSV GTFS, wlewane przez COPY FROM STDIN ---

create table if not exists public.rail_raw_stops (
  stop_id  text,
  name     text,
  lat      text,
  lon      text
);

create table if not exists public.rail_raw_routes (
  route_id    text,
  short_name  text,
  long_name   text,
  route_type  text
);

create table if not exists public.rail_raw_calendar (
  service_id  text,
  monday      text,
  tuesday     text,
  wednesday   text,
  thursday    text,
  friday      text,
  saturday    text,
  sunday      text,
  start_date  text,
  end_date    text
);

create table if not exists public.rail_raw_calendar_dates (
  service_id      text,
  date            text,
  exception_type  text
);

create table if not exists public.rail_raw_trips (
  trip_id     text,
  route_id    text,
  service_id  text,
  short_name  text,
  headsign    text
);

create table if not exists public.rail_raw_stop_times (
  trip_id         text,
  stop_id         text,
  stop_sequence   text,
  arrival_time    text,
  departure_time  text
);

-- Wszystkie rail_raw_* mają identyczne, minimalne RLS (tylko authenticated) — to
-- tylko wewnętrzny bufor między Etapem A i B, nikt poza panelem/funkcjami go nie czyta.
alter table public.rail_raw_stops enable row level security;
create policy "auth_rail_raw_stops_all" on public.rail_raw_stops for all to authenticated using (true) with check (true);
alter table public.rail_raw_routes enable row level security;
create policy "auth_rail_raw_routes_all" on public.rail_raw_routes for all to authenticated using (true) with check (true);
alter table public.rail_raw_calendar enable row level security;
create policy "auth_rail_raw_calendar_all" on public.rail_raw_calendar for all to authenticated using (true) with check (true);
alter table public.rail_raw_calendar_dates enable row level security;
create policy "auth_rail_raw_calendar_dates_all" on public.rail_raw_calendar_dates for all to authenticated using (true) with check (true);
alter table public.rail_raw_trips enable row level security;
create policy "auth_rail_raw_trips_all" on public.rail_raw_trips for all to authenticated using (true) with check (true);
alter table public.rail_raw_stop_times enable row level security;
create policy "auth_rail_raw_stop_times_all" on public.rail_raw_stop_times for all to authenticated using (true) with check (true);

-- --- Tabele docelowe (typowane, z FK) — wypełniane Etapem B z rail_raw_* ---

create table if not exists public.rail_stops (
  id            uuid primary key default gen_random_uuid(),
  gtfs_stop_id  text not null unique,
  name          text not null,
  lat           numeric,
  lon           numeric,
  sync_run_id   uuid not null references public.rail_sync_runs(id),
  updated_at    timestamptz not null default now()
);

alter table public.rail_stops enable row level security;
create policy "auth_rail_stops_all" on public.rail_stops for all to authenticated using (true) with check (true);
create index if not exists rail_stops_name_idx on public.rail_stops (lower(name));
create index if not exists rail_stops_sync_run_idx on public.rail_stops (sync_run_id);

create table if not exists public.rail_routes (
  id             uuid primary key default gen_random_uuid(),
  gtfs_route_id  text not null unique,
  short_name     text,
  long_name      text,
  route_type     smallint,
  sync_run_id    uuid not null references public.rail_sync_runs(id)
);

alter table public.rail_routes enable row level security;
create policy "auth_rail_routes_all" on public.rail_routes for all to authenticated using (true) with check (true);
create index if not exists rail_routes_sync_run_idx on public.rail_routes (sync_run_id);

create table if not exists public.rail_calendar (
  id                uuid primary key default gen_random_uuid(),
  gtfs_service_id   text not null unique,
  monday            boolean not null default false,
  tuesday           boolean not null default false,
  wednesday         boolean not null default false,
  thursday          boolean not null default false,
  friday            boolean not null default false,
  saturday          boolean not null default false,
  sunday            boolean not null default false,
  start_date        date not null,
  end_date          date not null,
  sync_run_id       uuid not null references public.rail_sync_runs(id)
);

alter table public.rail_calendar enable row level security;
create policy "auth_rail_calendar_all" on public.rail_calendar for all to authenticated using (true) with check (true);
create index if not exists rail_calendar_sync_run_idx on public.rail_calendar (sync_run_id);

create table if not exists public.rail_calendar_dates (
  id               uuid primary key default gen_random_uuid(),
  service_id       uuid not null references public.rail_calendar(id),
  date             date not null,
  exception_type   smallint not null check (exception_type in (1, 2)), -- 1=dodany, 2=usunięty
  sync_run_id      uuid not null references public.rail_sync_runs(id)
);

alter table public.rail_calendar_dates enable row level security;
create policy "auth_rail_calendar_dates_all" on public.rail_calendar_dates for all to authenticated using (true) with check (true);
create index if not exists rail_calendar_dates_service_date_idx on public.rail_calendar_dates (service_id, date);

create table if not exists public.rail_trips (
  id             uuid primary key default gen_random_uuid(),
  gtfs_trip_id   text not null unique,
  route_id       uuid not null references public.rail_routes(id),
  service_id     uuid not null references public.rail_calendar(id),
  short_name     text,     -- numer/nazwa pociągu — lokalny odpowiednik trainLabel() z live API
  headsign       text,
  sync_run_id    uuid not null references public.rail_sync_runs(id)
);

alter table public.rail_trips enable row level security;
create policy "auth_rail_trips_all" on public.rail_trips for all to authenticated using (true) with check (true);
create index if not exists rail_trips_service_id_idx on public.rail_trips (service_id);
create index if not exists rail_trips_sync_run_idx on public.rail_trips (sync_run_id);

create table if not exists public.rail_stop_times (
  id                 uuid primary key default gen_random_uuid(),
  trip_id            uuid not null references public.rail_trips(id),
  stop_id            uuid not null references public.rail_stops(id),
  stop_sequence      int not null,
  arrival_seconds    int not null,   -- sekundy od północy dnia serwisowego; GTFS dopuszcza >86400 dla przejazdów po północy
  departure_seconds  int not null,
  sync_run_id        uuid not null references public.rail_sync_runs(id)
);

alter table public.rail_stop_times enable row level security;
create policy "auth_rail_stop_times_all" on public.rail_stop_times for all to authenticated using (true) with check (true);
create index if not exists rail_stop_times_trip_seq_idx on public.rail_stop_times (trip_id, stop_sequence);
create index if not exists rail_stop_times_stop_id_idx on public.rail_stop_times (stop_id);

-- Wyprowadzone "połączenia" (jedna krawędź = jeden odcinek trasy między kolejnymi
-- przystankami jednego kursu) dla CSA — budowane CAŁKOWICIE po stronie Postgresa
-- (INSERT...SELECT self-join na rail_stop_times, Etap B), żeby nie liczyć tego w JS
-- i nie obciążać limitu czasu CPU Edge Function.
create table if not exists public.rail_connections (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references public.rail_trips(id),
  service_id     uuid not null references public.rail_calendar(id), -- zdenormalizowane z trip, dla szybkiego filtra po dacie
  from_stop_id   uuid not null references public.rail_stops(id),
  to_stop_id     uuid not null references public.rail_stops(id),
  dep_seconds    int not null,
  arr_seconds    int not null,
  sync_run_id    uuid not null references public.rail_sync_runs(id)
);

alter table public.rail_connections enable row level security;
create policy "auth_rail_connections_all" on public.rail_connections for all to authenticated using (true) with check (true);
create index if not exists rail_connections_dep_idx on public.rail_connections (dep_seconds);
create index if not exists rail_connections_service_idx on public.rail_connections (service_id);
create index if not exists rail_connections_from_idx on public.rail_connections (from_stop_id, dep_seconds);

-- Etap B: cała transformacja raw -> docelowe + budowa rail_connections, jako czysty SQL
-- (bez limitu CPU Edge Function, niezależnie od liczby wierszy). Wywoływana raz przez
-- rail-gtfs-sync po ostatnim kawałku ostatniego pliku (zob. finishRun() w tej funkcji).
-- Dopiero po pełnym sukcesie usuwa wiersze poprzedniego syncu (mark and sweep) —
-- jeśli cokolwiek w tej funkcji zawiedzie (wyjątek), poprzedni komplet danych zostaje
-- nietknięty i nadal obsługuje zapytania.
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

  -- Jedna krawędź = jeden odcinek między KOLEJNYMI (po stop_sequence) przystankami
  -- tego samego kursu — self-join na rail_stop_times świeżo wypełnione wyżej.
  insert into public.rail_connections (trip_id, service_id, from_stop_id, to_stop_id, dep_seconds, arr_seconds, sync_run_id)
  select
    a.trip_id, tr.service_id, a.stop_id, b.stop_id, a.departure_seconds, b.arrival_seconds, run_id
  from public.rail_stop_times a
  join public.rail_stop_times b on b.trip_id = a.trip_id and b.stop_sequence = (
    select min(stop_sequence) from public.rail_stop_times where trip_id = a.trip_id and stop_sequence > a.stop_sequence
  )
  join public.rail_trips tr on tr.id = a.trip_id
  where a.sync_run_id = run_id;

  -- Mark and sweep: dopiero teraz, po pełnym sukcesie powyżej, usuń wiersze poprzednich
  -- synców (child -> parent po FK).
  delete from public.rail_connections where sync_run_id <> run_id;
  delete from public.rail_stop_times where sync_run_id <> run_id;
  delete from public.rail_trips where sync_run_id <> run_id;
  delete from public.rail_calendar_dates where sync_run_id <> run_id;
  delete from public.rail_calendar where sync_run_id <> run_id;
  delete from public.rail_routes where sync_run_id <> run_id;
  delete from public.rail_stops where sync_run_id <> run_id;

  -- Tabele raw to tylko przystanek pośredni dla TEGO syncu — czyścimy przed startem
  -- następnego (zob. handleStart w rail-gtfs-sync), tutaj też na wszelki wypadek.
  truncate public.rail_raw_stops, public.rail_raw_routes, public.rail_raw_calendar,
    public.rail_raw_calendar_dates, public.rail_raw_trips, public.rail_raw_stop_times;
end;
$$ language plpgsql;

-- Cron w Supabase (nie GitHub Actions — Actions w tym repo jest wyłącznie do deployu),
-- ten sam wzorzec net.http_post + sekret z Vault co 20240117000000_balance_monitoring.sql.
-- Rozszerzenia pg_cron/pg_net już włączone tamtą migracją.
--
-- Sekret INTERNAL_SECRET już istnieje w Vault (dodany ręcznie przy poprzedniej migracji) —
-- ten sam sekret autoryzuje wszystkie wewnętrzne, niepubliczne funkcje w tym projekcie.
--
-- Dwa wpisy: "start" raz dziennie (sprawdza Last-Modified, ewentualnie pobiera zip
-- i rozpoczyna sync), "tick" co 2 minuty (wznawia przetwarzanie od miejsca, w którym
-- skończył poprzedni tick — no-op, jeśli żaden sync nie jest w toku).
select cron.schedule(
  'rail-gtfs-sync-start-daily',
  '0 2 * * *',
  $$
  select net.http_post(
    url := 'https://rjnqpenbjyeiygedjvzk.supabase.co/functions/v1/rail-gtfs-sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{"action":"start"}'::jsonb
  );
  $$
);

select cron.schedule(
  'rail-gtfs-sync-tick',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://rjnqpenbjyeiygedjvzk.supabase.co/functions/v1/rail-gtfs-sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{"action":"tick"}'::jsonb
  );
  $$
);
