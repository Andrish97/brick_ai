-- Pasek postępu w panelu admina potrzebuje mianownika: ile bajtów ma w sumie
-- stop_times.txt (jedyny plik na tyle duży, żeby jego postęp w bajtach był widoczny —
-- reszta plików kończy się w jednym-dwóch tickach). storageGetRange() już i tak zwraca
-- totalSize z nagłówka Content-Range przy każdym odczycie (weryfikacja uploadu w
-- extractOneFile) — brakowało tylko zapisania tej wartości, żeby front-end mógł policzyć
-- current_offset / current_total_bytes jako ułamek postępu bieżącego pliku.
alter table public.rail_sync_runs
  add column if not exists current_total_bytes bigint;
