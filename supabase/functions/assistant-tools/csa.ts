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
type StationLookup = { ok: true; station: RailStation } | { ok: false; body: Record<string, unknown> };

async function sbGet<T>(url: string, key: string, path: string): Promise<T[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`rail_db_get_failed ${path}: HTTP ${res.status}`);
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
    // stop_id (osobne wiersze GTFS dla tego samego fizycznego przystanku), nie znaczeniem.
    // pickBestStationMatch nie pasuje tutaj (rozstrzyga MIĘDZY różnymi nazwami, nie
    // WEWNĄTRZ identycznych) — pierwszy wiersz jest równie dobrym punktem zaczepienia jak
    // każdy inny.
    const exactRows = await sbGet<RailStation>(url, key, `rail_stops?name=ilike.${encodeURIComponent(q)}&select=id,name&limit=5`);
    if (exactRows.length) return { ok: true, station: exactRows[0] };
  } catch {
    return { ok: false, body: { error: "local_lookup_failed", query: q } };
  }
  let rows: RailStation[];
  try {
    rows = await sbGet<RailStation>(url, key, `rail_stops?name=ilike.*${encodeURIComponent(q)}*&select=id,name&limit=20`);
  } catch {
    return { ok: false, body: { error: "local_lookup_failed", query: q } };
  }
  if (!rows.length) return { ok: false, body: { error: "station_not_found", query: q } };
  if (rows.length === 1) return { ok: true, station: rows[0] };
  const best = pickBestStationMatch(rows, q);
  if (best) return { ok: true, station: best };
  return { ok: false, body: { error: "ambiguous_station", query: q, candidates: rows.slice(0, 5).map((s) => s.name) } };
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

// Skanuje rail_connections w rosnących oknach czasowych, licząc najwcześniejszy
// możliwy czas dotarcia do każdej stacji (standardowy CSA) — z buforem przesiadkowym
// TRANSFER_BUFFER_SECONDS, chyba że kolejne połączenie to ten sam trip_id (kontynuacja
// jazdy, nie przesiadka). Wczesne zatrzymanie: gdy początek kolejnego okna przekracza
// już znaleziony czas dotarcia do celu, żadne późniejsze połączenie nie może go
// poprawić — dalsze okna są pomijane.
export async function runCsaJourney(
  url: string, key: string,
  from: RailStation, to: RailStation, date: string, startSeconds: number,
): Promise<CsaResult | null> {
  const serviceIds = await activeServiceIds(url, key, date);
  if (!serviceIds || !serviceIds.size) return null;
  const serviceFilter = inList([...serviceIds]);
  if (!serviceFilter) return null;

  const earliestArrival = new Map<string, number>([[from.id, startSeconds]]);
  const arrivedViaTrip = new Map<string, string>([[from.id, "__origin__"]]);
  const incoming = new Map<string, Connection>();

  let windowStart = startSeconds;
  let found = false;

  for (let w = 0; w < MAX_WINDOWS; w++) {
    const windowEnd = windowStart + WINDOW_SECONDS;
    const targetArrival = earliestArrival.get(to.id);
    if (targetArrival !== undefined && windowStart > targetArrival) break;

    let connections: Connection[];
    try {
      connections = await sbGet<Connection>(
        url, key,
        `rail_connections?service_id=in.(${serviceFilter})&dep_seconds=gte.${windowStart}&dep_seconds=lt.${windowEnd}` +
          `&order=dep_seconds.asc&limit=5000&select=trip_id,service_id,from_stop_id,to_stop_id,dep_seconds,arr_seconds`,
      );
    } catch {
      return null;
    }

    for (const c of connections) {
      const arrAtFrom = earliestArrival.get(c.from_stop_id);
      if (arrAtFrom === undefined) continue;
      const sameTrip = arrivedViaTrip.get(c.from_stop_id) === c.trip_id;
      const boardable = c.from_stop_id === from.id
        ? c.dep_seconds >= arrAtFrom
        : (sameTrip ? c.dep_seconds >= arrAtFrom : c.dep_seconds >= arrAtFrom + TRANSFER_BUFFER_SECONDS);
      if (!boardable) continue;

      const known = earliestArrival.get(c.to_stop_id);
      if (known === undefined || c.arr_seconds < known) {
        earliestArrival.set(c.to_stop_id, c.arr_seconds);
        arrivedViaTrip.set(c.to_stop_id, c.trip_id);
        incoming.set(c.to_stop_id, c);
        if (c.to_stop_id === to.id) found = true;
      }
    }

    if (found) break;
    windowStart = windowEnd;
  }

  if (!earliestArrival.has(to.id)) return null;

  // Odtwórz ścieżkę wstecz przez incoming, potem odwróć.
  const chain: Connection[] = [];
  let cursor = to.id;
  while (cursor !== from.id) {
    const c = incoming.get(cursor);
    if (!c) return null; // bezpiecznik — nie powinno się zdarzyć, skoro earliestArrival ma wpis
    chain.push(c);
    cursor = c.from_stop_id;
  }
  chain.reverse();
  if (!chain.length) return null;

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
    return null;
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

  return { direct: legs.length === 1, legs };
}
