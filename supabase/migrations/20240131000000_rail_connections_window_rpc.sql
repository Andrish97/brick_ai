-- Realny błąd znaleziony na produkcji: runCsaJourney filtrował rail_connections po
-- service_id przez URL-owy PostgREST filtr "in.(id1,id2,...)". Dla dnia z 618 aktywnymi
-- service_id (potwierdzone diagnostyką dodaną wcześniej: activeServiceCount=618) to ~19.5KB
-- samego tego segmentu URL-a — a windowsScanned=0/connectionsScannedTotal=0 w tej samej
-- diagnostyce (pierwsze zapytanie rzuciło wyjątek, zanim licznik zdążył się zwiększyć)
-- potwierdza, że coś w tym zapytaniu faktycznie zawodziło. IN_LIST_LIMIT=500 w kodzie
-- (obcinający listę PRZED budową URL-a) było próbą obejścia tego objawowo, nie źródłowo —
-- i tak cicho gubiło 118 z 618 aktywnych usług tego dnia.
--
-- Naprawa: filtr service_id przez ciało zapytania POST (RPC), nie przez URL — długość
-- ciała POST nie ma tego ograniczenia, więc CAŁA lista aktywnych service_id (bez
-- sztucznego obcinania) trafia do zapytania.
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
  limit 5000;
$$ language sql stable;

grant execute on function public.rail_connections_in_window(uuid[], int, int) to authenticated, anon;
