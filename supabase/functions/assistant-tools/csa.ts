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

// Ta sama odpowiedź co dawne StationLookup, plus informacja diagnostyczna JAK stacja została
// rozstrzygnięta — pomocne w logach (zob. rail_local_entry/skip w index.ts) przy
// weryfikacji, czy AI faktycznie trafia w "Katowice Główny", czy ląduje w bezpieczniku.
export type SmartStationLookup =
  | { ok: true; station: RailStationGroup; resolvedVia: "single_candidate" | "ai" | "ai_fallback_connectivity"; aiRawPick?: string | null }
  | { ok: false; body: Record<string, unknown> };

// Jedno, lekkie wywołanie Gemini (bez narzędzi, sam tekst) do wyboru "sensownej" stacji
// spośród kilku kandydatek o TEJ SAMEJ nazwie-podciągu — celowo osobne od głównej pętli
// rozmowy w zadarma-sms-webhook (ten plik jest samodzielny, zob. komentarz na górze).
async function askGeminiForStationPick(geminiKey: string, query: string, candidateNames: string[]): Promise<string | null> {
  const prompt = `Użytkownik szuka stacji kolejowej w Polsce: "${query}".
Kandydaci (dokładne nazwy stacji istniejące w bazie rozkładu PKP): ${candidateNames.map((n) => `"${n}"`).join(", ")}.

Zasada wyboru:
- Jeśli zapytanie użytkownika już wprost wskazuje KONKRETNĄ stację (np. dzielnicę/część
  miasta, jak "Wrocław Kuźniki"), wybierz DOKŁADNIE TĘ, literalnie.
- W przeciwnym razie (zapytanie to ogólna nazwa miasta) wybierz NAJWIĘKSZĄ/GŁÓWNĄ stację
  tego miasta — zwykle tę z dopiskiem "Główny"/"Główna"/"Dworzec Główny", obsługującą
  najwięcej połączeń dalekobieżnych, NIE małe przystanki lokalne/podmiejskie.

Odpowiedz WYŁĄCZNIE dokładną nazwą jednego kandydata z powyższej listy, bez cudzysłowów,
bez żadnego dodatkowego tekstu ani wyjaśnienia.`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const parts: Array<{ text?: string }> = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("").trim();
    return text || null;
  } catch {
    return null;
  }
}

// Bezpiecznik: kandydat z NAJWIĘKSZĄ liczbą zapisanych odjazdów w rail_connections —
// tanie, czysto danowe przybliżenie "największej/głównej stacji", używane gdy AI
// zawiedzie (błąd sieci/klucza) albo jego odpowiedź nie zgadza się z żadnym kandydatem
// (halucynacja) — zob. migracja rail_station_candidate_stats.
async function pickCandidateByConnectivity(
  url: string, key: string, uniqueNames: string[], rows: RailStation[],
): Promise<string> {
  const groupIds = (name: string) => rows.filter((r) => r.name === name).map((r) => r.id);
  try {
    const allIds = rows.map((r) => r.id);
    const stats = await sbRpc<{ stop_id: string; departure_count: number }>(
      url, key, "rail_station_candidate_stats", { p_stop_ids: allIds },
    );
    const countByStopId = new Map(stats.map((s) => [s.stop_id, s.departure_count]));
    let bestName = uniqueNames[0];
    let bestCount = -1;
    for (const name of uniqueNames) {
      const total = groupIds(name).reduce((sum, id) => sum + (countByStopId.get(id) ?? 0), 0);
      if (total > bestCount) { bestCount = total; bestName = name; }
    }
    return bestName;
  } catch {
    return uniqueNames[0]; // ostateczny bezpiecznik — zapytanie o statystyki też zawiodło
  }
}

