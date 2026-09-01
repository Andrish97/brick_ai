-- Realny problem wydajnościowy z produkcji: rail_connections_in_window nie filtrował po
-- stacji, więc każde okno zwracało CAŁY krajowy rozkład w tym przedziale czasu (do 1000-
-- 10000 wierszy) -- w praktyce niemal wszystkie NIEZWIĄZANE z aktualnie osiągalnymi
-- stacjami. Po naprawieniu gubienia kontynuacji kursu (poprzednia migracja/commit) CSA
-- realnie dociera już do dalekich miast (Rzeszów, Rzepin, Czyżew...), ale mimo wyczerpania
-- całego budżetu 25 zapytań RPC wciąż nie starczało zasięgu na dotarcie do rzadziej
-- odwiedzanych regionów (np. Zamość) -- bo każde zapytanie marnowało prawie cały swój
-- limit wierszy na połączenia niezwiązane z poszukiwaną trasą.
--
-- Naprawa: opcjonalny filtr p_from_stop_ids -- gdy podany, ogranicza wynik do połączeń
-- odjeżdżających TYLKO z aktualnie osiągalnych stacji (frontier CSA), więc ten sam limit
-- wierszy w praktyce pokrywa dużo szerszy, bardziej użyteczny zasięg czasowy/eksploracyjny.
-- NULL (domyślnie) zachowuje dawne zachowanie (bez filtra) dla kompatybilności wstecznej.
create or replace function public.rail_connections_in_window(
  p_service_ids uuid[], p_dep_from int, p_dep_to int, p_from_stop_ids uuid[] default null
) returns table (
  trip_id uuid, service_id uuid, from_stop_id uuid, to_stop_id uuid, dep_seconds int, arr_seconds int
) as $$
  select trip_id, service_id, from_stop_id, to_stop_id, dep_seconds, arr_seconds
  from public.rail_connections
  where service_id = any(p_service_ids)
    and dep_seconds >= p_dep_from and dep_seconds < p_dep_to
    and (p_from_stop_ids is null or from_stop_id = any(p_from_stop_ids))
  order by dep_seconds asc
  limit 10000;
$$ language sql stable;

grant execute on function public.rail_connections_in_window(uuid[], int, int, uuid[]) to authenticated, anon;
