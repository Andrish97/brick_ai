-- Realny błąd znaleziony na produkcji: "blob_missing stop_times.txt" — ekstrakcja
-- zgłosiła sukces, a odczyt zaraz potem nie widział wiersza. Przyczyna NIE leżała w
-- Storage ani w Postgresie (rail_sync_blobs jest w pełni spójny — zweryfikowane lokalnie
-- wielokrotnie) — leżała w tym, że DWIE NIEZALEŻNE pętle napędzające "ticki" mogły działać
-- RÓWNOCZEŚNIE na tym samym biegu: przycisk w panelu (bezpośrednie zapytania HTTP z
-- przeglądarki) ORAZ ten cron (rail-gtfs-sync-tick-driver, co 3 minuty, przez
-- rail_gtfs_drive_ticks()) — nadal aktywny od migracji 20240121, mimo że panel dawno
-- przestał go w ogóle wywoływać. Dwie pętle ścigające się o to samo `current_offset`/
-- `current_file` mogą nadpisywać sobie nawzajem postęp.
--
-- Naprawa: JEDEN mechanizm zamiast dwóch. Nowa funkcja rail_gtfs_daily_sync() robi
-- WSZYSTKO co potrzebne codziennemu automatycznemu syncowi w jednym cronie: wywołuje
-- "start", a jeśli faktycznie coś zaczęła (nie "unchanged"/"already_running") — od razu
-- sama napędza "ticki" aż do końca, dokładnie tak jak wcześniej robiły to DWA osobne
-- zadania cron. Blokada advisory-lock nadal chroni przed dwoma równoległymi odpaleniami
-- TEGO SAMEGO cronu (np. gdyby poprzedni dzień się jeszcze nie skończył).
--
-- Kliknięcia z panelu ("Zsynchronizuj teraz") napędzają ticki bezpośrednio z przeglądarki
-- (zob. admin/index.html, syncNow()) i NIE wołają już żadnej z tych funkcji przez RPC —
-- rail_gtfs_drive_ticks() jest więc teraz martwym kodem, używanym wyłącznie przez cron,
-- który tu usuwamy. Usunięcie jej całkowicie eliminuje możliwość, że cokolwiek napędza
-- ticki poza (a) samym panelem administratora i (b) tym jednym, codziennym cronem.
create or replace function public.rail_gtfs_daily_sync() returns jsonb as $$
declare
  secret text;
  req_id bigint;
  resp net._http_response;
  rounds int := 0;
  max_rounds constant int := 60;
  waited_ms int;
  body_json jsonb;
  last_body jsonb;
  lock_key constant bigint := 482910137;
  current_action text := 'start';
begin
  if not pg_try_advisory_lock(lock_key) then
    return jsonb_build_object('skipped', 'already_running_this_cron');
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
      body := jsonb_build_object('action', current_action),
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
      last_body := jsonb_build_object('error', 'timed_out', 'action', current_action, 'round', rounds);
      exit;
    end if;

    begin
      body_json := resp.content::jsonb;
    exception when others then
      body_json := jsonb_build_object('error', 'unparseable_response', 'raw', left(resp.content, 500));
    end;
    last_body := body_json;
    delete from net._http_response where id = req_id;

    if current_action = 'start' then
      -- Nic nowego się nie zaczęło (feed bez zmian / już coś trwa / błąd) — nie ma czego
      -- napędzać dalej.
      if coalesce((body_json->>'ok')::boolean, true) = false
        or body_json->>'skipped' = 'unchanged'
        or body_json->>'skipped' = 'already_running'
      then
        exit;
      end if;
      current_action := 'tick';
    else
      exit when coalesce((body_json->>'done')::boolean, false);
      exit when body_json->>'skipped' = 'nothing_running';
      exit when coalesce((body_json->>'ok')::boolean, true) = false;
    end if;

    perform pg_sleep(0.5);
  end loop;

  perform pg_advisory_unlock(lock_key);
  return jsonb_build_object('rounds', rounds, 'last', last_body);
exception when others then
  perform pg_advisory_unlock(lock_key);
  raise;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'rail-gtfs-sync-start-daily') then
    perform cron.unschedule('rail-gtfs-sync-start-daily');
  end if;
  if exists (select 1 from cron.job where jobname = 'rail-gtfs-sync-tick-driver') then
    perform cron.unschedule('rail-gtfs-sync-tick-driver');
  end if;
end $$;

select cron.schedule(
  'rail-gtfs-sync-daily',
  '0 2 * * *',
  $$select public.rail_gtfs_daily_sync();$$
);

drop function if exists public.rail_gtfs_drive_ticks();
