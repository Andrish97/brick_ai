-- Zamiast trzymać pliki między krokami syncu w Supabase Storage (osobny serwis za
-- Cloudflare) trzymamy je teraz wprost w Postgresie, z którym rail-gtfs-sync i tak już
-- rozmawia bezpośrednio (RAIL_DB_URL) do wszystkich innych operacji. Cała ta sesja
-- debugowania (404/NoSuchKey, teorie o propagacji i cache'u Cloudflare, retry z odstępem,
-- cache-busting, w końcu potwierdzone realnym listowaniem katalogu) sprowadzała się do
-- jednego: HTTP przez CDN do osobnego serwisu ma klasę problemów ze spójnością odczytu
-- tuż po zapisie, których zwykłe zapytanie SQL do tej samej bazy strukturalnie nie ma.
create table if not exists public.rail_sync_blobs (
  run_id    uuid not null references public.rail_sync_runs(id) on delete cascade,
  file_name text not null,
  content   bytea not null,
  primary key (run_id, file_name)
);

alter table public.rail_sync_blobs enable row level security;
create policy "auth_rail_sync_blobs_all" on public.rail_sync_blobs
  for all to authenticated using (true) with check (true);