// Wybór stacji, gdy zapytanie to NAZWA MIASTA obejmująca kilka realnych stacji (np.
// "Katowice" -> "Katowice", "Katowice Główny", "Katowice Ligota", ...): zamiast
// heurystyki string-matchingu (dawne resolveSingleStationLocal — patrz komentarz przy
// exactRows wyżej, realny błąd: dokładne dopasowanie "Katowice" krótkie spięcie zwracało
// małą, podrzędną stację, zanim w ogóle sprawdzono istnienie "Katowice Główny"), pytamy
// AI o wybór "sensownej" (największej) stacji — z deterministycznym bezpiecznikiem po
// liczbie połączeń, gdyby AI zawiodło albo zhalucynowało nazwę spoza kandydatów.
export async function resolveStationGroupSmart(
  url: string, key: string, geminiKey: string | undefined, query: string,
): Promise<SmartStationLookup> {
  const q = query.trim();
  if (!q) return { ok: false, body: { error: "station_not_found", query: q } };
  let rows: RailStation[];
  try {
    rows = await sbGet<RailStation>(url, key, `rail_stops?name=ilike.*${encodeURIComponent(q)}*&select=id,name&limit=200`);
  } catch {
    return { ok: false, body: { error: "local_lookup_failed", query: q } };
  }
  if (!rows.length) return { ok: false, body: { error: "station_not_found", query: q } };

  const uniqueNames = [...new Set(rows.map((r) => r.name))];
  const groupIds = (name: string) => rows.filter((r) => r.name === name).map((r) => r.id);

  // Szybka ścieżka: jedna odrębna nazwa wśród kandydatów -> użyj jej wprost, bez
  // wywołania AI (pokrywa np. "Wrocław Kuźniki": jedno trafienie, koniec).
  if (uniqueNames.length === 1) {
    return { ok: true, station: { name: uniqueNames[0], ids: groupIds(uniqueNames[0]) }, resolvedVia: "single_candidate" };
  }

  if (geminiKey) {
    const aiPick = await askGeminiForStationPick(geminiKey, q, uniqueNames);
    const normalizedPick = aiPick?.trim();
    const matched = normalizedPick ? uniqueNames.find((n) => n.trim().toLowerCase() === normalizedPick.toLowerCase()) : undefined;
    if (matched) {
      return { ok: true, station: { name: matched, ids: groupIds(matched) }, resolvedVia: "ai", aiRawPick: aiPick };
    }
    const fallbackName = await pickCandidateByConnectivity(url, key, uniqueNames, rows);
    return { ok: true, station: { name: fallbackName, ids: groupIds(fallbackName) }, resolvedVia: "ai_fallback_connectivity", aiRawPick: aiPick };
  }

  // Brak klucza Gemini w środowisku assistant-tools -- ten sam bezpiecznik po liczbie
  // połączeń, bez próby wywołania AI.
  const fallbackName = await pickCandidateByConnectivity(url, key, uniqueNames, rows);
  return { ok: true, station: { name: fallbackName, ids: groupIds(fallbackName) }, resolvedVia: "ai_fallback_connectivity" };
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

// Sensowne przesiadki (wymóg użytkownika): między przyjazdem a kolejnym odjazdem na
// KAŻDEJ przesiadce (nie tylko pierwszej) musi minąć od 30 minut do 4 godzin. To OSOBNA
// reguła od okna startowego (zob. originWindowStart/End w runCsaJourney) — może przesunąć
// dalsze nogi trasy daleko poza okno pierwszego odjazdu.
const TRANSFER_BUFFER_SECONDS = 30 * 60;
const MAX_TRANSFER_WAIT_SECONDS = 4 * 3600;
// Całkowity zasięg skanowania: BŁĘDNIE liczony wcześniej jako okno startowe (4h) + do 3
// przesiadek × do 4h OCZEKIWANIA każda = ~20h — to pomijało, że 4h to limit samej
// PRZESIADKI (oczekiwania), nie długości odcinka jazdy. Sam odcinek (pociąg między
// kolejnymi przesiadkami) może jechać wiele godzin niezależnie od tego limitu — przy 3
// przesiadkach i długich odcinkach realny łączny czas podróży może sięgać ~50h. Stąd
// WINDOW_SECONDS(2h) × MAX_WINDOWS(25) = 50h, nie 20h.
//
// REALNY BŁĄD z produkcji (pierwszy test po wdrożeniu tego kroku, Katowice->Zamość):
// próba z WINDOW_SECONDS=4h dała connectionsScannedTotal DOKŁADNIE 5000 — równe twardemu
// LIMIT w rail_connections_in_window (zob. migracja), który nie filtruje po stacji, tylko
// zwraca CAŁY krajowy rozkład w oknie dla ~667 aktywnych service_id. Podwojenie okna z 2h
// na 4h najwyraźniej po raz pierwszy realnie w ten limit uderzyło, obcinając dane
// (sortowanie po dep_seconds ASC ucina PÓŹNIEJszą część okna) zanim CSA zdążyło zobaczyć
// właściwe połączenia z Katowic. Naprawa: węższe okna (2h, jak w poprzedniej, znanej
// działającej wersji) — mniej ryzyka ucięcia pojedynczego zapytania niż przy 4h.
const WINDOW_SECONDS = 2 * 3600;
// Realny wynik z produkcji (po filtrowaniu po frontierze, poprzedni commit): frontier rósł
// do 732 stacji, ale budżet 25 zapytań RPC wyczerpał się wcześniej niż pełne 50h skanu --
// każda iteracja ustalania punktu stałego W OBRĘBIE JEDNEGO okna zużywa osobne zapytanie z
// tego samego budżetu, więc gdy frontier rósł szybko (typowe dla wczesnych okien), kilka
// zapytań szło na DOPRECYZOWANIE jednego logicznego okna czasowego zamiast na pokrycie
// kolejnych. Pojedyncze zapytanie samo w sobie jest tanie (RPC, nie CPU-bound) -- podniesiony
// limit to więcej sekwencyjnych round-tripów, nie więcej pracy JS.
const MAX_WINDOWS = 60; // twardy limit LICZBY zapytań RPC (niezależnie od liczby dni), zob. komentarz w runCsaJourney
// Zabezpieczenie pętli ustalania punktu stałego WEWNĄTRZ jednego okna (zob. komentarz przy
// p_from_stop_ids w runCsaJourney) -- w praktyce powinno zbiegać w 1-2 iteracjach (mało
// połączeń w oknie faktycznie dotyczy aktualnego frontieru), to tylko twardy sufit.
const MAX_SETTLE_ITERATIONS_PER_WINDOW = 5;
// Łączny zasięg CZASOWY (absolutny, od originWindowStart) — 50h, bo 4h to limit samej
// przesiadki (oczekiwania), nie długości odcinka jazdy między przesiadkami (ten może trwać
// wiele godzin niezależnie od tego limitu).
const TOTAL_SCAN_SECONDS = 50 * 3600;
// Ten feed nie ma calendar.txt — KAŻDY dzień działania kursu to OSOBNY service_id
// (zob. activeServiceIds). dep_seconds/arr_seconds w rail_connections są parsowane WPROST
// z GTFS HH:MM:SS (bez modulo 24h) — kurs przechodzący północ ma np. arr_seconds=27:15,
// ale WCIĄŻ pod service_id dnia POPRZEDNIEGO ("extended time", standardowa konwencja
// GTFS). Realistycznie taki "extended" zasięg rzadko przekracza ~28-30h lokalnie — dalej
// szukać sensu nie ma, bo to już będzie po prostu NASTĘPNY dzień z WŁASNYM service_id
// (zob. pętla dayOffset w runCsaJourney).
const EXTENDED_DAY_CEILING_SECONDS = 30 * 3600;
const IN_LIST_LIMIT = 500; // praktyczny limit długości URL dla filtra in.() w PostgREST

function inList(ids: string[]): string {
  return ids.slice(0, IN_LIST_LIMIT).map((id) => `"${id}"`).join(",");
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
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
  // Liczba połączeń zwróconych PRZEZ KAŻDE pojedyncze okno — realny błąd na produkcji
  // (zob. komentarz przy WINDOW_SECONDS) był widoczny tylko jako podejrzanie okrągła
  // SUMA równa twardemu limitowi RPC; ta lista pozwala odróżnić "jedno okno ucięte przez
  // limit" od "kilka okien złożyło się na tę sumę" bez zgadywania.
  windowConnectionCounts?: number[];
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
// originWindowStart/originWindowEnd: okno (typowo 4h), w którym wolno wsiąść NA STACJI
// STARTOWEJ (pierwszy odjazd) — NIE ogranicza to całej trasy. Każda KOLEJNA przesiadka
// rządzi się osobno regułą TRANSFER_BUFFER_SECONDS..MAX_TRANSFER_WAIT_SECONDS (30min-4h),
// niezależną od tego okna — użytkownik wprost poprawił wcześniejsze (błędne) rozumienie,
// że 4h miałoby ograniczać całą podróż.
export async function runCsaJourney(
  url: string, key: string,
  from: RailStationGroup, to: RailStationGroup, date: string,
  originWindowStart: number, originWindowEnd: number,
): Promise<{ result: CsaResult | null; diagnostics: CsaDiagnostics }> {
  const emptyDiagnostics: CsaDiagnostics = {
    activeServiceCount: 0, serviceIdsInFilter: 0, windowsScanned: 0, connectionsScannedTotal: 0, stationsReached: 0,
  };
  // Dzień 0 (data podróży) musi mieć aktywne service_id, inaczej nie ma czego szukać —
  // KOLEJNE dni (zob. pętla dayOffset niżej) mogą wypaść puste bez przerywania całego
  // wyszukiwania (np. dzień świąteczny bez kursów, ale dzień po nim już z kursami).
  const day0ServiceIds = await activeServiceIds(url, key, date);
  if (!day0ServiceIds || !day0ServiceIds.size) return { result: null, diagnostics: emptyDiagnostics };

  const diagnostics: CsaDiagnostics = {
    activeServiceCount: day0ServiceIds.size,
    serviceIdsInFilter: day0ServiceIds.size, // RPC (ciało POST) — bez obcinania, zob. sbRpc
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
  const earliestArrival = new Map<string, number>(from.ids.map((id) => [id, originWindowStart]));
  const incoming = new Map<string, Connection>();
  // Realny błąd znaleziony na produkcji: śledzenie "przez jaki trip_id dotarliśmy do stacji"
  // JAKO WŁAŚCIWOŚĆ STACJI (poprzednie arrivedViaTrip: Map<stopId, tripId>, ustawiane TYLKO
  // gdy dana przesiadka poprawiała earliestArrival celu) gubiło kontynuację kursu za każdym
  // razem, gdy INNY, także osiągalny kurs dojeżdżał do tego samego przystanku pośredniego
  // ułamek sekundy wcześniej — w węźle tak gęstym jak Katowice (wiele linii z tej samej
  // stacji zbiegających się na tym samym najbliższym przystanku) to normalna sytuacja, nie
  // wyjątek: skutek był taki, że KAŻDY kurs z Katowic "gubił się" dokładnie po pierwszym
  // przystanku, bo jego WŁASNA kontynuacja przestawała się liczyć jako "ten sam trip" (inny
  // kurs "wygrywał" earliestArrival tego przystanku), a jego naturalny, kilkuminutowy postój
  // nie mieścił się w regule przesiadki (min. 30 min) — algorytm nigdy nie docierał dalej niż
  // jeden przystanek od żadnej stacji. Standardowy CSA (Dibbelt i in.) śledzi to NIEZALEŻNIE
  // od stacji: boardedTrips to zbiór trip_id, na które już "wsiedliśmy" GDZIEKOLWIEK — raz
  // wsiadłszy, KAŻDA kolejna noga tego kursu jest automatycznie dopuszczalna (czasy GTFS
  // wzdłuż trasy jednego kursu są z definicji rosnące), niezależnie od tego, czy jakiś inny
  // kurs "wygrał" earliestArrival danego przystanku pośredniego.
  const boardedTrips = new Set<string>();
  // Powiązany błąd (odtwarzanie trasy): earliestArrival/incoming śledzą NAJSZYBSZE dotarcie
  // do STACJI, więc gdyby odtwarzanie trasy wstecz szło przez incoming.get(stacja_pośrednia),
  // mogłoby "przeskoczyć" na inny, szybszy, ale NIEZWIĄZANY kurs, który tę stację wygrał —
  // pokazując fantomową przesiadkę (np. poniżej 30-minutowego minimum) zamiast prawdziwej
  // kontynuacji. predecessorOf śledzi poprzednika NA POZIOMIE KONKRETNEGO POŁĄCZENIA (nie
  // stacji): dla kontynuacji kursu — poprzednie połączenie TEGO SAMEGO trip_id (lastTripConnection);
  // dla świeżego wsiadania (origin/przesiadka) — connection z incoming dla stacji startowej.
  const lastTripConnection = new Map<string, Connection>();
  const predecessorOf = new Map<string, Connection | null>();
  const connKey = (c: Connection) => `${c.trip_id}|${c.from_stop_id}|${c.dep_seconds}`;
  // Pętla ustalania punktu stałego wewnątrz okna (zob. p_from_stop_ids niżej) odpytuje TEN
  // SAM przedział czasu wielokrotnie z rosnącym frontierem — bez deduplikacji to samo
  // połączenie mogłoby zostać przetworzone DRUGI raz PO TYM, jak jego trip_id trafił już do
  // boardedTrips, co ustawiałoby predecessorOf na SAMO SIEBIE (nieskończona pętla przy
  // odtwarzaniu trasy) — realny błąd znaleziony przy weryfikacji tej optymalizacji.
  const processedConnKeys = new Set<string>();

  let found = false;
  const windowConnectionCounts: number[] = [];
  const maxDayOffset = Math.floor((originWindowStart + TOTAL_SCAN_SECONDS) / 86400);

  // Zewnętrzna pętla PO DNIACH KALENDARZOWYCH (dayOffset=0 to data podróży), wewnętrzna —
  // po 2h oknach WEWNĄTRZ danego dnia (sekundy LOKALNE dla service_id tego dnia, 0..30h
  // żeby objąć "extended time" kursy przechodzące północ). Bez tego rozbicia szerszy
  // zasięg 50h byłby bezużyteczny: samo poszerzenie liczbowego okna na service_id DNIA 0
  // nigdy nie znajdzie kursu, który zaczyna się DOPIERO następnego dnia (świeży poranny
  // pociąg ma WŁASNY, inny service_id) — dokładnie to przeoczenie w poprzedniej wersji.
  dayLoop:
  for (let dayOffset = 0; dayOffset <= maxDayOffset; dayOffset++) {
    let daySvcIds: Set<string> | null;
    if (dayOffset === 0) {
      daySvcIds = day0ServiceIds;
    } else {
      daySvcIds = await activeServiceIds(url, key, addDaysToDateStr(date, dayOffset));
    }
    if (!daySvcIds || !daySvcIds.size) continue; // ten dzień bez aktywnych kursów — nie przerywaj całego skanu
    const daySvcList = [...daySvcIds];
    const dayAbsBase = dayOffset * 86400;

    let localStart = dayOffset === 0 ? originWindowStart : 0;
    while (localStart < EXTENDED_DAY_CEILING_SECONDS) {
      const absStart = dayAbsBase + localStart;
      if (absStart >= originWindowStart + TOTAL_SCAN_SECONDS) break dayLoop;
      if (diagnostics.windowsScanned >= MAX_WINDOWS) break dayLoop; // twardy limit liczby zapytań RPC

      const targetArrivals = to.ids.map((id) => earliestArrival.get(id)).filter((v): v is number => v !== undefined);
      const bestTargetArrival = targetArrivals.length ? Math.min(...targetArrivals) : undefined;
      if (bestTargetArrival !== undefined && absStart > bestTargetArrival) break dayLoop;

      const localEnd = localStart + WINDOW_SECONDS;
      // p_from_stop_ids: frontier CSA (stacje aktualnie osiągalne) -- realny problem
      // wydajnościowy na produkcji: bez tego filtra każde okno zwracało CAŁY krajowy
      // rozkład w tym przedziale czasu, z czego niemal wszystko niezwiązane z aktualnie
      // osiągalnymi stacjami. Ten sam limit wierszy filtrowany po stronie serwera pokrywa
      // dużo większy, użyteczny zasięg eksploracyjny.
      //
      // REALNY BŁĄD znaleziony PRZY WERYFIKACJI tej optymalizacji (test lokalny): stacja
      // odkryta DOPIERO w trakcie przetwarzania TEGO okna nie mogła trafić do filtra
      // zapytania, które JUŻ POSZŁO (migawka frontieru sprzed zapytania) -- a KOLEJNE okno
      // obejmuje już PÓŹNIEJSZY przedział dep_seconds, więc jej własne połączenia w TYM
      // przedziale czasu nigdy nie zostałyby odpytane -- TRWAŁA utrata (nie tylko
      // opóźnienie), nie sam "brak optymalizacji". Naprawa: pętla ustalania punktu stałego
      // WEWNĄTRZ okna -- odpytuj ponownie z powiększonym frontierem, dopóki frontier
      // faktycznie rośnie (albo do MAX_SETTLE_ITERATIONS_PER_WINDOW jako zabezpieczenia).
      let lastFrontierSize = -1;
      for (let settleIter = 0; settleIter < MAX_SETTLE_ITERATIONS_PER_WINDOW; settleIter++) {
        const frontierSnapshot = [...earliestArrival.keys()];
        if (frontierSnapshot.length === lastFrontierSize) break; // punkt stały dla TEGO okna
        lastFrontierSize = frontierSnapshot.length;
        if (diagnostics.windowsScanned >= MAX_WINDOWS) break dayLoop; // twardy limit liczby zapytań RPC

        let connections: Connection[];
        try {
          connections = await sbRpc<Connection>(url, key, "rail_connections_in_window", {
            p_service_ids: daySvcList,
            p_dep_from: localStart,
            p_dep_to: localEnd,
            p_from_stop_ids: frontierSnapshot,
          });
        } catch (e) {
          return { result: null, diagnostics: { ...diagnostics, connectionsFetchError: String(e) } };
        }
        diagnostics.windowsScanned++;
        diagnostics.connectionsScannedTotal += connections.length;
        windowConnectionCounts.push(connections.length);

        for (const raw of connections) {
          // RPC zwraca sekundy LOKALNE dla dayOffset (0 = data podróży) — przeliczamy na
          // ABSOLUTNE (względem originWindowStart dnia 0), żeby earliestArrival i reguły
          // przesiadek porównywały się poprawnie MIĘDZY dniami.
          const c: Connection = { ...raw, dep_seconds: raw.dep_seconds + dayAbsBase, arr_seconds: raw.arr_seconds + dayAbsBase };
          const key = connKey(c);
          if (processedConnKeys.has(key)) continue; // już przetworzone w poprzedniej iteracji ustalania punktu stałego
          processedConnKeys.add(key);
          let boardable: boolean;
          let predecessor: Connection | null;
          if (boardedTrips.has(c.trip_id)) {
            // Kontynuacja kursu, na który już GDZIEKOLWIEK wsiedliśmy — zawsze dopuszczalna,
            // bez dodatkowego bufora (to nie przesiadka), niezależnie od earliestArrival tej
            // konkretnej stacji pośredniej (zob. komentarz przy boardedTrips wyżej). Poprzednik
            // to POPRZEDNIE połączenie TEGO SAMEGO kursu (nie "najszybsze dotarcie" do stacji).
            boardable = true;
            predecessor = lastTripConnection.get(c.trip_id) ?? null;
          } else {
            const arrAtFrom = earliestArrival.get(c.from_stop_id);
            if (arrAtFrom === undefined) continue;
            // Boarding na stacji STARTOWEJ: tylko w oknie originWindowStart..originWindowEnd
            // (pierwszy odjazd). Boarding na PRZESIADCE: osobna reguła 30min-4h, niezależna
            // od okna startowego (może przesunąć dalsze nogi daleko poza nie).
            boardable = fromIds.has(c.from_stop_id)
              ? (c.dep_seconds >= arrAtFrom && c.dep_seconds < originWindowEnd)
              : (c.dep_seconds >= arrAtFrom + TRANSFER_BUFFER_SECONDS && c.dep_seconds <= arrAtFrom + MAX_TRANSFER_WAIT_SECONDS);
            predecessor = fromIds.has(c.from_stop_id) ? null : (incoming.get(c.from_stop_id) ?? null);
          }
          if (!boardable) continue;
          boardedTrips.add(c.trip_id);
          lastTripConnection.set(c.trip_id, c);
          predecessorOf.set(key, predecessor);

          const known = earliestArrival.get(c.to_stop_id);
          if (known === undefined || c.arr_seconds < known) {
            earliestArrival.set(c.to_stop_id, c.arr_seconds);
            incoming.set(c.to_stop_id, c);
            if (toIds.has(c.to_stop_id)) found = true;
          }
        }

        if (found) break dayLoop;
      }
      localStart = localEnd;
    }
  }
  diagnostics.stationsReached = Math.max(0, earliestArrival.size - from.ids.length);
  diagnostics.windowConnectionCounts = windowConnectionCounts;

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
      // rail_debug_departures liczy aktywność dla JEDNEJ daty (p_date) — ma więc sens tylko
      // w zasięgu lokalnych sekund dnia 0 (do EXTENDED_DAY_CEILING_SECONDS), nie całego
      // wielodniowego skanu (zob. pętla dayOffset wyżej) — to tylko diagnostyka pomocnicza
      // dla origin, nie pełny obraz.
      const debugDepartures = await sbRpc<{ dep_seconds: number; to_stop_id: string; distinct_service_variants: number; any_active_today: boolean }>(
        url, key, "rail_debug_departures",
        { p_stop_ids: from.ids, p_date: date, p_dep_from: originWindowStart, p_dep_to: EXTENDED_DAY_CEILING_SECONDS },
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

  // Odtwórz ścieżkę wstecz przez predecessorOf (NA POZIOMIE POŁĄCZENIA, nie stacji — zob.
  // komentarz przy predecessorOf: incoming.get(stacja) dałoby NAJSZYBSZE dotarcie do danej
  // stacji pośredniej, które mogło pochodzić z zupełnie INNEGO, niezwiązanego kursu niż ten,
  // którym faktycznie kontynuowaliśmy jazdę — pokazując fantomową przesiadkę zamiast
  // prawdziwej kontynuacji), potem odwróć.
  const chain: Connection[] = [];
  let current: Connection | null = incoming.get(reachedToId) ?? null;
  while (current) {
    chain.push(current);
    current = predecessorOf.get(connKey(current)) ?? null;
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
