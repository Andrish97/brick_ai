-- Realny dowód z produkcji + lokalny pomiar: postgres.js NIE ma trybu binarnego dla bytea
-- (jedyny format transferu to tekstowy hex, `\x...`, kodowany/dekodowany przez Buffer w
-- Deno) — kosztuje realnie ~140ms/MB przy odczycie i ~350ms/MB przy zapisie CZASU CPU w
-- tym środowisku (potwierdzone: dekodowanie 10.6MB ~1.5s, kodowanie ~3.7s). To ono, nie
-- sama dekompresja ani liczba zapytań, zabijało ekstrakcję stop_times.txt — sam odczyt
-- całego skompresowanego wpisu (10.6MB) jednym zapytaniem kosztował ~1.9s CPU, tuż pod
-- twardym limitem 2s, zanim cokolwiek innego zdążyło się wydarzyć (potwierdzone logami
-- rail_sync_debug: fast_writer_init na 2091ms, nigdy dalej).
--
-- Nowa ekstrakcja dużego pliku pobiera skompresowane bajty bezpośrednio z feedu przez
-- Range (fetch(), bez tekstowego kodowania), dekompresuje w całości w pamięci (tanie:
-- ~300-500ms CPU nawet dla ~49MB wyjścia), i zapisuje wynik w bezpiecznie małych
-- kawałkach rozłożonych na wiele ticków — potrzebny osobny licznik postępu, bo
-- current_offset tego samego pliku ma już inne, ustalone znaczenie w fazie parsowania
-- (bajty skonsumowane z JUŻ rozpakowanego pliku), a -1 zostaje sentinelem "jeszcze nie
-- zaczęto rozpakowywać".
alter table public.rail_sync_runs
  add column if not exists extract_progress_bytes bigint;
