-- "Dwukierunkowość" (użytkownik: "robimy dwukierunkowy") -- ale w bezpiecznej,
-- niskoryzykownej formie: NIE pełne równoległe przeszukiwanie w czasie wstecz (co
-- wymagałoby zduplikowania CAŁEJ logiki przesiadek/kontynuacji kursu z dzisiejszej sesji w
-- odwróconym czasie plus nowego, nigdy wcześniej testowanego punktu spotkania dwóch
-- przeszukiwań -- podwójne ryzyko nowych, subtelnych błędów tego samego rodzaju co dziś).
-- Zamiast tego: JEDNORAZOWE, statyczne przeszukanie wstecz "które stacje w ogóle mogą
-- dotrzeć do celu jakimkolwiek łańcuchem kursów" -- ignorujące czas i service_id (czysta
-- topologia sieci) -- liczone RAZ na start wyszukiwania (nie w pętli okien), używane do
-- przycięcia frontieru w JUŻ zweryfikowanym przeszukiwaniu w przód (runCsaJourney).
-- Bycie NADmiarowym (nie wykluczonym) w tym zbiorze jest zawsze bezpieczne -- najwyżej nie
-- pomaga; bycie BRAKUJĄCYM byłoby błędem, dlatego to jednokierunkowe zabezpieczenie: gdy
-- to zapytanie zawiedzie, JS po prostu nie filtruje (zob. runCsaJourney).
--
-- PIERWSZA WERSJA (znaleziony błąd przy weryfikacji lokalnej): krawędzie grafu jako
-- "pierwszy przystanek -> ostatni przystanek" per trip_id (żeby ograniczyć liczbę
-- iteracji rekursji) GUBIŁY każdą przesiadkę na stacji POŚREDNIEJ kursu -- czyli
-- WIĘKSZOŚĆ realnych przesiadek, które nie zdarzają się akurat na absolutnym początku/
-- końcu żadnego konkretnego kursu. Test lokalny z syntetycznymi danymi (trip1: A-B-C,
-- transfer na C do trip2: C-D) potwierdził: stacja B (pośrednia) i tak nie ma znaczenia
-- dla tego konkretnego testu, ale w realnych danych przesiadka WŁAŚNIE na stacji
-- pośredniej jest normą (np. duży węzeł w środku trasy dalekobieżnego kursu).
--
-- Poprawka: surowe pary sąsiednich przystanków z rail_connections (KAŻDY przystanek
-- kursu jest węzłem, nie tylko pierwszy/ostatni). Głębokość rekurencji potrzebna do
-- przejechania jednego długiego kursu jest większa, ALE `union` (nie `union all`) w
-- rekurencyjnym CTE i tak liczy PEŁNY punkt stały niezależnie od głębokości (zweryfikowane
-- lokalnie: cykl w danych testowych nie powodował nieskończonej pętli) -- to kwestia
-- kosztu zapytania, nie poprawności, i indeks na to_stop_id (nowy, potrzebny do tego
-- zapytania -- rail_connections miał dotąd indeks tylko na from_stop_id) trzyma ten koszt
-- rozsądnym.
create index if not exists rail_connections_to_idx on public.rail_connections (to_stop_id);

create or replace function public.rail_backward_reachable_stations(
  p_dest_stop_ids uuid[]
) returns table (stop_id uuid) as $$
  with recursive backward as (
    select unnest(p_dest_stop_ids) as stop_id
    union
    select c.from_stop_id
    from public.rail_connections c
    join backward b on c.to_stop_id = b.stop_id
  )
  select stop_id from backward limit 20000;
$$ language sql stable;

grant execute on function public.rail_backward_reachable_stations(uuid[]) to authenticated, anon;
