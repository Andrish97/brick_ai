import { resolveStationGroupSmart, hasFreshLocalData, runCsaJourney, type CsaResult } from "./csa.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Internal-Secret",
};

type ToolAction =
  | "get_user_profile"
  | "allow_long_reply"
  | "close_conversation"
  | "get_directions"
  | "get_transit"
  | "get_fastest_arrival"
  | "resolve_rail_station"
  | "get_train_station_board"
  | "get_train_status"
  | "plan_train_journey"
  | "get_train_disruptions";

type ToolRequest = {
  action: ToolAction;
  user_id: string;
  conversation_id: string;
  args?: Record<string, unknown>;
};

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function sbHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function sbGet(url: string, key: string, path: string): Promise<unknown[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: sbHeaders(key) });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
  return res.json();
}

async function sbPatch(url: string, key: string, table: string, filter: string, body: object): Promise<void> {
  const res = await fetch(`${url}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...sbHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status}`);
}

async function sbPost(url: string, key: string, table: string, body: object): Promise<void> {
  await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

// Zapis do tej samej tabeli `logs`, którą przegląda panel admina — webhook już loguje
// wywołanie i wynik narzędzia, ale szczegóły błędów Google Maps i nieobsłużone wyjątki
// wewnątrz tego endpointu wcześniej trafiały tylko do konsoli Deno (niewidoczne w panelu).
let _sbLog: { url: string; key: string } | null = null;
function initLog(url: string, key: string) { _sbLog = { url, key }; }
function log(type: string, data: object) {
  if (!_sbLog) return;
  sbPost(_sbLog.url, _sbLog.key, "logs", { type, data }).catch(() => {});
}

function validParts(value: unknown): value is 1 | 3 | 4 {
  return value === 1 || value === 3 || value === 4;
}

type UserProfile = {
  profile_name: string | null;
  profile_home: string | null;
  profile_work: string | null;
  profile_transport: string | null;
  profile_home_station: string | null;
  profile_work_station: string | null;
};

// Sentinel user_id używany wyłącznie przez panel admina → Testy → Test endpointów.
// Pozwala przepuścić realne wywołania Gemini/Google Maps/assistant-tools bez
// istniejącego użytkownika i bez zapisywania czegokolwiek do conversations/messages.
const TEST_MODE_USER_ID = "00000000-0000-0000-0000-000000000000";
const TEST_PROFILE: UserProfile = {
  profile_name: "Test",
  profile_home: "Rynek 1, Katowice",
  profile_work: "Spodek, Katowice",
  profile_transport: "pieszo",
  profile_home_station: null,
  profile_work_station: null,
};

async function getUser(url: string, key: string, userId: string): Promise<UserProfile | null> {
  if (userId === TEST_MODE_USER_ID) return TEST_PROFILE;
  const users = await sbGet(
    url,
    key,
    `users?id=eq.${encodeURIComponent(userId)}&select=profile_name,profile_home,profile_work,profile_transport,profile_home_station,profile_work_station`
  ) as UserProfile[];
  return users[0] ?? null;
}

// Globalny limit SMS-ów odpowiedzi rozszerzonej — Ustawienia → max_reply_sms_parts,
// jeden wspólny limit dla wszystkich użytkowników zamiast pola w profilu.
async function getMaxReplySmsParts(url: string, key: string): Promise<1 | 3 | 4> {
  const rows = await sbGet(url, key, `settings?key=eq.max_reply_sms_parts&select=value`) as Array<{ value: string }>;
  const parsed = parseInt(rows[0]?.value ?? "4", 10);
  return validParts(parsed) ? parsed : 4;
}

// --- Google Directions API (turn-by-turn + transit) ---

// Wyłącznie tryby bez samochodu — auto usunięte z routingu, aby ograniczyć długość
// odpowiedzi SMS (trasa drogowa potrafi mieć kilkanaście kroków / km).
const TRANSPORT_MODE: Record<string, string> = {
  "pieszo": "walking",
  "rower": "bicycling",
  "hulajnoga": "bicycling",
  "komunikacja miejska": "transit",
};

// 160 znaków SMS - "\n" - 6-cyfrowy kod rozmowy dopisywany przez webhook do każdej części
const SMS_PART_CHARS = 153;
const MAX_NAV_SMS_PARTS = 6;
const MAX_NAV_CHARS = SMS_PART_CHARS * MAX_NAV_SMS_PARTS;

function resolveAddress(value: string, user: UserProfile): { address: string | null; missing: string | null } {
  const t = value.trim().toLowerCase();
  if (t === "dom" || t === "home") {
    return user.profile_home ? { address: user.profile_home, missing: null } : { address: null, missing: "dom" };
  }
  if (t === "praca" || t === "pracy" || t === "work") {
    return user.profile_work ? { address: user.profile_work, missing: null } : { address: null, missing: "praca" };
  }
  return { address: value.trim(), missing: null };
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s{2,}/g, " ").trim();
}

// Google nie zwraca osobnego pola z nazwą ulicy — wyciągamy ostatni fragment
// oznaczony przez Google pogrubieniem (zwykle nazwa drogi po "w"/"na"/"ul.").
// Nie parsujemy treści językowo, tylko usuwamy HTML z oznaczonego fragmentu.
function streetNameFromHtml(html: string): { name: string; usedBold: boolean } {
  const bolds = [...html.matchAll(/<b>(.*?)<\/b>/gs)].map((m) => stripHtml(m[1])).filter(Boolean);
  if (bolds.length) return { name: bolds[bolds.length - 1], usedBold: true };
  return { name: stripHtml(html), usedBold: false };
}

function maneuverSymbol(maneuver: string | undefined): string {
  const map: Record<string, string> = {
    "straight": "^",
    "turn-left": "<",
    "turn-right": ">",
    "turn-slight-left": "<^",
    "keep-left": "<^",
    "turn-slight-right": ">^",
    "keep-right": ">^",
    "turn-sharp-left": "<<",
    "turn-sharp-right": ">>",
    "uturn-left": "<>",
    "uturn-right": "<>",
    "merge": "|",
    "fork-left": "|",
    "fork-right": "|",
    "ramp-left": "|",
    "ramp-right": "|",
  };
  if (!maneuver) return "~";
  if (maneuver.startsWith("roundabout")) {
    return `O${maneuver.match(/\d+/)?.[0] ?? ""}`;
  }
  return map[maneuver] ?? "~";
}

type DirectionsResult =
  | { ok: true; lines: string[]; destination: string; warnings: string[] }
  | { ok: false; error: string };

type WalkStep = { symbol: string; distanceMeters: number; name: string };

// Krok bez realnego manewru (prosto / brak instrukcji) — kolejne takie kroki
// można bezpiecznie połączyć w jeden, bo dla użytkownika liczy się tylko
// miejsce, w którym trzeba faktycznie skręcić.
function isStraightish(symbol: string): boolean {
  return symbol === "^" || symbol === "~";
}

// Google dzieli trasę na krok przy każdej zmianie nazwy ulicy, nawet gdy
// kierunek się nie zmienia. Łączymy sąsiadujące kroki "na wprost" w jeden
// (sumując dystans, zachowując nazwę ostatniego odcinka) i pomijamy znikome
// mikro-odcinki bez skrętu — skraca to trasę bez utraty żadnego manewru.
const MIN_STANDALONE_STEP_METERS = 15;

function simplifyWalkSteps(steps: WalkStep[]): WalkStep[] {
  const merged: WalkStep[] = [];
  for (const step of steps) {
    const last = merged[merged.length - 1];
    if (last && isStraightish(step.symbol) && isStraightish(last.symbol)) {
      last.distanceMeters += step.distanceMeters;
      last.name = step.name;
    } else {
      merged.push({ ...step });
    }
  }
  return merged.filter((s) => !(isStraightish(s.symbol) && s.distanceMeters < MIN_STANDALONE_STEP_METERS));
}

