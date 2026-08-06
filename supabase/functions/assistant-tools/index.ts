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
  | "get_fastest_arrival";

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

async function getUser(url: string, key: string, userId: string): Promise<UserProfile | null> {
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

  try {
    const conversations = await sbGet(url, key, `conversations?id=eq.${encodeURIComponent(input.conversation_id)}&user_id=eq.${encodeURIComponent(input.user_id)}&select=id,status`);
    if (conversations.length !== 1) return json({ error: "Conversation not found" }, 404);

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
      await sbPatch(url, key, "conversations", `id=eq.${encodeURIComponent(input.conversation_id)}`, {
        reply_sms_parts: granted,
        last_activity_at: new Date().toISOString(),
      });
      return json({ granted_parts: granted });
    }

    if (input.action === "close_conversation") {
      await sbPatch(url, key, "conversations", `id=eq.${encodeURIComponent(input.conversation_id)}`, {
        status: "closed",
        pending_reply: null,
        last_activity_at: new Date().toISOString(),
      });
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

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("assistant-tools error", String(error));
    log("endpoint_error", { action: input.action, error: String(error) });
    return json({ error: "Tool execution failed" }, 500);
  }
});
