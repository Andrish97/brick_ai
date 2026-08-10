-- Monitoring salda Zadarma: dokładny koszt SMS-ów liczony z realnych obserwacji
-- salda (nie z zakładanej ceny), z dopasowaniem odroczonym w czasie zamiast
-- naiwnego "saldo przed/po" (opóźnione księgowanie po stronie Zadarmy mogłoby
-- inaczej zaniżać koszt jednej wysyłki i fałszywie oznaczać jej realny,
-- opóźniony koszt jako "podejrzany wydatek" przy najbliższej obserwacji).
-- Jedyna aktywność na koncie to Brick AI, więc dopasowanie liczone w panelu
-- (JS, na podstawie tych dwóch tabel) jest dokładne bez żadnych heurystyk.

-- Surowe odczyty salda — z jakiegokolwiek powodu (przed wysyłką, po wysyłce,
-- okresowy cron). Żadnej interpretacji na tym etapie, tylko fakt: o której
-- godzinie ile było na koncie.
create table if not exists public.balance_observations (
  id          uuid primary key default gen_random_uuid(),
  observed_at timestamptz not null default now(),
  balance     numeric not null,
  currency    text,
  trigger     text not null -- 'pre_send' | 'post_send' | 'periodic'
);

alter table public.balance_observations enable row level security;

create policy "auth_balance_observations_all" on public.balance_observations
  for all to authenticated using (true) with check (true);

create index balance_observations_observed_at_idx on public.balance_observations (observed_at);

-- Potwierdzone, udane wysyłki SMS — bez przypisanego kosztu (koszt liczony
-- odroczenie w panelu, dopasowaniem do balance_observations).
create table if not exists public.sms_sends (
  id         uuid primary key default gen_random_uuid(),
  sent_at    timestamptz not null default now(),
  parts_sent int not null,
  source     text not null -- 'webhook' | 'admin'
);

alter table public.sms_sends enable row level security;

create policy "auth_sms_sends_all" on public.sms_sends
  for all to authenticated using (true) with check (true);

create index sms_sends_sent_at_idx on public.sms_sends (sent_at);

-- Cron w Supabase (nie GitHub Actions) — codzienny snapshot salda, żeby łapać
-- doładowania/opłatę za numer nawet gdy akurat nic nie jest wysyłane.
-- Bez "with schema" — pg_cron/pg_net instalują swoje obiekty we własnych,
-- stałych schematach (cron.*, net.*), z których korzysta zapytanie niżej.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Sekret INTERNAL_SECRET musi zostać dodany RĘCZNIE, raz, w SQL Editorze Supabase
-- (nie może trafić do repo/gita): `select vault.create_secret('<wartość>', 'internal_secret');`
-- Ta sama wartość co sekret funkcji INTERNAL_SECRET (ustawiany przez `supabase secrets set`).
-- Dopóki sekret nie zostanie dodany, zadanie cron będzie się wywoływać, ale wywołanie
-- funkcji zwróci 401 (widoczne w logach) — patrz README.
select cron.schedule(
  'zadarma-balance-snapshot-daily',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://rjnqpenbjyeiygedjvzk.supabase.co/functions/v1/zadarma-balance-snapshot',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