async function fetchDirections(apiKey: string, origin: string, destination: string, mode: string): Promise<DirectionsResult> {
  const params = new URLSearchParams({
    origin,
    destination,
    mode,
    language: "pl",
    key: apiKey,
  });
  if (mode === "transit") params.set("departure_time", "now");

  const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`);
  if (!res.ok) {
    log("directions_error", { status: res.status, body: (await res.text()).slice(0, 300), mode });
    return { ok: false, error: `directions_http_${res.status}` };
  }
  const data = await res.json();
  if (data.status !== "OK") {
    log("directions_error", { googleStatus: data.status, errorMessage: data.error_message, mode, origin, destination });
    return { ok: false, error: `directions_status_${data.status}` };
  }

  const leg = data.routes?.[0]?.legs?.[0];
  if (!leg) {
    log("directions_error", { reason: "no_leg_in_response", mode });
    return { ok: false, error: "no_route" };
  }

  const lines: string[] = [];
  const warnings: string[] = [];
  let pendingWalk: WalkStep[] = [];

  const flushWalk = () => {
    for (const s of simplifyWalkSteps(pendingWalk)) {
      lines.push(`${s.symbol} ${Math.round(s.distanceMeters)}m ${s.name}`);
    }
    pendingWalk = [];
  };

  for (const step of leg.steps ?? []) {
    if (step.travel_mode === "TRANSIT") {
      flushWalk();
      const td = step.transit_details;
      const line = td?.line?.short_name || td?.line?.name || "?";
      const depStop = td?.departure_stop?.name ?? "?";
      const arrStop = td?.arrival_stop?.name ?? "?";
      const depTime = (td?.departure_time?.text ?? "").replace(/\s?[AP]M/i, "");
      const arrTime = (td?.arrival_time?.text ?? "").replace(/\s?[AP]M/i, "");
      lines.push(`| 0m ${line} ${depStop} -> ${arrStop} ${depTime}-${arrTime}`);
      continue;
    }
    const distMeters = Math.round(step.distance?.value ?? 0);
    const symbol = maneuverSymbol(step.maneuver);
    const { name, usedBold } = streetNameFromHtml(step.html_instructions ?? "");
    if (!usedBold) warnings.push(`no_bold_street:${distMeters}`);
    pendingWalk.push({ symbol, distanceMeters: distMeters, name });
  }
  flushWalk();

  const destName = destination;
  lines.push(`* 0m ${destName}`);

  return { ok: true, lines, destination: destName, warnings };
}

// --- PKP PLK "Otwarte Dane Kolejowe" (fundament — bez planera przesiadek) ---
//
// Dokładny kształt odpowiedzi JSON tego API nie jest zweryfikowany na żywo (klucz
// PKP_API_KEY czekał na aktywację w momencie pisania tego kodu, a dokumentacja API
// jest niedostępna z tego środowiska). Parsowanie poniżej próbuje kilku prawdopodobnych
// nazw pól i loguje pełną surową odpowiedź przy błędzie/braku dopasowania (`pkp_error`),
// żeby dało się to szybko doprecyzować po pierwszym realnym wywołaniu — tak jak
// wcześniej z błędem Gemini i Google Directions w tej samej integracji.

const PKP_BASE_URL = "https://pdp-api.plk-sa.pl/api/v1";

type PkpResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

async function pkpFetch(path: string, params: Record<string, string> = {}): Promise<PkpResult<unknown>> {
  const apiKey = Deno.env.get("PKP_API_KEY");
  if (!apiKey) return { ok: false, error: "no_api_key" };

  const qs = new URLSearchParams(params).toString();
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${PKP_BASE_URL}${path}${qs ? `?${qs}` : ""}`, { headers: { "X-API-Key": apiKey } });
  } catch (e) {
    log("pkp_error", { path, exception: String(e) });
    return { ok: false, error: "pkp_unreachable" };
  }
  const elapsedMs = Date.now() - started;
  const text = await res.text();

  if (!res.ok) {
    // Metadane + skrócona treść błędu — nigdy klucz, nigdy pełne dane użytkownika.
    log("pkp_error", { path, status: res.status, elapsedMs, bodyPreview: text.slice(0, 500) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "pkp_unauthorized", status: res.status };
    if (res.status === 429) return { ok: false, error: "pkp_rate_limited", status: res.status };
    if (res.status >= 500) return { ok: false, error: "pkp_server_error", status: res.status };
    return { ok: false, error: `pkp_status_${res.status}`, status: res.status };
  }

  log("pkp_call", { path, status: res.status, elapsedMs });
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    log("pkp_error", { path, reason: "invalid_json", bodyPreview: text.slice(0, 300) });
    return { ok: false, error: "pkp_invalid_response" };
  }
}

// Klucze potwierdzone realną odpowiedzią API (patrz pkp_test z aktywnym kluczem):
// /dictionaries/stations -> "stations", /schedules -> "routes", /operations -> "trains",
// /disruptions -> "disruptions". Reszta (items/data/value) zostaje jako ogólny fallback.
function asList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const obj = data as Record<string, unknown> | null;
  const candidate = obj?.stations ?? obj?.routes ?? obj?.trains ?? obj?.disruptions
    ?? obj?.items ?? obj?.data ?? obj?.schedules ?? obj?.value;
  return Array.isArray(candidate) ? candidate as Record<string, unknown>[] : [];
}

type PkpStation = { id: string; name: string };

async function pkpSearchStations(query: string): Promise<PkpResult<PkpStation[]>> {
  const result = await pkpFetch("/dictionaries/stations", { search: query });
  if (!result.ok) return result;
  const list = asList(result.data);
  const stations = list
    .map((s): PkpStation => ({
      id: String(s.id ?? s.stationId ?? s.Id ?? s.code ?? ""),
      name: String(s.name ?? s.stationName ?? s.Name ?? s.fullName ?? ""),
    }))
    .filter((s) => s.id);
  if (list.length && !stations.length) {
    log("pkp_error", { reason: "stations_unparsed", query, rawPreview: JSON.stringify(result.data).slice(0, 400) });
  }
  return { ok: true, data: stations };
}

// /operations zwraca też słownik stacji ID->nazwa na poziomie odpowiedzi (potwierdzone
// /fields/operations: "st"/"stations"). Używane do nazwania stacji przesiadkowej
// odkrytej dynamicznie z pełnej trasy pociągu (tam mamy tylko jej ID).
async function lookupStationName(stationId: string): Promise<string | null> {
  const result = await pkpFetch("/operations", { stations: stationId });
  if (!result.ok) return null;
  const dict = (result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>).stations : null) as Record<string, unknown> | null;
  const name = dict && typeof dict === "object" ? dict[stationId] : null;
  return typeof name === "string" ? name : null;
}

// Numer/nazwa pociągu bywa w "name" (nie zawsze — część pociągów go nie ma), inaczej
// budowany z commercialCategorySymbol + nationalNumber. Wspólne dla wszystkich miejsc
// pokazujących pociąg użytkownikowi.
function trainLabel(route: Record<string, unknown>): string {
  const name = typeof route.name === "string" && route.name.trim() ? route.name.trim() : null;
  return name ?? ([route.commercialCategorySymbol, route.nationalNumber].filter(Boolean).join(" ") || "?");
}

