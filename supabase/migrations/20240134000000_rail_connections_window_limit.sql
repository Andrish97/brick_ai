-- Realny błąd z produkcji (pierwszy test po rozszerzeniu okna startowego w CSA,
-- Katowice -> Zamość): connectionsScannedTotal wyszło DOKŁADNIE 5000 — równe twardemu
-- LIMIT w rail_connections_in_window, który nie filtruje po stacji, tylko zwraca CAŁY
-- krajowy rozkład aktywny w oknie (tu: ~667 service_id na 4-godzinne okno). Sortowanie
-- "order by dep_seconds asc limit 5000" w takim wypadku po cichu ucina PÓŹNIEJSZĄ część
-- okna, zanim CSA zdąży zobaczyć właściwe połączenia z interesującej nas stacji.
--
-- Naprawa dwutorowa: (1) w csa.ts okna z powrotem zwężone do 2h (więcej ich, ten sam
-- łączny zasięg) — to główna naprawa; (2) tu, jako dodatkowy zapas bezpieczeństwa na
-- wypadek dni z jeszcze gęstszym rozkładem niż w tym teście, LIMIT podniesiony z 5000
-- do 10000.
create or replace function public.rail_connections_in_window(
  p_service_ids uuid[], p_dep_from int, p_dep_to int
) returns table (
  trip_id uuid, service_id uuid, from_stop_id uuid, to_stop_id uuid, dep_seconds int, arr_seconds int
) as $$
  select trip_id, service_id, from_stop_id, to_stop_id, dep_seconds, arr_seconds
  from public.rail_connections
  where service_id = any(p_service_ids)
    and dep_seconds >= p_dep_from and dep_seconds < p_dep_to
  order by dep_seconds asc
  limit 10000;
$$ language sql stable;

grant execute on function public.rail_connections_in_window(uuid[], int, int) to authenticated, anon;
