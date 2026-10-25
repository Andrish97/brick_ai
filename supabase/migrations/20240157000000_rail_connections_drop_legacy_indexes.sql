do $$
begin
  -- The active compact search RPC and incremental snapshot builder do not use
  -- these legacy indexes; retaining them wastes space during dual-snapshot builds.
  drop index if exists public.rail_connections_trip_id_idx;
  drop index if exists public.rail_connections_to_idx;
end;
$$;
