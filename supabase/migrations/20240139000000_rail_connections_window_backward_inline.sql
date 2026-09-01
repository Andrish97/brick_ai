-- Realny błąd znaleziony na produkcji (pierwszy test po wdrożeniu poprzedniej migracji):
-- rail_backward_reachable_stations jako OSOBNA RPC zwracająca listę stacji trafiała w
-- domyślny limit wierszy PostgREST/Supabase (max-rows, typowo 1000) -- backwardReachableCount
-- w logach wyszedł RÓWNO 1000, mimo że SQL miał "limit 20000". PostgREST ucina wynik NIEZALEŻNIE
-- od LIMIT w samym zapytaniu, w NIEOKREŚLONEJ kolejności (bez ORDER BY) -- czyli klient dostawał
-- losowe 1000 z prawdziwie dużo większego zbioru, mogąc łatwo zgubić akurat ten węzeł, który
-- prowadzi do celu. To nie był "za mały budżet", tylko cichy, błędny wynik.
--
-- Naprawa: NIE zwracaj tej listy do klienta w ogóle. Wbuduj sprawdzenie wstecz-osiągalności
-- BEZPOŚREDNIO w rail_connections_in_window jako dodatkowy warunek WHERE (rekurencyjne CTE
-- policzone i użyte WEWNĄTRZ tego samego zapytania) -- nigdy nie opuszcza bazy jako osobna
-- lista, więc nie ma czego uciąć. Kosztem jest przeliczanie tej samej rekurencji przy każdym
-- oknie zamiast raz -- akceptowalny kompromis: to obliczenie po stronie DB (nie zużywa budżetu
-- CPU Edge Function), a poprawność jest ważniejsza niż powtórna praca.
--
-- DRUGI realny błąd znaleziony przy tej samej weryfikacji: każda z dzisiejszych migracji
-- dodawała nowe parametry przez "create or replace function" z ROZSZERZONĄ listą parametrów
-- -- Postgres identyfikuje funkcje po PEŁNEJ liście typów, więc to nie ZASTĘPOWAŁO starej
-- wersji, tylko tworzyło NOWE PRZECIĄŻENIE obok niej. Efekt: 4 różne sygnatury tej funkcji
-- współistniały jednocześnie w bazie. Wywołanie RPC z niepełnym (nazwanym) zestawem
-- parametrów -- co dokładnie robił klient (sbRpc) za KAŻDYM razem, gdy geoParams było puste
-- (stacja bez współrzędnych) -- staje się WTEDY niejednoznaczne (pasuje do więcej niż
-- jednego przeciążenia) i Postgres odrzuca je błędem, zamiast wybrać "właściwą" wersję.
-- Jawne usunięcie WSZYSTKICH poprzednich sygnatur przed utworzeniem nowej -- każda kolejna
-- migracja tej funkcji MUSI robić to samo, żeby uniknąć powrotu tego błędu.
drop function if exists public.rail_connections_in_window(uuid[], int, int);
drop function if exists public.rail_connections_in_window(uuid[], int, int, uuid[]);
drop function if exists public.rail_connections_in_window(uuid[], int, int, uuid[], numeric, numeric, numeric, numeric, numeric);

create or replace function public.rail_connections_in_window(
  p_service_ids uuid[], p_dep_from int, p_dep_to int, p_from_stop_ids uuid[] default null,
  p_origin_lat numeric default null, p_origin_lon numeric default null,
  p_dest_lat numeric default null, p_dest_lon numeric default null,
  p_max_detour_km numeric default null,
  p_dest_stop_ids uuid[] default null
) returns table (
  trip_id uuid, service_id uuid, from_stop_id uuid, to_stop_id uuid, dep_seconds int, arr_seconds int
) as $$
  with recursive backward as (
    select unnest(p_dest_stop_ids) as stop_id
    where p_dest_stop_ids is not null
    union
    select c2.from_stop_id
    from public.rail_connections c2
    join backward b on c2.to_stop_id = b.stop_id
  )
  select c.trip_id, c.service_id, c.from_stop_id, c.to_stop_id, c.dep_seconds, c.arr_seconds
  from public.rail_connections c
  left join public.rail_stops s on s.id = c.to_stop_id
  where c.service_id = any(p_service_ids)
    and c.dep_seconds >= p_dep_from and c.dep_seconds < p_dep_to
    and (p_from_stop_ids is null or c.from_stop_id = any(p_from_stop_ids))
    and (
      p_origin_lat is null or s.lat is null or s.lon is null
      or (
        sqrt(power((s.lat - p_origin_lat) * 111.0, 2) + power((s.lon - p_origin_lon) * 111.0 * cos(radians((s.lat + p_origin_lat) / 2)), 2))
        + sqrt(power((s.lat - p_dest_lat) * 111.0, 2) + power((s.lon - p_dest_lon) * 111.0 * cos(radians((s.lat + p_dest_lat) / 2)), 2))
      ) <= p_max_detour_km
    )
    and (p_dest_stop_ids is null or c.to_stop_id in (select stop_id from backward))
  order by c.dep_seconds asc
  limit 10000;
$$ language sql stable;

grant execute on function public.rail_connections_in_window(uuid[], int, int, uuid[], numeric, numeric, numeric, numeric, numeric, uuid[]) to authenticated, anon;

-- Osobna RPC (poprzednia migracja) nie jest już używana przez klienta -- zwracanie dużej
-- listy do JS zawsze będzie podatne na ten sam limit wierszy PostgREST. Zostawiona
-- (nieużywana) zamiast usuwana, na wypadek przyszłego zastosowania z jawną paginacją.