// `row` to jeden element "routes[]" z /schedules?stations=X — API zwraca w
// route.stations[] TYLKO postój na filtrowanej stacji (nie całą trasę), więc nie ma
// tu pola z kierunkiem/celem podróży — potwierdzone realną odpowiedzią (pkp_test).
function formatScheduleRow(row: Record<string, unknown>): string {
  const stopsRaw = row.stations;
  const stop = (Array.isArray(stopsRaw) ? stopsRaw[0] : null) as Record<string, unknown> | null ?? {};
  const rawTime = stop.departureTime ?? stop.arrivalTime;
  const time = typeof rawTime === "string" ? rawTime.slice(0, 5) : "?:??";
  const carrier = row.carrierCode ?? null;
  const track = stop.departureTrack ?? stop.arrivalTrack ?? stop.departurePlatform ?? stop.arrivalPlatform;
  return `${time} ${carrier ? `${carrier} ` : ""}${trainLabel(row)}${track != null ? ` tor ${track}` : ""}`;
}

// --- Rozwiązywanie stacji (dom/praca z profilu, albo dowolny tekst) ---

// Adres polski to zwykle "ulica numer, miasto" — ostatni fragment po przecinku to
// najlepsze przybliżenie nazwy miejscowości do wyszukania stacji. Brak przecinka:
// używamy całego adresu jako zapytania.
function deriveStationQueryFromAddress(address: string): string {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : address.trim();
}

// profile_home_station/profile_work_station to opcjonalna, ręczna precyzacja (np. gdy
// ktoś mieszka bliżej konkretnej podmiejskiej stacji niż głównej stacji miasta) — gdy
// nie ustawione, stacja jest wyprowadzana automatycznie z adresu domu/pracy, żeby nie
// wymagać osobnego, ręcznie wypełnianego pola.
function resolveStationPoint(value: string, user: UserProfile): { query: string | null; missing: string | null } {
  const t = value.trim().toLowerCase();
  if (t === "dom" || t === "home") {
    if (user.profile_home_station) return { query: user.profile_home_station, missing: null };
    if (user.profile_home) return { query: deriveStationQueryFromAddress(user.profile_home), missing: null };
    return { query: null, missing: "dom" };
  }
  if (t === "praca" || t === "pracy" || t === "work") {
    if (user.profile_work_station) return { query: user.profile_work_station, missing: null };
    if (user.profile_work) return { query: deriveStationQueryFromAddress(user.profile_work), missing: null };
    return { query: null, missing: "praca" };
  }
  return { query: value.trim(), missing: null };
}

type StationLookup = { ok: true; station: PkpStation } | { ok: false; body: Record<string, unknown> };

// Logika ujednoznaczniania współdzielona (w zamyśle, choć zduplikowana z powodów
// unikania cyklicznego importu — zob. csa.ts) między żywym wyszukiwaniem PKP a lokalnym
// (resolveSingleStationLocal w csa.ts, przy szukaniu w rail_stops z GTFS).
function pickBestStationMatch(candidates: PkpStation[], query: string): PkpStation | null {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  // API PKP szuka przez podłańcuch, więc "Katowice" trafia też "Katowice Ligota",
  // "Katowice Piotrowice" itd. Jeśli któryś wynik ma nazwę DOKŁADNIE (bez uwzględniania
  // wielkości liter) równą zapytaniu, to jest jednoznaczna intencja — nie każ dopytywać
  // tylko dlatego, że inne stacje mają tę nazwę jako prefiks.
  const normalizedQuery = query.trim().toLowerCase();
  const exact = candidates.filter((s) => s.name.trim().toLowerCase() === normalizedQuery);
  if (exact.length === 1) return exact[0];

  // Niektóre miasta w ogóle nie mają stacji o nazwie DOKŁADNIE takiej jak samo miasto —
  // np. "Kłodzko" istnieje tylko jako "Klodzko Glowne"/"Klodzko Miasto"/"Klodzko Ksiazek"/
  // "Klodzko Zagorze" (dane PKP są bez polskich znaków). W takim wypadku stacja z
  // przyrostkiem Główny/Główna/Główne to jednoznacznie ta "domyślna" dla miasta — tak
  // samo oczywista jak Kraków Główny czy Warszawa Centralna.
  const mainSuffix = /^(glowny|glowna|glowne|główny|główna|główne)$/i;
  const main = candidates.filter((s) => {
    const name = s.name.trim().toLowerCase();
    if (!name.startsWith(normalizedQuery)) return false;
    return mainSuffix.test(name.slice(normalizedQuery.length).trim());
  });
  if (main.length === 1) return main[0];
  return null;
}

// Wspólny wzorzec: szukaj stacji po tekście, oddaj błąd jeśli 0 albo >1 dopasowań —
// używane przez resolve_rail_station, get_train_station_board, get_train_status
// i plan_train_journey, żeby zachowanie przy niejednoznacznej nazwie było identyczne
// wszędzie (dopytaj, nigdy nie zgaduj).
async function resolveSingleStation(query: string): Promise<StationLookup> {
  const search = await pkpSearchStations(query);
  if (!search.ok) return { ok: false, body: { error: search.error } };
  if (search.data.length === 0) return { ok: false, body: { error: "station_not_found", query } };
  if (search.data.length === 1) return { ok: true, station: search.data[0] };
  const best = pickBestStationMatch(search.data, query);
  if (best) return { ok: true, station: best };
  return { ok: false, body: { error: "ambiguous_station", query, candidates: search.data.slice(0, 5).map((s) => s.name) } };
}

// --- Data/czas (strefa Europe/Warsaw — PKP działa w czasie polskim, nie UTC) ---

function warsawNow(): Date {
  // Deno działa w UTC; przesunięcie na czas polski robimy przez sformatowanie
  // i ponowne sparsowanie w strefie Europe/Warsaw zamiast liczyć offset ręcznie
  // (poprawnie obsługuje też zmianę czasu letni/zimowy).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return new Date(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`);
}

