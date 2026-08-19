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

function asList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const obj = data as Record<string, unknown> | null;
  const candidate = obj?.items ?? obj?.data ?? obj?.stations ?? obj?.schedules ?? obj?.value;
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

function formatScheduleRow(row: Record<string, unknown>): string {
  const time = String(row.plannedTime ?? row.departureTime ?? row.time ?? row.scheduledTime ?? "?:??").slice(0, 5);
  const train = String(row.trainNumber ?? row.trainId ?? row.number ?? row.trainFullName ?? "?");
  const carrier = row.carrierCode ?? row.carrier ?? null;
  const dest = String(row.destination ?? row.direction ?? row.to ?? row.endStation ?? "?");
  const track = row.platform ?? row.track ?? row.trackNumber;
  return `${time} ${carrier ? `${carrier} ` : ""}${train} -> ${dest}${track != null ? ` tor ${track}` : ""}`;
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

      const t = pointArg.toLowerCase();
      let query: string | null = null;
      let addressFallback: string | null = null;
      if (t === "dom" || t === "home") { query = user.profile_home_station; addressFallback = user.profile_home; }
      else if (t === "praca" || t === "pracy" || t === "work") { query = user.profile_work_station; addressFallback = user.profile_work; }
      else { query = pointArg; }

      if (!query) {
        return json({ error: "no_preferred_station", hint: addressFallback ? "ask_user" : "missing_address" }, 200);
      }

      const search = await pkpSearchStations(query);
      if (!search.ok) return json({ error: search.error }, 200);
      if (search.data.length === 0) return json({ error: "station_not_found", query }, 200);
      if (search.data.length > 1) {
        return json({ error: "ambiguous_station", query, candidates: search.data.slice(0, 5).map((s) => s.name) }, 200);
      }
      return json({ station: search.data[0] });
    }

    if (input.action === "get_train_station_board") {
      const stationArg = typeof input.args?.station === "string" ? input.args.station : "";
      if (!stationArg) return json({ error: "station is required" }, 400);
      const dateArg = typeof input.args?.date === "string" ? input.args.date : "";

      const search = await pkpSearchStations(stationArg);
      if (!search.ok) return json({ error: search.error }, 200);
      if (search.data.length === 0) return json({ error: "station_not_found", query: stationArg }, 200);
      if (search.data.length > 1) {
        return json({ error: "ambiguous_station", query: stationArg, candidates: search.data.slice(0, 5).map((s) => s.name) }, 200);
      }
      const station = search.data[0];

      // Potwierdzone dokumentacją API: parametr to "stations" (lista ID po przecinku),
      // nie "stationId"; zakres dat to "dateFrom"/"dateTo", nie "date" — bez dateTo
      // dateTo domyślnie też byłoby "dzisiaj" niezależnie od dateFrom, więc podana data
      // musi trafić do obu, inaczej przy dacie w przyszłości dateFrom > dateTo da 0 wyników.
      const params: Record<string, string> = { stations: station.id };
      if (dateArg) { params.dateFrom = dateArg; params.dateTo = dateArg; }
      const result = await pkpFetch("/schedules", params);
      if (!result.ok) return json({ error: result.error }, 200);

      const list = asList(result.data);
      if (!list.length) {
        log("pkp_error", { reason: "no_schedule_entries", stationId: station.id, rawPreview: JSON.stringify(result.data).slice(0, 400) });
        return json({ error: "no_schedule_data" }, 200);
      }
      return json({ station: station.name, board: list.slice(0, 8).map(formatScheduleRow).join("\n") });
    }

    if (input.action === "get_train_status") {
      const trainIdArg = typeof input.args?.train_id === "string" ? input.args.train_id : "";
      if (!trainIdArg) return json({ error: "train_id is required" }, 400);
      const dateArg = typeof input.args?.date === "string" ? input.args.date : "";

      const params: Record<string, string> = { trainId: trainIdArg, withPlanned: "true" };
      if (dateArg) params.date = dateArg;
      const result = await pkpFetch("/operations", params);
      if (!result.ok) return json({ error: result.error }, 200);

      const list = asList(result.data);
      const entry = list[0] ?? (typeof result.data === "object" && result.data !== null ? result.data as Record<string, unknown> : null);
      if (!entry) {
        log("pkp_error", { reason: "no_operation_entry", trainId: trainIdArg, rawPreview: JSON.stringify(result.data).slice(0, 400) });
        return json({ error: "no_train_data" }, 200);
      }
      return json({
        train_id: trainIdArg,
        delay_minutes: entry.delayMinutes ?? entry.delay ?? entry.delayMin ?? null,
        status: entry.status ?? entry.trainStatus ?? null,
        planned_time: entry.plannedTime ?? entry.scheduledTime ?? null,
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

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("assistant-tools error", String(error));
    log("endpoint_error", { action: input.action, error: String(error) });
    return json({ error: "Tool execution failed" }, 500);
  }
});
