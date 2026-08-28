-- Realny dowód z logów Supabase: 8 wywołań rail-gtfs-sync wystartowało w oknie ~10s,
-- większość z nich trwała ~75s każde (zamiast ułamka sekundy) zanim któreś dostało
-- "Memory limit exceeded". Zbyt długi, prawie identyczny czas wielu wywołań naraz to
-- typowy obraz KOLEJKI NA BLOKADZIE WIERSZA: kilka wywołań próbuje jednocześnie pisać do
-- tych samych wierszy w rail_sync_blobs (zwłaszcza wieloetapowy zapis z putBlobLarge —
-- kilka INSERT-ów + finałowe sklejenie), więc Postgres serializuje je jedno za drugim, a
-- każde kolejne wywołanie klienta (co 500ms) dokłada się do rosnącej kolejki zamiast
-- czekać na miejsce.
--
-- Zwykła tabela z jednym wierszem jako blokada — NIE pg_try_advisory_lock — bo
-- RAIL_DB_URL idzie przez Transaction Pooler Supabase, gdzie blokady na poziomie SESJI
-- (advisory locks) nie są bezpieczne (pooler może przydzielić kolejne zapytanie tej samej
-- logicznej "sesji" na innym fizycznym połączeniu). Zwykły UPDATE na wierszu działa
-- poprawnie niezależnie od trybu poolingu.
create table if not exists public.rail_sync_worker_lock (
  id            boolean primary key default true,
  locked_until  timestamptz
);

insert into public.rail_sync_worker_lock (id, locked_until)
values (true, null)
on conflict (id) do nothing;

alter table public.rail_sync_worker_lock enable row level security;
create policy "auth_rail_sync_worker_lock_all" on public.rail_sync_worker_lock
  for all to authenticated using (true) with check (true);
