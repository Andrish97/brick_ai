// Lokalny Connection Scan Algorithm nad zsynchronizowanym rozkładem GTFS (zob.
// supabase/migrations/20240118000000_rail_gtfs.sql, supabase/functions/rail-gtfs-sync)
// — zastępuje żywe zapytania PKP dla plan_train_journey, gdy lokalne dane są dostępne
// i świeże. index.ts wywołuje runCsaJourney() jako pierwszą próbę; przy jakimkolwiek
// niepowodzeniu (zwraca null) woła dotychczasową, niezmienioną żywą heurystykę jako
// bezwarunkowy fallback — zob. plan_train_journey w index.ts.
//
// UWAGA: kod nigdy nie był uruchomiony na żywo (sandbox bez dostępu do wdrożonego
// Supabase) — napisany defensywnie (try/catch na każdym kroku sieciowym, null zamiast
// wyjątku przy niepewności), ale prawdopodobnie ujawni coś do poprawki przy pierwszym
// realnym użyciu. To oczekiwane.
//
// Ten plik jest CELOWO samodzielny (własna kopia małych helperów: sbGet,
// pickBestStationMatch) zamiast importu z index.ts — unika cyklicznego importu
// (index.ts importuje Z tego pliku), zgodnie z tolerowaną w tym repo małą duplikacją
// między plikami zamiast ryzykownego współdzielenia modułów między funkcjami.

type RailStation = { id: string; name: string };
// Realny błąd na produkcji: "Katowice" jako NAZWA odpowiada dwóm różnym wierszom
// rail_stops (osobne stop_id dla różnych peronów/torów — normalne w GTFS), a rzeczywiste
// odjazdy w rail_connections są zapisane pod TYLKO JEDNYM z tych stop_id. Traktowanie
// rozwiązanej stacji jako pojedynczego, arbitralnie wybranego stop_id (dawne zachowanie)
// znajdowało "Katowice" poprawnie, ale CSA i tak nie widziało żadnych odjazdów (0 z 5913
// przeskanowanych połączeń dawało się wsiąść), bo trafiało akurat na stop_id bez żadnych
// zapisanych kursów. Poprawka: stacja to GRUPA wszystkich stop_id dzielących tę samą nazwę
// — CSA trakuje dowolny z nich jako poprawny punkt startowy/docelowy.
type RailStationGroup = { name: string; ids: string[] };
type StationLookup = { ok: true; station: RailStationGroup } | { ok: false; body: Record<string, unknown> };

async function sbGet<T>(url: string, key: string, path: string): Promise<T[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`rail_db_get_failed ${path}: HTTP ${res.status}`);
  return res.json();
}

