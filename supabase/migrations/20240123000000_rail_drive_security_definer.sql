-- Realny test z panelu ujawnił: RPC rail_gtfs_drive_ticks(), wywoływane jako zalogowany
-- admin (rola `authenticated` przez PostgREST), dostawało "permission denied for schema
-- vault" i kończyło się NATYCHMIAST, bez wykonania choćby jednego ticku — cały widoczny
-- postęp synchronizacji szedł wyłącznie z crona (rola, która uruchomiła migrację i przez
-- to zaplanowała cron.schedule, ma dostęp do vault.decrypted_secrets), więc przycisk
-- "Zsynchronizuj teraz" / "Sprawdź / popchnij dalej" w panelu nigdy realnie nic nie robił
-- — tylko zwracał od razu błąd uprawnień, mylnie wyglądający jak "nic się nie stało".
--
-- SECURITY DEFINER każe funkcji wykonywać się z uprawnieniami jej WŁAŚCICIELA (roli, która
-- ją utworzyła przez migrację — ma dostęp do vault), niezależnie od tego, kto ją faktycznie
-- woła — nie z uprawnieniami wołającego (domyślne SECURITY INVOKER, które tu zawodziło).
-- Funkcja nie przyjmuje żadnych parametrów i nie buduje dynamicznego SQL z danych
-- wołającego, więc jedyne realne ryzyko SECURITY DEFINER (przechwycenie przez podrzucony
-- obiekt na search_path) jest zaadresowane jawnym, bezpiecznym SET search_path.
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
$$ language plpgsql security definer set search_path = public, pg_temp;

grant execute on function public.rail_gtfs_drive_ticks() to authenticated;