function todayDateStr(): string {
  const d = warsawNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "8:14", "08:14", "8.14" -> minuty od północy; null jeśli nie da się rozpoznać.
function parseTimeToMinutes(value: string): number | null {
  const m = value.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function timeStrToMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Znajduje w route.stations[] wpis dla konkretnej stacji (id porównywane jako string,
// bo API zwraca stationId jako liczbę, a nasze PkpStation.id trzyma je jako string).
function stationStopIn(route: Record<string, unknown>, stationId: string): Record<string, unknown> | null {
  const stops = Array.isArray(route.stations) ? route.stations as Record<string, unknown>[] : [];
  return stops.find((s) => String(s.stationId ?? "") === stationId) ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expectedSecret = Deno.env.get("ASSISTANT_TOOLS_SECRET") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!expectedSecret || req.headers.get("X-Internal-Secret") !== expectedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  let input: ToolRequest;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!input?.action || !input.user_id || !input.conversation_id) {
    return json({ error: "action, user_id and conversation_id are required" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server configuration error" }, 500);
  initLog(url, key);
  log("endpoint_call", { action: input.action, args: input.args ?? {} });

  const isTestMode = input.user_id === TEST_MODE_USER_ID;

  try {
    if (!isTestMode) {
      const conversations = await sbGet(url, key, `conversations?id=eq.${encodeURIComponent(input.conversation_id)}&user_id=eq.${encodeURIComponent(input.user_id)}&select=id,status`);
      if (conversations.length !== 1) return json({ error: "Conversation not found" }, 404);
    }

    if (input.action === "get_user_profile") {
      const allowed = new Set(["name", "home", "work", "transport", "home_station", "work_station"]);
      const requested = Array.isArray(input.args?.fields)
        ? input.args!.fields.filter((field): field is string => typeof field === "string" && allowed.has(field))
        : [];
      const fields = requested.length ? requested : ["name", "home", "work", "transport", "home_station", "work_station"];
      const user = await getUser(url, key, input.user_id);
      if (!user) return json({ error: "User not found" }, 404);
      const source: Record<string, unknown> = {
        name: user.profile_name, home: user.profile_home, work: user.profile_work,
        transport: user.profile_transport, home_station: user.profile_home_station,
        work_station: user.profile_work_station,
      };
      return json({ profile: Object.fromEntries(fields.filter((field) => source[field] != null).map((field) => [field, source[field]])) });
    }

    if (input.action === "allow_long_reply") {
      const requested = input.args?.parts;
      if (!validParts(requested) || requested === 1) return json({ error: "parts must be 3 or 4" }, 400);
      const cap = await getMaxReplySmsParts(url, key);
      const granted = Math.min(requested, cap) as 1 | 3 | 4;
      if (!isTestMode) {
        await sbPatch(url, key, "conversations", `id=eq.${encodeURIComponent(input.conversation_id)}`, {
          reply_sms_parts: granted,
          last_activity_at: new Date().toISOString(),
        });
      }
      return json({ granted_parts: granted });
    }

    if (input.action === "close_conversation") {
      if (!isTestMode) {
        await sbPatch(url, key, "conversations", `id=eq.${encodeURIComponent(input.conversation_id)}`, {
          status: "closed",
          pending_reply: null,
          last_activity_at: new Date().toISOString(),
        });
      }
      return json({ closed: true });
    }

    if (input.action === "get_directions" || input.action === "get_transit") {
      const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
      if (!apiKey) return json({ error: "no_api_key" }, 200);

      const user = await getUser(url, key, input.user_id);
      if (!user) return json({ error: "User not found" }, 404);

      const originArg = typeof input.args?.origin === "string" ? input.args.origin : "";
      const destArg = typeof input.args?.destination === "string" ? input.args.destination : "";
      if (!originArg || !destArg) return json({ error: "origin and destination are required" }, 400);

      const origin = resolveAddress(originArg, user);
      const destination = resolveAddress(destArg, user);
      if (origin.missing || destination.missing) {
        return json({ error: "missing_address", missing: origin.missing ?? destination.missing }, 200);
      }

      let modeLabel: string;
      if (input.action === "get_transit") {
        modeLabel = "komunikacja miejska";
      } else {
        const requestedMode = typeof input.args?.mode === "string" ? input.args.mode : "";
        modeLabel = TRANSPORT_MODE[requestedMode] ? requestedMode : (user.profile_transport ?? "");
      }
      const googleMode = TRANSPORT_MODE[modeLabel];
      if (!googleMode) {
        return json({ error: "unsupported_transport", message: "Ustaw transport w profilu: pieszo, rower, hulajnoga lub komunikacja miejska." }, 200);
      }

      const result = await fetchDirections(apiKey, origin.address!, destination.address!, googleMode);
      if (!result.ok) return json({ error: result.error }, 200);

      const text = result.lines.join("\n");
      if (text.length > MAX_NAV_CHARS) {
        return json({ error: "route_too_long", max_sms_parts: MAX_NAV_SMS_PARTS }, 200);
      }
      return json({ route: text, warnings: result.warnings });
    }

    if (input.action === "get_fastest_arrival") {
      const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
      if (!apiKey) return json({ error: "no_api_key" }, 200);

      const user = await getUser(url, key, input.user_id);
      if (!user) return json({ error: "User not found" }, 404);

      const originArg = typeof input.args?.origin === "string" ? input.args.origin : "";
      const destArg = typeof input.args?.destination === "string" ? input.args.destination : "";
      if (!originArg || !destArg) return json({ error: "origin and destination are required" }, 400);

      const origin = resolveAddress(originArg, user);
      const destination = resolveAddress(destArg, user);
      if (origin.missing || destination.missing) {
        return json({ error: "missing_address", missing: origin.missing ?? destination.missing }, 200);
      }

      const candidateModes = user.profile_transport && TRANSPORT_MODE[user.profile_transport]
        ? [user.profile_transport]
        : ["pieszo", "rower", "komunikacja miejska"];

      const results: Array<{ mode: string; minutes: number }> = [];
      for (const mode of candidateModes) {
        const googleMode = TRANSPORT_MODE[mode];
        const params = new URLSearchParams({
          origin: origin.address!, destination: destination.address!, mode: googleMode, language: "pl", key: apiKey,
        });
        if (googleMode === "transit") params.set("departure_time", "now");
        const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`);
        if (!res.ok) {
          log("directions_error", { status: res.status, mode, action: "get_fastest_arrival" });
          continue;
        }
        const data = await res.json();
        const leg = data.routes?.[0]?.legs?.[0];
        const seconds = leg?.duration?.value;
        if (data.status === "OK" && typeof seconds === "number") {
          results.push({ mode, minutes: Math.round(seconds / 60) });
        } else {
          log("directions_error", { googleStatus: data.status, errorMessage: data.error_message, mode, action: "get_fastest_arrival" });
        }
      }

      if (!results.length) return json({ error: "no_route" }, 200);
      results.sort((a, b) => a.minutes - b.minutes);
      const now = new Date();
      const arrival = new Date(now.getTime() + results[0].minutes * 60000);
      const arrivalTime = arrival.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw" });

      return json({
        best_mode: results[0].mode,
        minutes: results[0].minutes,
        arrival_time: arrivalTime,
        alternatives: results.slice(1),
      });
    }

    if (input.action === "resolve_rail_station") {
      const pointArg = typeof input.args?.point === "string" ? input.args.point.trim() : "";
      if (!pointArg) return json({ error: "point is required" }, 400);
      const user = await getUser(url, key, input.user_id);
      if (!user) return json({ error: "User not found" }, 404);

      const resolved = resolveStationPoint(pointArg, user);
      if (!resolved.query) return json({ error: "no_preferred_station", hint: resolved.missing }, 200);

      const lookup = await resolveSingleStation(resolved.query);
      if (!lookup.ok) return json(lookup.body, 200);
      return json({ station: lookup.station });
    }

    if (input.action === "get_train_station_board") {
      const stationArg = typeof input.args?.station === "string" ? input.args.station.trim() : "";
      if (!stationArg) return json({ error: "station is required" }, 400);
      const dateArg = typeof input.args?.date === "string" ? input.args.date : "";
      const user = await getUser(url, key, input.user_id);
      if (!user) return json({ error: "User not found" }, 404);

      const resolvedPoint = resolveStationPoint(stationArg, user);
      if (!resolvedPoint.query) return json({ error: "no_preferred_station", hint: resolvedPoint.missing }, 200);
      const lookup = await resolveSingleStation(resolvedPoint.query);
      if (!lookup.ok) return json(lookup.body, 200);
      const station = lookup.station;

      // Potwierdzone dokumentacją API: parametr to "stations" (lista ID po przecinku),
      // nie "stationId"; zakres dat to "dateFrom"/"dateTo", nie "date" — bez dateTo
      // dateTo domyślnie też byłoby "dzisiaj" niezależnie od dateFrom, więc podana data
      // musi trafić do obu, inaczej przy dacie w przyszłości dateFrom > dateTo da 0 wyników.
      const params: Record<string, string> = { stations: station.id };
      const targetDate = dateArg || todayDateStr();
      params.dateFrom = targetDate; params.dateTo = targetDate;
      const result = await pkpFetch("/schedules", params);
      if (!result.ok) return json({ error: result.error }, 200);

      let list = asList(result.data);
      // Bez podanej daty pokazujemy tylko to, co jeszcze przed nami dzisiaj —
      // tablica odjazdów, które już minęły, jest bezużyteczna.
      if (!dateArg) {
        const nowMin = warsawNow().getHours() * 60 + warsawNow().getMinutes();
        list = list.filter((r) => {
          const stop = stationStopIn(r, station.id);
          const t = timeStrToMinutes(stop?.departureTime ?? stop?.arrivalTime);
          return t === null || t >= nowMin;
        });
      }
      list.sort((a, b) => {
        const ta = timeStrToMinutes(stationStopIn(a, station.id)?.departureTime ?? stationStopIn(a, station.id)?.arrivalTime) ?? 9999;
        const tb = timeStrToMinutes(stationStopIn(b, station.id)?.departureTime ?? stationStopIn(b, station.id)?.arrivalTime) ?? 9999;
        return ta - tb;
      });
      if (!list.length) {
        log("pkp_error", { reason: "no_schedule_entries", stationId: station.id, rawPreview: JSON.stringify(result.data).slice(0, 400) });
        return json({ error: "no_schedule_data" }, 200);
      }
      return json({ station: station.name, board: list.slice(0, 8).map(formatScheduleRow).join("\n") });
    }

    // Identyfikacja pociągu po stacji + przybliżonej godzinie (opcjonalnie kierunek),
    // NIE po numerze pociągu — nikt nie zna numeru swojego pociągu z głowy. "Numer"
    // pojawia się w wyniku jako informacja, nigdy jako wymagane wejście.
    // Krok 1: znajdź w /schedules pociąg najbliższy podanej godzinie z danej stacji.
    // Krok 2: dopasuj go w /operations po scheduleId+orderId, żeby dostać realny status.
    if (input.action === "get_train_status") {
      const user = await getUser(url, key, input.user_id);
      if (!user) return json({ error: "User not found" }, 404);

      const stationArg = typeof input.args?.station === "string" && input.args.station.trim() ? input.args.station.trim() : "dom";
      const resolvedPoint = resolveStationPoint(stationArg, user);
      if (!resolvedPoint.query) return json({ error: "no_preferred_station", hint: resolvedPoint.missing }, 200);
      const lookup = await resolveSingleStation(resolvedPoint.query);
      if (!lookup.ok) return json(lookup.body, 200);
      const station = lookup.station;

      let destStation: PkpStation | null = null;
      const destArg = typeof input.args?.destination === "string" ? input.args.destination.trim() : "";
      if (destArg) {
        const destResolved = resolveStationPoint(destArg, user);
        if (destResolved.query) {
          const destLookup = await resolveSingleStation(destResolved.query);
          if (destLookup.ok) destStation = destLookup.station;
          // Niejednoznaczny/nieznaleziony kierunek nie blokuje sprawdzenia — kierunek
          // to tylko pomoc w wyborze, stacja odjazdu + godzina wystarczą same w sobie.
        }
      }

      const targetMinutes = typeof input.args?.time === "string" && parseTimeToMinutes(input.args.time) !== null
        ? parseTimeToMinutes(input.args.time)!
        : warsawNow().getHours() * 60 + warsawNow().getMinutes();

      const date = todayDateStr();
      const stationsParam = destStation ? `${station.id},${destStation.id}` : station.id;
      const result = await pkpFetch("/schedules", { stations: stationsParam, dateFrom: date, dateTo: date });
      if (!result.ok) return json({ error: result.error }, 200);

      let candidates = asList(result.data);
      if (destStation) {
        // Jeśli podano kierunek, ogranicz do pociągów faktycznie jadących w tę stronę
        // (obie stacje w trasie, w poprawnej kolejności) — reszta i tak nas nie dotyczy.
        const filtered = candidates.filter((r) => {
          const a = stationStopIn(r, station.id), b = stationStopIn(r, destStation!.id);
          if (!a || !b) return false;
          const oa = Number(a.orderNumber ?? a.ord ?? -1), ob = Number(b.orderNumber ?? b.ord ?? -2);
          return oa < ob;
        });
        if (filtered.length) candidates = filtered; // brak dopasowań w tę stronę -> zostań przy pełnej liście, lepsze niż nic
      }

      let best: Record<string, unknown> | null = null;
      let bestDiff = Infinity;
      for (const r of candidates) {
        const stop = stationStopIn(r, station.id);
        const mins = timeStrToMinutes(stop?.departureTime ?? stop?.arrivalTime);
        if (mins === null) continue;
        const diff = Math.abs(mins - targetMinutes);
        if (diff < bestDiff) { bestDiff = diff; best = r; }
      }
      if (!best) {
        log("pkp_error", { reason: "no_schedule_match_for_status", stationId: station.id, targetMinutes, rawPreview: JSON.stringify(result.data).slice(0, 400) });
        return json({ error: "no_train_data" }, 200);
      }

      const scheduleId = best.scheduleId, orderId = best.orderId;
      const opsResult = await pkpFetch("/operations", { stations: station.id, withPlanned: "true" });
      if (!opsResult.ok) return json({ error: opsResult.error }, 200);

      const trains = asList(opsResult.data);
      const match = trains.find((t) => String(t.scheduleId ?? "") === String(scheduleId ?? "") && String(t.orderId ?? "") === String(orderId ?? ""));
      const opStop = match ? stationStopIn(match, station.id) : null;
      if (!match || !opStop) {
        log("pkp_error", { reason: "no_operation_match", scheduleId, orderId, stationId: station.id, rawPreview: JSON.stringify(opsResult.data).slice(0, 400) });
        // Znaleźliśmy pociąg w rozkładzie, ale brak danych real-time — lepiej pokazać
        // sam rozkład niż nic.
        return json({
          train: trainLabel(best), station: station.name,
          planned_time: (stationStopIn(best, station.id)?.departureTime ?? stationStopIn(best, station.id)?.arrivalTime ?? null) as string | null,
          delay_minutes: null, status: null,
        });
      }
      const delay = opStop.departureDelayMinutes ?? opStop.arrivalDelayMinutes ?? null;
      return json({
        train: trainLabel(best),
        station: station.name,
        planned_time: (opStop.plannedDeparture ?? opStop.plannedArrival ?? null) as string | null,
        delay_minutes: typeof delay === "number" ? delay : null,
        status: match.trainStatus ?? null,
      });
    }

    if (input.action === "get_train_disruptions") {
      const stationsArg = typeof input.args?.stations === "string" ? input.args.stations : "";
      const params: Record<string, string> = {};
      if (stationsArg) params.stations = stationsArg;
      const result = await pkpFetch("/disruptions", params);
      if (!result.ok) return json({ error: result.error }, 200);

      const list = asList(result.data);
      const summaries = list.slice(0, 5).map((d) => String(d.description ?? d.message ?? d.title ?? "utrudnienie"));
      return json({ disruptions: summaries });
    }

    // Planer połączeń kolejowych z przesiadkami — najpierw bezpośrednie, jeśli brak:
    // 1 przesiadka, znaleziona DYNAMICZNIE z realnego rozkładu (nie ze sztywnej listy
    // stacji) — bierzemy pociągi odjeżdżające ze stacji startowej, pobieramy ich pełną
    // trasę (/schedules/route/{scheduleId}/{orderId}), i sprawdzamy, czy z któregoś
    // przystanku da się dojechać dalej do celu. Ograniczone do garści najbliższych
    // odjazdów, żeby zmieścić się w limicie zapytań API (klucz Basic: 100/h).
    if (input.action === "plan_train_journey") {
      const user = await getUser(url, key, input.user_id);
      if (!user) return json({ error: "User not found" }, 404);

      const fromArg = typeof input.args?.from === "string" ? input.args.from.trim() : "";
      const toArg = typeof input.args?.to === "string" ? input.args.to.trim() : "";
      if (!fromArg || !toArg) return json({ error: "from and to are required" }, 400);
      const dateArg = typeof input.args?.date === "string" ? input.args.date : "";
      const preferredTimeArg = typeof input.args?.preferred_time === "string" ? input.args.preferred_time.trim() : "";

      // Najpierw próba lokalna (CSA nad zsynchronizowanym GTFS — zob. csa.ts) — szybsza,
      // bez limitu zapytań PKP, dowolna liczba przesiadek. Przy jakimkolwiek niepowodzeniu
      // (brak świeżych danych, stacja nierozpoznana/niejednoznaczna lokalnie, CSA nic nie
      // znajduje, rozbieżność z żywym API dla bliskiej daty, wyjątek) — bezwarunkowy
      // fallback na dotychczasową żywą heurystykę PKP (planTrainJourneyLive), nigdy błąd 500.
      const local = await tryPlanTrainJourneyLocal(url, key, user, fromArg, toArg, dateArg, preferredTimeArg);
      if (local) {
        log("plan_train_journey_path", { path: "local" });
        return json(local);
      }
      log("plan_train_journey_path", { path: "live" });
      return await planTrainJourneyLive(url, key, user, fromArg, toArg, dateArg);
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("assistant-tools error", String(error));
    log("endpoint_error", { action: input.action, error: String(error) });
    return json({ error: "Tool execution failed" }, 500);
  }
});

// Bliska data = dziś albo jutro — jedyny zakres, w którym żywe /schedules PKP w ogóle
// ma dane do porównania (i jedyny, w którym rozjazd lokalnego GTFS z rzeczywistością
// realnie obchodzi użytkownika, bo za chwilę wsiada do pociągu).
function isNearTermDate(date: string): boolean {
  const today = todayDateStr();
  if (date === today) return true;
  const tomorrow = new Date(warsawNow().getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  return date === tomorrowStr;
}

// Weryfikacja pierwszej nogi trasy z CSA względem żywego /schedules PKP — nie tylko
// "pokaż opóźnienie", ale sygnał, że lokalny GTFS wciąż zgadza się z rzeczywistością.
// Brak dopasowania w tolerancji ±3 min traktujemy jako niepotwierdzone (nie jako "brak
// danych o opóźnieniu") — wywołujący ma wtedy spaść na żywą heurystykę zamiast pokazać
// potencjalnie nieaktualną trasę bez ostrzeżenia.
async function verifyFirstLegLive(leg: { from: string; departure: string }, date: string): Promise<boolean> {
  const liveFrom = await resolveSingleStation(leg.from);
  if (!liveFrom.ok) return false;
  const result = await pkpFetch("/schedules", { stations: liveFrom.station.id, dateFrom: date, dateTo: date });
  if (!result.ok) return false;
  const plannedMin = parseTimeToMinutes(leg.departure);
  if (plannedMin === null) return false;
  for (const r of asList(result.data)) {
    const stop = stationStopIn(r, liveFrom.station.id);
    const t = timeStrToMinutes(stop?.departureTime ?? stop?.arrivalTime);
    if (t !== null && Math.abs(t - plannedMin) <= 3) return true;
  }
  return false;
}

// Próba lokalna (CSA nad zsynchronizowanym GTFS) dla plan_train_journey — zwraca null
// przy JAKIMKOLWIEK niepowodzeniu (brak świeżych danych, stacja nierozpoznana/
// niejednoznaczna lokalnie, CSA nic nie znajduje, rozbieżność z żywym API dla bliskiej
// daty, dowolny wyjątek), co dispatcher wyżej traktuje jako sygnał do wywołania
// planTrainJourneyLive — nigdy nie ujawnia błędu 500 z powodu tej ścieżki.
// Okno startowe (typowo 4h) wyliczone z preferred_time (jeśli AI je podało), inaczej
// bieżąca godzina dla dziś, albo sensowny poranek (6:00-10:00) dla przyszłej daty —
// zastępuje dawne sztywne "start=0 dla nie-dziś" (dawało bezsensowny origin window od
// północy zamiast realnej pory podróży).
const ORIGIN_WINDOW_SECONDS = 4 * 3600;
const DEFAULT_FUTURE_MORNING_HOUR = 6;

function computeOriginWindow(dateArg: string, preferredTimeArg: string): { date: string; start: number; end: number } {
  const date = dateArg || todayDateStr();
  const isToday = date === todayDateStr();
  let startSeconds: number;
  const preferredMin = preferredTimeArg ? parseTimeToMinutes(preferredTimeArg) : null;
  if (preferredMin !== null) {
    startSeconds = preferredMin * 60;
  } else if (isToday) {
    startSeconds = warsawNow().getHours() * 3600 + warsawNow().getMinutes() * 60;
  } else {
    startSeconds = DEFAULT_FUTURE_MORNING_HOUR * 3600;
  }
  return { date, start: startSeconds, end: startSeconds + ORIGIN_WINDOW_SECONDS };
}

async function tryPlanTrainJourneyLocal(
  url: string, key: string, user: UserProfile, fromArg: string, toArg: string, dateArg: string, preferredTimeArg: string,
): Promise<CsaResult | null> {
  try {
    // Log wejścia bezwarunkowo (nie tylko przy niepowodzeniu) — realny test (Katowice ->
    // Zamość) zwrócił "live" bez ŻADNEGO z pozostałych logów rail_local_skip poniżej, co
    // przez eliminację wskazuje na TĘ gałąź (jedyną wcześniej bez logowania) — ale bez
    // zobaczenia surowych argumentów od Gemini nie da się tego potwierdzić na pewno.
    log("rail_local_entry", { fromArg, toArg, dateArg, preferredTimeArg });
    if (!(await hasFreshLocalData(url, key))) {
      log("rail_local_skip", { reason: "no_fresh_local_data" });
      return null;
    }

    const fromResolved = resolveStationPoint(fromArg, user);
    const toResolved = resolveStationPoint(toArg, user);
    if (!fromResolved.query || !toResolved.query) {
      log("rail_local_skip", {
        reason: "no_preferred_station",
        fromArg, toArg, fromMissing: fromResolved.missing, toMissing: toResolved.missing,
      });
      return null; // spadnij na żywą — ona da właściwy komunikat no_preferred_station
    }

    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    const [fromLookup, toLookup] = await Promise.all([
      resolveStationGroupSmart(url, key, geminiKey, fromResolved.query),
      resolveStationGroupSmart(url, key, geminiKey, toResolved.query),
    ]);
    log("rail_local_station_resolved", {
      from: fromResolved.query, to: toResolved.query,
      fromVia: fromLookup.ok ? fromLookup.resolvedVia : undefined,
      fromPicked: fromLookup.ok ? fromLookup.station.name : undefined,
      toVia: toLookup.ok ? toLookup.resolvedVia : undefined,
      toPicked: toLookup.ok ? toLookup.station.name : undefined,
    });
    if (!fromLookup.ok || !toLookup.ok) {
      log("rail_local_skip", {
        reason: "station_not_resolved_locally",
        from: fromResolved.query, to: toResolved.query,
        fromBody: fromLookup.ok ? undefined : fromLookup.body,
        toBody: toLookup.ok ? undefined : toLookup.body,
      });
      return null;
    }

    const { date, start: originWindowStart, end: originWindowEnd } = computeOriginWindow(dateArg, preferredTimeArg);

    const { result, diagnostics } = await runCsaJourney(url, key, fromLookup.station, toLookup.station, date, originWindowStart, originWindowEnd);
    if (!result) {
      log("rail_local_skip", {
        reason: "csa_found_nothing",
        from: fromLookup.station.name, to: toLookup.station.name, date, originWindowStart, originWindowEnd,
        ...diagnostics,
      });
      return null;
    }

    if (isNearTermDate(date)) {
      const verified = await verifyFirstLegLive(result.legs[0], date);
      if (!verified) {
        log("rail_local_mismatch", { from: fromLookup.station.name, to: toLookup.station.name, date });
        return null;
      }
    }

    return result;
  } catch (e) {
    log("rail_local_error", { error: String(e) });
    return null;
  }
}

// Żywa heurystyka PKP (bezpośredni odcinek, potem do 1, potem do 2 przesiadek) —
// zachowana bez zmian jako TRWAŁY bezpiecznik, nie tymczasowa łatka migracyjna. Wywoływana
// przez dispatcher plan_train_journey wyżej, zawsze gdy próba lokalna (CSA) zawiedzie.
async function planTrainJourneyLive(url: string, key: string, user: UserProfile, fromArg: string, toArg: string, dateArg: string): Promise<Response> {
  {
    {
      const fromResolved = resolveStationPoint(fromArg, user);
      if (!fromResolved.query) return json({ error: "no_preferred_station", hint: fromResolved.missing }, 200);
      const toResolved = resolveStationPoint(toArg, user);
      if (!toResolved.query) return json({ error: "no_preferred_station", hint: toResolved.missing }, 200);

      const [fromLookup, toLookup] = await Promise.all([resolveSingleStation(fromResolved.query), resolveSingleStation(toResolved.query)]);
      if (!fromLookup.ok) return json(fromLookup.body, 200);
      if (!toLookup.ok) return json(toLookup.body, 200);
      const from = fromLookup.station, to = toLookup.station;

      const date = dateArg || todayDateStr();
      const isToday = date === todayDateStr();
      const nowMin = warsawNow().getHours() * 60 + warsawNow().getMinutes();

      const directResult = await pkpFetch("/schedules", { stations: `${from.id},${to.id}`, dateFrom: date, dateTo: date });
      if (!directResult.ok) return json({ error: directResult.error }, 200);
      const allRoutes = asList(directResult.data);

      const direct = allRoutes
        .map((r) => {
          const a = stationStopIn(r, from.id), b = stationStopIn(r, to.id);
          if (!a || !b) return null;
          const oa = Number(a.orderNumber ?? -1), ob = Number(b.orderNumber ?? -2);
          if (!(oa < ob)) return null;
          const depMin = timeStrToMinutes(a.departureTime ?? a.arrivalTime);
          const arrMin = timeStrToMinutes(b.arrivalTime ?? b.departureTime);
          if (depMin === null || arrMin === null) return null;
          if (isToday && depMin < nowMin) return null;
          return { route: r, depMin, arrMin, depTime: (a.departureTime ?? a.arrivalTime) as string, arrTime: (b.arrivalTime ?? b.departureTime) as string };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((x, y) => x.depMin - y.depMin);

      if (direct.length) {
        const best = direct[0];
        return json({
          direct: true,
          legs: [{ from: from.name, to: to.name, departure: best.depTime.slice(0, 5), arrival: best.arrTime.slice(0, 5), train: trainLabel(best.route) }],
        });
      }

      // Brak bezpośredniego — kandydaci na przesiadkę: pociągi odjeżdżające z "from"
      // (te same dane, które już mamy z zapytania wyżej — routes dotykające from, ale
      // nie to), ograniczone do kilku najbliższych odjazdów.
      const fromLegCandidates = allRoutes
        .map((r) => {
          const a = stationStopIn(r, from.id);
          if (!a) return null;
          const depMin = timeStrToMinutes(a.departureTime ?? a.arrivalTime);
          if (depMin === null) return null;
          if (isToday && depMin < nowMin) return null;
          return { route: r, depMin, depTime: (a.departureTime ?? a.arrivalTime) as string };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((x, y) => x.depMin - y.depMin)
        .slice(0, 6);

      if (!fromLegCandidates.length) {
        return json({ error: "no_connection_found", diagnostics: { stage: "no_departures_from_origin", allRoutesCount: allRoutes.length } }, 200);
      }

      // Pełna trasa każdego kandydata, żeby poznać WSZYSTKIE jego przystanki (filtrowane
      // /schedules pokazuje tylko stację, o którą pytaliśmy) — to jedyne miejsce, gdzie
      // dopuszczamy nieprzetestowaną na żywo ścieżkę API; parsowanie defensywne + log.
      // arriveAtTransferTime: surowy string HH:MM:SS z pełnej trasy — filtrowane
      // /schedules (użyte gdzie indziej w tej funkcji) NIGDY nie ma wpisu dla stacji
      // przesiadkowej (bo o nią nie pytaliśmy), więc to jedyne miejsce, gdzie ten
      // czas jest w ogóle dostępny — musi zostać przeniesiony aż do finalnej odpowiedzi.
      const transferCandidates: Array<{ stationId: string; arriveAtTransfer: number; arriveAtTransferTime: string; leg1: typeof fromLegCandidates[0] }> = [];
      let routeDetailOk = 0, routeDetailFailed = 0, totalStopsSeen = 0;
      for (const cand of fromLegCandidates) {
        const scheduleId = cand.route.scheduleId, orderId = cand.route.orderId;
        if (scheduleId == null || orderId == null) continue;
        const full = await pkpFetch(`/schedules/route/${scheduleId}/${orderId}`, {});
        if (!full.ok) { routeDetailFailed++; log("pkp_error", { reason: "route_detail_failed", scheduleId, orderId, error: full.error }); continue; }
        const fullRoute = (full.data && typeof full.data === "object" ? full.data as Record<string, unknown> : null);
        const stops = fullRoute ? (Array.isArray(fullRoute.stations) ? fullRoute.stations as Record<string, unknown>[]
          : Array.isArray(fullRoute.route) ? fullRoute.route as Record<string, unknown>[] : []) : [];
        if (!stops.length) { routeDetailFailed++; log("pkp_error", { reason: "route_detail_unparsed", scheduleId, orderId, rawPreview: JSON.stringify(full.data).slice(0, 400) }); continue; }
        routeDetailOk++;
        totalStopsSeen += stops.length;
        for (const s of stops) {
          const sid = String(s.stationId ?? "");
          if (!sid || sid === from.id || sid === to.id) continue;
          const rawTime = s.arrivalTime ?? s.departureTime;
          const arrMin = timeStrToMinutes(rawTime);
          if (arrMin === null) continue;
          transferCandidates.push({ stationId: sid, arriveAtTransfer: arrMin, arriveAtTransferTime: String(rawTime), leg1: cand });
        }
      }

      if (!transferCandidates.length) {
        return json({
          error: "no_connection_found",
          diagnostics: { stage: "no_transfer_candidates", fromLegCandidatesCount: fromLegCandidates.length, routeDetailOk, routeDetailFailed, totalStopsSeen },
        }, 200);
      }

      const candidateIds = [...new Set(transferCandidates.map((c) => c.stationId))];
      const onwardResult = await pkpFetch("/schedules", { stations: `${candidateIds.join(",")},${to.id}`, dateFrom: date, dateTo: date });
      if (!onwardResult.ok) return json({ error: "no_connection_found", diagnostics: { stage: "onward_schedules_failed", error: onwardResult.error } }, 200);
      const onwardRoutes = asList(onwardResult.data);

      const MIN_TRANSFER_BUFFER_MIN = 7;
      type Combo = { tc: typeof transferCandidates[0]; leg2Route: Record<string, unknown>; leg2DepMin: number; arrMin: number };
      const combos: Combo[] = [];
      for (const tc of transferCandidates) {
        for (const r of onwardRoutes) {
          const a = stationStopIn(r, tc.stationId), b = stationStopIn(r, to.id);
          if (!a || !b) continue;
          const oa = Number(a.orderNumber ?? -1), ob = Number(b.orderNumber ?? -2);
          if (!(oa < ob)) continue;
          const depMin = timeStrToMinutes(a.departureTime ?? a.arrivalTime);
          const arrMin = timeStrToMinutes(b.arrivalTime ?? b.departureTime);
          if (depMin === null || arrMin === null) continue;
          if (depMin < tc.arriveAtTransfer + MIN_TRANSFER_BUFFER_MIN) continue;
          combos.push({ tc, leg2Route: r, leg2DepMin: depMin, arrMin });
        }
      }

      if (!combos.length) {
        // Jedna przesiadka nie wystarczyła — niektóre trasy (np. Zamość) naprawdę
        // wymagają dwóch. `onwardRoutes` już zawiera pociągi odjeżdżające ZE stacji
        // przesiadkowych 1. rzędu (bo zapytanie o nie było bez ograniczenia do samego
        // `to`), więc drugi poziom przesiadki budujemy z tych samych danych — bez
        // dodatkowego zapytania /schedules, tylko kolejny odczyt pełnej trasy dla garści
        // najszybszych odjazdów z przesiadki 1. rzędu.
        type Leg2Departure = { tc: typeof transferCandidates[0]; route: Record<string, unknown>; depMin: number };
        const leg2Departures: Leg2Departure[] = [];
        for (const tc of transferCandidates) {
          for (const r of onwardRoutes) {
            const a = stationStopIn(r, tc.stationId);
            if (!a) continue;
            const depMin = timeStrToMinutes(a.departureTime ?? a.arrivalTime);
            if (depMin === null || depMin < tc.arriveAtTransfer + MIN_TRANSFER_BUFFER_MIN) continue;
            leg2Departures.push({ tc, route: r, depMin });
          }
        }
        leg2Departures.sort((a, b) => a.depMin - b.depMin);
        const boundedLeg2 = leg2Departures.slice(0, 6);

        type Transfer2Candidate = { stationId: string; arriveAtTransfer2: number; arriveAtTransfer2Time: string; leg2: Leg2Departure };
        const transfer2Candidates: Transfer2Candidate[] = [];
        const seenRouteKeys = new Set<string>();
        for (const l2 of boundedLeg2) {
          const scheduleId = l2.route.scheduleId, orderId = l2.route.orderId;
          if (scheduleId == null || orderId == null) continue;
          const routeKey = `${scheduleId}:${orderId}`;
          if (seenRouteKeys.has(routeKey)) continue;
          seenRouteKeys.add(routeKey);
          const full = await pkpFetch(`/schedules/route/${scheduleId}/${orderId}`, {});
          if (!full.ok) { log("pkp_error", { reason: "route_detail_failed_leg2", scheduleId, orderId, error: full.error }); continue; }
          const fullRoute = (full.data && typeof full.data === "object" ? full.data as Record<string, unknown> : null);
          const stops = fullRoute ? (Array.isArray(fullRoute.stations) ? fullRoute.stations as Record<string, unknown>[]
            : Array.isArray(fullRoute.route) ? fullRoute.route as Record<string, unknown>[] : []) : [];
          for (const s of stops) {
            const sid = String(s.stationId ?? "");
            if (!sid || sid === from.id || sid === to.id || sid === l2.tc.stationId) continue;
            const rawTime = s.arrivalTime ?? s.departureTime;
            const arrMin = timeStrToMinutes(rawTime);
            if (arrMin === null) continue;
            transfer2Candidates.push({ stationId: sid, arriveAtTransfer2: arrMin, arriveAtTransfer2Time: String(rawTime), leg2: l2 });
          }
        }

        if (transfer2Candidates.length) {
          const t2Ids = [...new Set(transfer2Candidates.map((c) => c.stationId))];
          const finalResult = await pkpFetch("/schedules", { stations: `${t2Ids.join(",")},${to.id}`, dateFrom: date, dateTo: date });
          const finalRoutes = finalResult.ok ? asList(finalResult.data) : [];

          type Combo3 = { t2: Transfer2Candidate; leg3Route: Record<string, unknown>; arrMin: number };
          const combos3: Combo3[] = [];
          for (const t2 of transfer2Candidates) {
            for (const r of finalRoutes) {
              const a = stationStopIn(r, t2.stationId), b = stationStopIn(r, to.id);
              if (!a || !b) continue;
              const oa = Number(a.orderNumber ?? -1), ob = Number(b.orderNumber ?? -2);
              if (!(oa < ob)) continue;
              const depMin = timeStrToMinutes(a.departureTime ?? a.arrivalTime);
              const arrMin = timeStrToMinutes(b.arrivalTime ?? b.departureTime);
              if (depMin === null || arrMin === null) continue;
              if (depMin < t2.arriveAtTransfer2 + MIN_TRANSFER_BUFFER_MIN) continue;
              combos3.push({ t2, leg3Route: r, arrMin });
            }
          }

          if (combos3.length) {
            combos3.sort((x, y) => x.arrMin - y.arrMin);
            const chosen3 = combos3[0];
            const tc = chosen3.t2.leg2.tc;
            const leg1Stop = stationStopIn(tc.leg1.route, from.id);
            const leg2DepStop = stationStopIn(chosen3.t2.leg2.route, tc.stationId);
            const leg2ArrStop = stationStopIn(chosen3.t2.leg2.route, chosen3.t2.stationId);
            const leg3DepStop = stationStopIn(chosen3.leg3Route, chosen3.t2.stationId);
            const leg3ArrStop = stationStopIn(chosen3.leg3Route, to.id);
            const [transfer1Name, transfer2Name] = await Promise.all([
              lookupStationName(tc.stationId),
              lookupStationName(chosen3.t2.stationId),
            ]);
            const t1Label = transfer1Name ?? `stacja ${tc.stationId}`;
            const t2Label = transfer2Name ?? `stacja ${chosen3.t2.stationId}`;

            return json({
              direct: false,
              legs: [
                {
                  from: from.name, to: t1Label,
                  departure: String(leg1Stop?.departureTime ?? leg1Stop?.arrivalTime ?? "").slice(0, 5),
                  arrival: tc.arriveAtTransferTime.slice(0, 5),
                  train: trainLabel(tc.leg1.route),
                },
                {
                  from: t1Label, to: t2Label,
                  departure: String(leg2DepStop?.departureTime ?? "").slice(0, 5),
                  arrival: chosen3.t2.arriveAtTransfer2Time.slice(0, 5),
                  train: trainLabel(chosen3.t2.leg2.route),
                },
                {
                  from: t2Label, to: to.name,
                  departure: String(leg3DepStop?.departureTime ?? "").slice(0, 5),
                  arrival: String(leg3ArrStop?.arrivalTime ?? leg3ArrStop?.departureTime ?? "").slice(0, 5),
                  train: trainLabel(chosen3.leg3Route),
                },
              ],
            });
          }
        }

        const candidateNames = await Promise.all(candidateIds.slice(0, 6).map((id) => lookupStationName(id)));
        return json({
          error: "no_connection_found",
          diagnostics: {
            stage: "no_onward_combo",
            triedTwoTransfers: true,
            transferCandidateStations: candidateIds.slice(0, 6).map((id, i) => candidateNames[i] ?? id),
            onwardRoutesCount: onwardRoutes.length,
          },
        }, 200);
      }
      combos.sort((x, y) => x.arrMin - y.arrMin || x.tc.leg1.depMin - y.tc.leg1.depMin);
      const chosen = combos[0];
      const leg1Stop = stationStopIn(chosen.tc.leg1.route, from.id);
      const leg2DepStop = stationStopIn(chosen.leg2Route, chosen.tc.stationId);
      const leg2ArrStop = stationStopIn(chosen.leg2Route, to.id);
      // Pełna trasa dała tylko ID stacji przesiadkowej, nie nazwę — /operations zwraca
      // słownik ID->nazwa ("stations" w odpowiedzi, potwierdzone /fields/operations),
      // więc doszukujemy nazwy tym samym, tanim zapytaniem, zamiast zgadywać.
      const transferName = (await lookupStationName(chosen.tc.stationId)) ?? `stacja ${chosen.tc.stationId}`;

      return json({
        direct: false,
        legs: [
          {
            from: from.name, to: transferName,
            departure: String(leg1Stop?.departureTime ?? leg1Stop?.arrivalTime ?? "").slice(0, 5),
            arrival: chosen.tc.arriveAtTransferTime.slice(0, 5),
            train: trainLabel(chosen.tc.leg1.route),
          },
          {
            from: transferName, to: to.name,
            departure: String(leg2DepStop?.departureTime ?? "").slice(0, 5),
            arrival: String(leg2ArrStop?.arrivalTime ?? leg2ArrStop?.departureTime ?? "").slice(0, 5),
            train: trainLabel(chosen.leg2Route),
          },
        ],
      });
    }
  }
}