// RPC (POST) zamiast GET z filtrem w URL — realny błąd na produkcji: lista aktywnych
// service_id danego dnia (setki UUID-ów) w URL-owym filtrze "in.(...)" tworzyła zapytanie
// rzędu ~20KB, co zawodziło (potwierdzone diagnostyką: pierwsze zapytanie o rail_connections
// zawsze rzucało wyjątek, zero okien kiedykolwiek zeskanowanych). Ciało zapytania POST nie
// ma tego ograniczenia.
async function sbRpc<T>(url: string, key: string, fn: string, args: Record<string, unknown>): Promise<T[]> {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rail_db_rpc_failed ${fn}: HTTP ${res.status}`);
  return res.json();
}

// Ta sama logika ujednoznaczniania co resolveSingleStation w index.ts (dokładne
// dopasowanie nazwy, potem przyrostek Główny/Główna/Główne) — świadomie zduplikowana
// tutaj (patrz komentarz na górze pliku), nie zaimportowana.
function pickBestStationMatch(candidates: RailStation[], query: string): RailStation | null {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  const normalizedQuery = query.trim().toLowerCase();
  const exact = candidates.filter((s) => s.name.trim().toLowerCase() === normalizedQuery);
  if (exact.length === 1) return exact[0];
  const mainSuffix = /^(glowny|glowna|glowne|główny|główna|główne)$/i;
  const main = candidates.filter((s) => {
    const name = s.name.trim().toLowerCase();
    if (!name.startsWith(normalizedQuery)) return false;
    return mainSuffix.test(name.slice(normalizedQuery.length).trim());
  });
  if (main.length === 1) return main[0];
  return null;
}

export async function resolveSingleStationLocal(url: string, key: string, query: string): Promise<StationLookup> {
  const q = query.trim();
  if (!q) return { ok: false, body: { error: "station_not_found", query: q } };
  try {
    // Realny błąd znaleziony na produkcji: dopasowanie dokładne było szukane WYŁĄCZNIE
    // wewnątrz jednego zapytania ILIKE '%q%' LIMIT 20, bez ORDER BY — dla miast z wieloma
    // stacjami podrzędnymi zawierającymi tę samą nazwę jako podciąg (np. Katowice: Ligota,
    // Piotrowice, Szopienice, Zawodzie, Brynów...), Postgres bez porządkowania zwraca
    // wiersze w praktycznie dowolnej kolejności — sama stacja "Katowice" mogła się w ogóle
    // nie zmieścić w pierwszych 20 wynikach, mimo że istniała w bazie. Zweryfikowane
    // lokalnie: dokładnie ten scenariusz odtworzony (20 podstacji + "Katowice" wstawione
    // jako ostatnie) dawał identyczny objaw — "Katowice" całkowicie nieobecne w wyniku.
    // Naprawa: osobne, ukierunkowane zapytanie o dopasowanie dokładne (ilike BEZ gwiazdek —
    // to w PostgREST oznacza pełne dopasowanie, nie podciąg) PRZED szerokim skanem
    // podciągów, więc duża liczba podstacji nigdy nie może wypchnąć właściwego wyniku.
    // Zapytanie już wymusza dokładną (bez rozróżniania wielkości liter) zgodność nazwy, więc
    // KAŻDY zwrócony wiersz ma dokładnie szukaną nazwę — różnią się co najwyżej peronem/
    // stop_id (osobne wiersze GTFS dla tego samego fizycznego przystanku). Zbieramy WSZYSTKIE
    // takie stop_id w jedną grupę (zob. komentarz przy RailStationGroup) zamiast wybierać
    // arbitralnie jeden.
    const exactRows = await sbGet<RailStation>(url, key, `rail_stops?name=ilike.${encodeURIComponent(q)}&select=id,name&limit=50`);
    if (exactRows.length) return { ok: true, station: { name: exactRows[0].name, ids: exactRows.map((r) => r.id) } };
  } catch {
    return { ok: false, body: { error: "local_lookup_failed", query: q } };
  }
  let rows: RailStation[];
  try {
    rows = await sbGet<RailStation>(url, key, `rail_stops?name=ilike.*${encodeURIComponent(q)}*&select=id,name&limit=100`);
  } catch {
    return { ok: false, body: { error: "local_lookup_failed", query: q } };
  }
  if (!rows.length) return { ok: false, body: { error: "station_not_found", query: q } };
  // Rozstrzyganie MIĘDZY różnymi nazwami po zdeduplikowanych nazwach — na surowych wierszach
  // "Katowice Ligota" liczone 4x jako 4 kandydatów łamałoby np. sprawdzenie exact.length===1
  // w pickBestStationMatch, mimo że to jedna, jednoznaczna nazwa (realny, powiązany błąd).
  const uniqueNames = [...new Set(rows.map((r) => r.name))];
  const groupIds = (name: string) => rows.filter((r) => r.name === name).map((r) => r.id);
  if (uniqueNames.length === 1) return { ok: true, station: { name: uniqueNames[0], ids: groupIds(uniqueNames[0]) } };
  const best = pickBestStationMatch(uniqueNames.map((name) => ({ id: name, name })), q);
  if (best) return { ok: true, station: { name: best.name, ids: groupIds(best.name) } };
  return { ok: false, body: { error: "ambiguous_station", query: q, candidates: uniqueNames.slice(0, 5) } };
}

// Fallback #1 z planu: brak udanego syncu, albo ostatni sukces starszy niż maxAgeHours
// (domyślnie 2x dzienny cykl syncu — toleruje jeden nieudany dzień zanim dane uznamy
// za nieaktualne) — w obu przypadkach nie ufamy lokalnym danym.
export async function hasFreshLocalData(url: string, key: string, maxAgeHours = 48): Promise<boolean> {
  try {
    const rows = await sbGet<{ finished_at: string | null }>(
      url, key,
      `rail_sync_runs?status=eq.success&order=finished_at.desc&limit=1&select=finished_at`,
    );
    const finishedAt = rows[0]?.finished_at;
    if (!finishedAt) return false;
    return Date.now() - new Date(finishedAt).getTime() < maxAgeHours * 3600 * 1000;
  } catch {
    return false;
  }
}

// --- CSA ---

type Connection = {
  trip_id: string;
  service_id: string;
  from_stop_id: string;
  to_stop_id: string;
  dep_seconds: number;
  arr_seconds: number;
};

const TRANSFER_BUFFER_SECONDS = 7 * 60; // te same 7 minut co dotychczasowa żywa heurystyka (MIN_TRANSFER_BUFFER_MIN)
const WINDOW_SECONDS = 2 * 3600;
const MAX_WINDOWS = 6; // ~12h przeszukiwania od żądanej godziny, potem poddajemy się (fallback na żywą ścieżkę)
const IN_LIST_LIMIT = 500; // praktyczny limit długości URL dla filtra in.() w PostgREST

function inList(ids: string[]): string {
  return ids.slice(0, IN_LIST_LIMIT).map((id) => `"${id}"`).join(",");
}

// Aktywne service_id na dany dzień: dzień tygodnia z rail_calendar (w zakresie
// start_date/end_date) + wyjątki z rail_calendar_dates (1=dodany, 2=usunięty).
async function activeServiceIds(url: string, key: string, date: string): Promise<Set<string> | null> {
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date(`${date}T00:00:00Z`).getUTCDay()];
  try {
    const base = await sbGet<{ id: string }>(
      url, key,
      `rail_calendar?start_date=lte.${date}&end_date=gte.${date}&${weekday}=eq.true&select=id`,
    );
    const ids = new Set(base.map((r) => r.id));
    const exceptions = await sbGet<{ service_id: string; exception_type: number }>(
      url, key,
      `rail_calendar_dates?date=eq.${date}&select=service_id,exception_type`,
    );
    for (const e of exceptions) {
      if (e.exception_type === 1) ids.add(e.service_id);
      else if (e.exception_type === 2) ids.delete(e.service_id);
    }
    return ids;
  } catch {
    return null;
  }
}

type CsaLeg = { from: string; to: string; departure: string; arrival: string; train: string };
export type CsaResult = { direct: boolean; legs: CsaLeg[] };

function secondsToHHMM(totalSeconds: number): string {
  const s = ((totalSeconds % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export type CsaDiagnostics = {
  activeServiceCount: number;
  serviceIdsInFilter: number; // ograniczone przez IN_LIST_LIMIT — jeśli < activeServiceCount, część dnia jest CICHO pomijana
  windowsScanned: number;
  connectionsScannedTotal: number;
  stationsReached: number; // ile stacji dostało policzony czas dotarcia (bez samego origin)
  connectionsFetchError?: string; // realny błąd zapytania o rail_connections, jeśli je przerwał (zob. pętla okien)
  fromGroupSize?: number; // ile stop_id wchodzi w grupę stacji startowej (zob. RailStationGroup)
  toGroupSize?: number;
  reachedStationNames?: string[]; // nazwy stacji faktycznie osiągniętych, gdy cel nie — pokazuje, GDZIE poszukiwanie realnie dotarło
  // Rzeczywiste, ZDEDUPLIKOWANE (po dep_seconds+cel) odjazdy z origin w tym samym
  // przeszukiwanym oknie, z autorytatywną flagą aktywności na tę datę policzoną w SQL
  // (zob. rail_debug_departures) — odróżnia "danych po prostu nie ma" (problem z
  // syncem/parsowaniem) od "dane są, ale ich service_id nie trafił do aktywnego zbioru na
  // ten dzień" (błąd kalendarza).
  distinctDeparturesFromOrigin?: number;
  departureSample?: { depSeconds: number; toStopId: string; serviceVariants: number; activeToday: boolean }[];
};

// Skanuje rail_connections w rosnących oknach czasowych, licząc najwcześniejszy
// możliwy czas dotarcia do każdej stacji (standardowy CSA) — z buforem przesiadkowym
// TRANSFER_BUFFER_SECONDS, chyba że kolejne połączenie to ten sam trip_id (kontynuacja
// jazdy, nie przesiadka). Wczesne zatrzymanie: gdy początek kolejnego okna przekracza
// już znaleziony czas dotarcia do celu, żadne późniejsze połączenie nie może go
// poprawić — dalsze okna są pomijane.
//
// Zwraca diagnostics ZAWSZE (nie tylko przy sukcesie) — jedyny sposób odróżnienia "trasa
// faktycznie nie istnieje w danych" od "coś po drodze cicho ucięło wynik" (np.
// IN_LIST_LIMIT=500 obcinający listę aktywnych service_id danego dnia, jeśli jest ich
// więcej — realne ryzyko dla krajowego rozkładu, nigdy wcześniej nie zmierzone).
export async function runCsaJourney(
  url: string, key: string,
  from: RailStationGroup, to: RailStationGroup, date: string, startSeconds: number,
): Promise<{ result: CsaResult | null; diagnostics: CsaDiagnostics }> {
  const emptyDiagnostics: CsaDiagnostics = {
    activeServiceCount: 0, serviceIdsInFilter: 0, windowsScanned: 0, connectionsScannedTotal: 0, stationsReached: 0,
  };
  const serviceIds = await activeServiceIds(url, key, date);
  if (!serviceIds || !serviceIds.size) return { result: null, diagnostics: emptyDiagnostics };
  const serviceIdList = [...serviceIds];

  const diagnostics: CsaDiagnostics = {
    activeServiceCount: serviceIdList.length,
    serviceIdsInFilter: serviceIdList.length, // RPC (ciało POST) — bez obcinania, zob. sbRpc
    windowsScanned: 0,
    connectionsScannedTotal: 0,
    stationsReached: 0,
    fromGroupSize: from.ids.length,
    toGroupSize: to.ids.length,
  };

  // "Stacja" to grupa stop_id (różne perony/tory dzielące tę samą nazwę) — dowolny z nich
  // jest poprawnym punktem startu/celu, zob. komentarz przy RailStationGroup.
  const fromIds = new Set(from.ids);
  const toIds = new Set(to.ids);
  const earliestArrival = new Map<string, number>(from.ids.map((id) => [id, startSeconds]));
  const arrivedViaTrip = new Map<string, string>(from.ids.map((id) => [id, "__origin__"]));
  const incoming = new Map<string, Connection>();

  let windowStart = startSeconds;
  let found = false;

  for (let w = 0; w < MAX_WINDOWS; w++) {
    const windowEnd = windowStart + WINDOW_SECONDS;
    const targetArrivals = to.ids.map((id) => earliestArrival.get(id)).filter((v): v is number => v !== undefined);
    const bestTargetArrival = targetArrivals.length ? Math.min(...targetArrivals) : undefined;
    if (bestTargetArrival !== undefined && windowStart > bestTargetArrival) break;

    let connections: Connection[];
    try {
      connections = await sbRpc<Connection>(url, key, "rail_connections_in_window", {
        p_service_ids: serviceIdList,
        p_dep_from: windowStart,
        p_dep_to: windowEnd,
      });
    } catch (e) {
      return { result: null, diagnostics: { ...diagnostics, connectionsFetchError: String(e) } };
    }
    diagnostics.windowsScanned++;
    diagnostics.connectionsScannedTotal += connections.length;

    for (const c of connections) {
      const arrAtFrom = earliestArrival.get(c.from_stop_id);
      if (arrAtFrom === undefined) continue;
      const sameTrip = arrivedViaTrip.get(c.from_stop_id) === c.trip_id;
      const boardable = fromIds.has(c.from_stop_id)
        ? c.dep_seconds >= arrAtFrom
        : (sameTrip ? c.dep_seconds >= arrAtFrom : c.dep_seconds >= arrAtFrom + TRANSFER_BUFFER_SECONDS);
      if (!boardable) continue;

      const known = earliestArrival.get(c.to_stop_id);
      if (known === undefined || c.arr_seconds < known) {
        earliestArrival.set(c.to_stop_id, c.arr_seconds);
        arrivedViaTrip.set(c.to_stop_id, c.trip_id);
        incoming.set(c.to_stop_id, c);
        if (toIds.has(c.to_stop_id)) found = true;
      }
    }

    if (found) break;
    windowStart = windowEnd;
  }
  diagnostics.stationsReached = Math.max(0, earliestArrival.size - from.ids.length);

  // Spośród ewentualnie wielu peronów celu wybierz ten z najwcześniejszym dotarciem.
  const reachedToId = to.ids
    .filter((id) => earliestArrival.has(id))
    .sort((a, b) => earliestArrival.get(a)! - earliestArrival.get(b)!)[0];
  if (!reachedToId) {
    // Nazwy stacji, do których poszukiwanie faktycznie dotarło (poza samym origin) — jeśli
    // cel nigdy się nie pojawił, to pokazuje WPROST, gdzie realnie sięgnęło (garstka bliskich
    // stacji na jednym kursie? cała okolica? zupełnie inny region?), zamiast samej liczby.
    const reachedIds = [...earliestArrival.keys()].filter((id) => !fromIds.has(id)).slice(0, 15);
    if (reachedIds.length) {
      try {
        const nameRows = await sbGet<RailStation>(url, key, `rail_stops?id=in.(${inList(reachedIds)})&select=id,name`);
        diagnostics.reachedStationNames = nameRows.map((r) => r.name);
      } catch { /* diagnostyka opcjonalna — nie blokuj samego wyniku */ }
    }
    try {
      // Pierwsza wersja tej diagnostyki (prosty SELECT bez agregacji) utykała na kursach
      // sprzed świtu — ten feed nie ma calendar.txt, więc KAŻDY dzień działania kursu to
      // osobny wiersz rail_calendar/service_id, a "LIMIT 50 ORDER BY dep_seconds" wyczerpywał
      // się na dziesiątkach wariantów TEGO SAMEGO porannego kursu, zanim doszedł do
      // czegokolwiek później niż ~4:15. rail_debug_departures (RPC, zob. migracja) grupuje
      // po (dep_seconds, to_stop_id), więc pokazuje każdy FIZYCZNY kurs raz, z flagą "czy
      // KTÓRYKOLWIEK jego wariant service_id jest aktywny na ten dzień" policzoną w SQL tą
      // samą logiką co activeServiceIds() — sięga więc realnie przez cały dzień, nie tylko
      // pierwsze kilkadziesiąt zdublowanych wierszy.
      const windowEndAll = startSeconds + MAX_WINDOWS * WINDOW_SECONDS;
      const debugDepartures = await sbRpc<{ dep_seconds: number; to_stop_id: string; distinct_service_variants: number; any_active_today: boolean }>(
        url, key, "rail_debug_departures",
        { p_stop_ids: from.ids, p_date: date, p_dep_from: startSeconds, p_dep_to: windowEndAll },
      );
      diagnostics.distinctDeparturesFromOrigin = debugDepartures.length;
      const toSample = (d: typeof debugDepartures[number]) => ({
        depSeconds: d.dep_seconds, toStopId: d.to_stop_id,
        serviceVariants: d.distinct_service_variants, activeToday: d.any_active_today,
      });
      // Posortowane rosnąco po dep_seconds — same pierwsze 20 to zawsze to samo pasmo
      // sprzed świtu (zob. komentarz wyżej). OSTATNIE 10 pokazuje, jak daleko w czasie
      // zapytanie FAKTYCZNIE dotarło zanim uderzyło w LIMIT — to jest tu najważniejsze.
      diagnostics.departureSample = [
        ...debugDepartures.slice(0, 10).map(toSample),
        ...debugDepartures.slice(-10).map(toSample),
      ];
    } catch { /* diagnostyka opcjonalna — nie blokuj samego wyniku */ }
    return { result: null, diagnostics };
  }

  // Odtwórz ścieżkę wstecz przez incoming, potem odwróć.
  const chain: Connection[] = [];
  let cursor = reachedToId;
  while (!fromIds.has(cursor)) {
    const c = incoming.get(cursor);
    if (!c) return { result: null, diagnostics }; // bezpiecznik — nie powinno się zdarzyć, skoro earliestArrival ma wpis
    chain.push(c);
    cursor = c.from_stop_id;
  }
  chain.reverse();
  if (!chain.length) return { result: null, diagnostics };

  // Zgrupuj kolejne połączenia tego samego trip_id w jedną "nogę" (kurs), reszta to przesiadki.
  const legsRaw: { tripId: string; from: string; to: string; depSeconds: number; arrSeconds: number }[] = [];
  for (const c of chain) {
    const last = legsRaw[legsRaw.length - 1];
    if (last && last.tripId === c.trip_id) {
      last.to = c.to_stop_id;
      last.arrSeconds = c.arr_seconds;
    } else {
      legsRaw.push({ tripId: c.trip_id, from: c.from_stop_id, to: c.to_stop_id, depSeconds: c.dep_seconds, arrSeconds: c.arr_seconds });
    }
  }

  // Nazwy stacji + etykieta pociągu (trip.short_name, z fallbackiem na route.short_name)
  // — po jednym zbiorczym zapytaniu na wszystkie zaangażowane ID, nie per-noga.
  const stopIds = [...new Set(legsRaw.flatMap((l) => [l.from, l.to]))];
  const tripIds = [...new Set(legsRaw.map((l) => l.tripId))];
  let stopRows: RailStation[] = [];
  let tripRows: { id: string; short_name: string | null; route_id: string }[] = [];
  try {
    [stopRows, tripRows] = await Promise.all([
      sbGet<RailStation>(url, key, `rail_stops?id=in.(${inList(stopIds)})&select=id,name`),
      sbGet<{ id: string; short_name: string | null; route_id: string }>(url, key, `rail_trips?id=in.(${inList(tripIds)})&select=id,short_name,route_id`),
    ]);
  } catch {
    return { result: null, diagnostics };
  }
  const stopName = new Map(stopRows.map((s) => [s.id, s.name]));
  const tripInfo = new Map(tripRows.map((t) => [t.id, t]));
  const routeIds = [...new Set(tripRows.map((t) => t.route_id))];
  let routeShortName = new Map<string, string | null>();
  if (routeIds.length) {
    try {
      const routeRows = await sbGet<{ id: string; short_name: string | null }>(url, key, `rail_routes?id=in.(${inList(routeIds)})&select=id,short_name`);
      routeShortName = new Map(routeRows.map((r) => [r.id, r.short_name]));
    } catch { /* etykieta pociągu spadnie na "?" — nie blokuje wyniku */ }
  }

  const legs: CsaLeg[] = legsRaw.map((l) => {
    const trip = tripInfo.get(l.tripId);
    const train = trip?.short_name || (trip ? routeShortName.get(trip.route_id) : null) || "?";
    return {
      from: stopName.get(l.from) ?? l.from,
      to: stopName.get(l.to) ?? l.to,
      departure: secondsToHHMM(l.depSeconds),
      arrival: secondsToHHMM(l.arrSeconds),
      train,
    };
  });

  return { result: { direct: legs.length === 1, legs }, diagnostics };
}
