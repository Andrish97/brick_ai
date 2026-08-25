-- Mechanizm cron/tick przebudowany na prośbę użytkownika ("chodzi o cały mechanizm") —
-- poprzednia wersja polegała na pg_cron odpalającym pojedynczy "tick" co 2 minuty, więc
-- pełna synchronizacja (kilkanaście kroków: rozpakowanie każdego pliku GTFS + sparsowanie
-- kawałków stop_times.txt) trwała ~20-30 minut, nawet gdy każdy pojedynczy krok kończył
-- się w ułamku sekundy — cała reszta czasu to czekanie na kolejne odpalenie crona.
--
-- Powód, dla którego w ogóle trzeba dzielić pracę na małe kroki, zostaje bez zmian:
-- limit 2s czasu CPU na jedno wywołanie Supabase Edge Function (rail-gtfs-sync) — to
-- twardy limit platformy, nie da się go obejść. Zmienia się tylko to, KTO i JAK SZYBKO
-- odpala kolejne kroki: zamiast czekać na następne odpalenie harmonogramu crona, funkcja
-- Postgresowa rail_gtfs_drive_ticks() sama, w pętli, odpala kolejne "ticki" przez pg_net
-- i czeka na odpowiedź każdego (pg_net jest z założenia asynchroniczne — nie ma
-- wbudowanego odpowiednika "poczekaj na odpowiedź", więc pollujemy tabelę
-- net._http_response co 300ms), z małym odstępem między nimi (700ms — tyle samo
-- ostrożności co MAX_CHUNKS_PER_TICK/CHUNK_DELAY_MS w samej funkcji, żeby seria zapytań
-- nie wyglądała dla Cloudflare jak atak). Cały sync (kilkanaście "ticków") kończy się
-- teraz w jednym wywołaniu tej funkcji, w ≈kilka minut zamiast 20-30.
--
-- Blokada advisory-lock (pg_try_advisory_lock) chroni przed dwoma równoległymi
-- uruchomieniami tej funkcji nadpisującymi sobie nawzajem postęp (np. gdyby cron
-- odpalił kolejne wywołanie zanim poprzednie zdążyło skończyć) — potwierdzone lokalnym
-- testem: druga, równoległa próba dostaje {"skipped":"already_driving"} zamiast ścigać
-- się z pierwszą.
--
-- Wywoływalne na dwa sposoby:
--   1. Automatycznie, co 3 minuty, przez pg_cron (rail-gtfs-sync-tick-driver) — margines
--      3 minuty (nie 1) celowo większy niż maksymalny realny czas jednego przebiegu
--      pętli, żeby kolejne odpalenie crona nie nakładało się na wciąż trwające.
--   2. Na żądanie z panelu admina przez RPC (sb.rpc('rail_gtfs_drive_ticks')) — stąd
--      "grant execute ... to authenticated" niżej — do ręcznego, szybkiego testowania
--      bez czekania na cron.
create or replace function public.rail_gtfs_drive_ticks() returns jsonb as $$
declare
  secret text;
  req_id bigint;
  resp net._http_response;
  rounds int := 0;
  max_rounds constant int := 40; -- twardy bezpiecznik na jedno wywołanie tej funkcji
  waited_ms int;
  body_json jsonb;
  last_body jsonb;
  lock_key constant bigint := 482910137; -- dowolna stała, unikalna dla tej funkcji w tym projekcie
begin
  if not pg_try_advisory_lock(lock_key) then
    return jsonb_build_object('skipped', 'already_driving');
  end if;

  select decrypted_secret into secret from vault.decrypted_secrets where name = 'internal_secret';
  if secret is null then
    perform pg_advisory_unlock(lock_key);
    return jsonb_build_object('error', 'internal_secret_missing');
  end if;

  loop
    rounds := rounds + 1;
    exit when rounds > max_rounds;

    req_id := net.http_post(
      url := 'https://rjnqpenbjyeiygedjvzk.supabase.co/functions/v1/rail-gtfs-sync',
      body := '{"action":"tick"}'::jsonb,
      headers := jsonb_build_object('Authorization', 'Bearer ' || secret, 'Content-Type', 'application/json'),
      timeout_milliseconds := 60000
    );

    waited_ms := 0;
    resp := null;
    loop
      perform pg_sleep(0.3);
      waited_ms := waited_ms + 300;
      select * into resp from net._http_response where id = req_id;
      exit when resp.id is not null or waited_ms > 65000;
    end loop;

    if resp.id is null then
      last_body := jsonb_build_object('error', 'tick_timed_out', 'round', rounds);
      exit;
    end if;

    begin
      body_json := resp.content::jsonb;
    exception when others then
      body_json := jsonb_build_object('error', 'unparseable_response', 'raw', left(resp.content, 500));
    end;
    last_body := body_json;

    -- Posprzątaj po sobie — tabela net._http_response inaczej rośnie bez końca.
    delete from net._http_response where id = req_id;

    exit when coalesce((body_json->>'done')::boolean, false);
    exit when body_json->>'skipped' = 'nothing_running';
    exit when coalesce((body_json->>'ok')::boolean, true) = false;

    perform pg_sleep(0.7);
  end loop;

  perform pg_advisory_unlock(lock_key);
  return jsonb_build_object('rounds', rounds, 'last', last_body);
exception when others then
  perform pg_advisory_unlock(lock_key);
  raise;
end;
$$ language plpgsql;

grant execute on function public.rail_gtfs_drive_ticks() to authenticated;

-- Zastępuje poprzedni cron "jeden tick co 2 minuty" (20240118000000) tym, który
-- sam odpala serię ticków w pętli — cron.unschedule rzuca wyjątkiem, jeśli zadanie
-- o tej nazwie nie istnieje, stąd warunkowe sprawdzenie zamiast bezwarunkowego wywołania.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'rail-gtfs-sync-tick') then
    perform cron.unschedule('rail-gtfs-sync-tick');
  end if;
end $$;

select cron.schedule(
  'rail-gtfs-sync-tick-driver',
  '*/3 * * * *',
  $$select public.rail_gtfs_drive_ticks();$$
);
