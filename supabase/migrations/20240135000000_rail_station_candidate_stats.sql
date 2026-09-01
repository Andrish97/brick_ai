-- Bezpiecznik dla resolveStationGroupSmart (wybór stacji przez AI, csa.ts): jeśli
-- odpowiedź modelu nie zgadza się DOSŁOWNIE z żadnym kandydatem (halucynacja) albo samo
-- wywołanie AI zawiedzie, wybieramy kandydata z NAJWIĘKSZĄ liczbą zapisanych odjazdów w
-- rail_connections jako tanie, czysto danowe przybliżenie "największej/głównej stacji"
-- (duży węzeł ma wielokrotnie więcej odjazdów niż mały przystanek lokalny).
create or replace function public.rail_station_candidate_stats(
  p_stop_ids uuid[]
) returns table (
  stop_id uuid, departure_count bigint
) as $$
  select from_stop_id as stop_id, count(*) as departure_count
  from public.rail_connections
  where from_stop_id = any(p_stop_ids)
  group by from_stop_id;
$$ language sql stable;

grant execute on function public.rail_station_candidate_stats(uuid[]) to authenticated, anon;
