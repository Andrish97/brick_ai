-- Secure pg_cron helper for enqueueing one resumable Edge Function tick.
create or replace function public.rail_gtfs_enqueue_sync_action(p_action text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  if p_action not in ('start', 'tick') then
    raise exception 'unsupported rail sync action';
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'internal_secret';
  if v_secret is null then
    raise exception 'internal_secret_missing';
  end if;

  v_request_id := net.http_post(
    url := 'https://rjnqpenbjyeiygedjvzk.supabase.co/functions/v1/rail-gtfs-sync',
    body := jsonb_build_object('action', p_action),
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    timeout_milliseconds := 60000
  );
  return v_request_id;
end;
$$;
