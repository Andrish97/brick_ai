-- Odpowiedź na realne pytanie: "jak Kolejo wyszukuje tak szybko?" -- nasz CSA (nawet po
-- filtrowaniu po frontierze, poprzednia migracja) wciąż "zalewał" całą krajową sieć na
-- oślep: po 25 zapytaniach frontier urósł do 732 stacji, w tym Rzepin (granica z Niemcami)
-- i Czyżew (okolice Białegostoku) -- setki km w złą stronę względem celu (Zamość), bo
-- algorytm w ogóle nie wiedział, w którą stronę geograficznie jest cel.
--
-- Realne planery tras ograniczają eksplorację geograficznie/kierunkowo. Klasyczny test
-- "elipsy": stacja z tej grupy jest dopuszczalna do dalszej eksploracji tylko jeśli
-- dystans(origin,S) + dystans(S,cel) <= dystans(origin,cel) * zapas -- dopuszcza rozsądne
-- objazdy (realne trasy kolejowe nie są linią prostą), odrzuca kursy jadące w oczywiście
-- złym kierunku. Filtrowane tu, w SQL, przez join do rail_stops.lat/lon -- klient nie musi
-- dociągać współrzędnych rosnącego frontieru osobnymi zapytaniami.
--
-- Płaska aproksymacja odległości (nie pełny haversine) -- wystarczająca dla obszaru
-- wielkości Polski, dużo prostsza.
--
-- WAŻNE: elipsa liczona jest względem TO_STOP_ID (dokąd kurs faktycznie zmierza), nie
-- from_stop_id (skąd startuje) -- realny błąd znaleziony przy weryfikacji tej migracji
-- (test lokalny): filtrowanie po stacji ODJAZDU nie odróżnia dwóch kursów startujących z
-- TEJ SAMEJ stacji w zupełnie różnych kierunkach (oba mają identyczny wynik detour, bo to
-- ten sam punkt startu) -- filtr musi patrzeć na to, dokąd kurs prowadzi, nie skąd startuje.
create or replace function public.rail_connections_in_window(
  p_service_ids uuid[], p_dep_from int, p_dep_to int, p_from_stop_ids uuid[] default null,
  p_origin_lat numeric default null, p_origin_lon numeric default null,
  p_dest_lat numeric default null, p_dest_lon numeric default null,
  p_max_detour_km numeric default null
) returns table (
  trip_id uuid, service_id uuid, from_stop_id uuid, to_stop_id uuid, dep_seconds int, arr_seconds int
) as $$
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
  order by c.dep_seconds asc
  limit 10000;
$$ language sql stable;

grant execute on function public.rail_connections_in_window(uuid[], int, int, uuid[], numeric, numeric, numeric, numeric, numeric) to authenticated, anon;
