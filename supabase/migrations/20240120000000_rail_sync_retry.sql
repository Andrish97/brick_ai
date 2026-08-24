-- Realny sync ujawnił, że Cloudflare przed Supabase potrafi na chwilę zablokować serię
-- szybkich zapytań Range do Storage (prawdopodobnie WAF reagujący na częstotliwość
-- zapytań, np. przy szybkim klikaniu "Krok" pod rząd w panelu) — HTTP 403. Wcześniej
-- KAŻDY błąd w "ticku" od razu kończył cały sync jako 'failed', tracąc cały dotychczasowy
-- postęp (offset w stop_times.txt), mimo że to typowo przejściowy, samo-ustępujący
-- problem sieciowy, nie realny błąd danych.
alter table public.rail_sync_runs
  add column if not exists consecutive_errors int not null default 0;
