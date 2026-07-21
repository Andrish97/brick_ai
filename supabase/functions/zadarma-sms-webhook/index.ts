import { createHmac, createHash } from "node:crypto";

const ZADARMA_API_URL = "https://api.zadarma.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const COMPACT_THRESHOLD = 20; // wiadomości przed kompaktowaniem
const MAX_REPLY_CHARS = 153;  // 160 - '\n' - 6 cyfr kodu rozmowy (jeden SMS)
const MAX_CONT_CHARS = 459;   // 3x SMS — max długość odpowiedzi AI z kontynuacją
const CONTINUE_KEYWORDS = ["-->"];
const EXTENDED_ON_KEYWORDS = ["->"];
const EXTENDED_OFF_KEYWORDS = ["<-"];

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "").replace(/www\.\S+/g, "").replace(/\s{2,}/g, " ").trim();
}

function smartTrim(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastPunct = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"), cut.lastIndexOf("\n"));
  if (lastPunct > max * 0.6) return cut.slice(0, lastPunct + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > max * 0.6) return cut.slice(0, lastSpace).trim();
  return cut.trim();
}

function sanitizeForSms(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')  // cudzysłowy → "
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")  // apostrofy → '
    .replace(/\u2013/g, '-')                              // półpauza → -
    .replace(/\u2014/g, '--')                             // pauza → --
    .replace(/\u2026/g, '...')                            // wielokropek → ...
    .replace(/\u00A0/g, ' ')                              // spacja niełamliwa → spacja
    .replace(/[\u200B-\u200D\uFEFF]/g, '')               // znaki zerowej szerokości
    .replace(/\r\n|\r/g, '\n')                            // CRLF/CR → LF
    .trim();
}

// --- Zadarma auth ---

function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

function buildAuth(path: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort();
  const paramStr = sorted.map((k) => `${k}=${new URLSearchParams({ v: params[k] }).toString().slice(2)}`).join("&");
  const hex = createHmac("sha1", Deno.env.get("ZADARMA_API_SECRET")!)
    .update(path + paramStr + md5Hex(paramStr))
    .digest("hex");
  return `${Deno.env.get("ZADARMA_API_KEY")}:${btoa(hex)}`;
}

async function sendSms(to: string, text: string, from: string): Promise<void> {
  const path = "/v1/sms/send/";
  const params = { number: to, message: text, caller_id: from };
  const apiKey = Deno.env.get("ZADARMA_API_KEY") ?? "";
  const apiSecret = Deno.env.get("ZADARMA_API_SECRET") ?? "";
  log("sms_debug", { to, from, msgLen: text.length, keyPresent: !!apiKey, secretPresent: !!apiSecret, keyPrefix: apiKey.slice(0, 4) });
  const res = await fetch(`${ZADARMA_API_URL}${path}`, {
    method: "POST",
    headers: { Authorization: buildAuth(path, params), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`SMS send failed: ${res.status} ${await res.text()}`);
}

// --- Supabase helpers ---

function sbHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function sbGet(url: string, key: string, path: string): Promise<unknown[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: sbHeaders(key) });
  return res.ok ? res.json() : [];
}

async function sbPost(url: string, key: string, table: string, body: object): Promise<void> {
  await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

async function sbPatch(url: string, key: string, table: string, filter: string, body: object): Promise<void> {
  await fetch(`${url}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...sbHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

async function sbDelete(url: string, key: string, table: string, filter: string): Promise<void> {
  await fetch(`${url}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: sbHeaders(key) });
}

let _sbLog: { url: string; key: string } | null = null;
function initLog(url: string, key: string) { _sbLog = { url, key }; }
function log(type: string, data: object) {
  if (!_sbLog) return;
  sbPost(_sbLog.url, _sbLog.key, "logs", { type, data }).catch(() => {});
}

// --- Parsowanie SMS ---

// Znany numer: opcjonalny kod rozmowy (6 cyfr) w pierwszej linii, reszta to treść
function parseSmsKnownPhone(body: string): { convCode: string | null; content: string } {
  const lines = body.trim().split("\n").map((l) => l.trim());
  const first = lines[0] ?? "";
  if (/^\d{6}$/.test(first)) {
    return { convCode: first, content: lines.slice(1).join("\n").trim() };
  }
  return { convCode: null, content: body.trim() };
}

// Nieznany numer: pierwsza linia = kod użytkownika, opcjonalna druga = kod rozmowy
function parseSmsUnknownPhone(body: string): { userCode: string; convCode: string | null; content: string } {
  const lines = body.trim().split("\n").map((l) => l.trim());
  const userCode = lines[0] ?? "";
  const second = lines[1] ?? "";
  const isConvCode = /^\d{6}$/.test(second);
  if (isConvCode) {
    return { userCode, convCode: second, content: lines.slice(2).join("\n").trim() };
  }
  return { userCode, convCode: null, content: lines.slice(1).join("\n").trim() };
}

function generateCode(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

// --- AI ---

async function callGemini(messages: Array<{ role: string; content: string }>, system: string, maxOutputTokens = 100): Promise<string | null> {
  try {
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${Deno.env.get("GEMINI_API_KEY")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: system }] },
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const resText = await res.text();
    if (!res.ok) {
      log("gemini_error", { status: res.status, body: resText.slice(0, 500) });
      return null;
    }
    const data = JSON.parse(resText);
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const text = parts.filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("").trim();
    log("gemini_raw", {
      model: "gemini-3.5-flash",
      finishReason: candidate?.finishReason,
      partsCount: parts.length,
      chars: text.length,
      usedSearch: !!candidate?.groundingMetadata,
      preview: text.slice(0, 100),
    });
    return text || null;
  } catch (e) {
    log("gemini_error", { exception: String(e) });
    return null;
  }
}

async function askAi(messages: Array<{ role: string; content: string }>, system: string, maxOutputTokens = 100): Promise<string> {
  return (await callGemini(messages, system, maxOutputTokens)) ?? "Przepraszam, wystąpił błąd. Spróbuj ponownie.";
}

// --- Google Maps Routes API ---

function maneuverArrow(maneuver: string): string {
  if (!maneuver) return "↑";
  if (maneuver.includes("U_TURN")) return "↩";
  if (maneuver.includes("LEFT"))   return "↰";
  if (maneuver.includes("RIGHT"))  return "↱";
  return "↑";
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${meters}m`;
}

async function getDirections(from: string, to: string, transport: string): Promise<string | null> {
  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!apiKey) return null;

  const modeMap: Record<string, string> = {
    "samochód":  "DRIVE",
    "rower":     "BICYCLE",
    "hulajnoga": "BICYCLE",
    "pieszo":    "WALK",
  };
  const travelMode = modeMap[transport] ?? "WALK";

  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.distanceMeters,routes.legs.duration",
    },
    body: JSON.stringify({
      origin:      { address: from },
      destination: { address: to },
      travelMode,
      languageCode: "pl",
    }),
  });

  if (!res.ok) {
    log("maps_error", { status: res.status, body: (await res.text()).slice(0, 200) });
    return null;
  }
  const data = await res.json();
  const leg = data.routes?.[0]?.legs?.[0];
  if (!leg) {
    log("maps_error", { reason: "no_route", from, to });
    return null;
  }

  const lines: string[] = [];
  for (const step of leg.steps ?? []) {
    const nav = step.navigationInstruction;
    if (!nav) continue;
    const arrow = maneuverArrow(nav.maneuver ?? "");
    const instr = (nav.instructions ?? "").slice(0, 45);
    const dist = step.distanceMeters ? ` (${formatDistance(step.distanceMeters)})` : "";
    lines.push(`${arrow} ${instr}${dist}`);
  }

  const totalDist = leg.distanceMeters ? formatDistance(leg.distanceMeters) : "";
  const totalTime = leg.duration ? `~${Math.round(parseInt(leg.duration) / 60)}min` : "";
  lines.push(`★ ${to.slice(0, 35)}${totalDist ? ` (${totalDist}, ${totalTime})` : ""}`);

  return lines.join("\n");
}

// --- Handler ---

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET") {
    const echo = new URL(req.url).searchParams.get("zd_echo");
    return new Response(echo ?? "OK", { status: 200, headers: CORS });
  }
  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  let raw: Record<string, string>;
  try {
    const ct = req.headers.get("content-type") ?? "";
    raw = ct.includes("application/json")
      ? await req.json()
      : Object.fromEntries(new URLSearchParams(await req.text()));
  } catch {
    return new Response("Bad request", { status: 400, headers: CORS });
  }

  if (raw.zd_echo) return new Response(raw.zd_echo, { status: 200, headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL")!;
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  initLog(SB, KEY);

  // Zapisz raw payload do webhook_logs
  await sbPost(SB, KEY, "webhook_logs", { raw_payload: raw });

  const event = (raw.event ?? "").toLowerCase();
  if (event !== "sms" && event !== "incoming_sms") {
    log("ignored", { reason: "wrong_event", event: raw.event });
    return new Response("Ignored", { status: 200, headers: CORS });
  }

  // Zadarma może wysłać dane SMS bezpośrednio lub zagnieżdżone w polu result (JSON string)
  let data: Record<string, string> = raw;
  if (raw.result && typeof raw.result === "string") {
    try { data = { ...raw, ...JSON.parse(raw.result) }; } catch { /* ignore */ }
  }

  const senderPhone = data.sms_from ?? data.caller_id ?? "";
  const recipientDid = data.sms_to ?? data.caller_did ?? data.called_did ?? "";
  const smsBody = data.msg ?? data.text ?? "";
  if (!senderPhone || !smsBody) {
    log("error", { reason: "missing_fields", senderPhone: !!senderPhone, smsBody: !!smsBody, raw });
    return new Response("Missing fields", { status: 400, headers: CORS });
  }

  // Identyfikacja użytkownika: najpierw po numerze telefonu, fallback na kod
  type UserRow = { id: string; active: boolean; system_prompt: string | null; profile_name: string | null; profile_home: string | null; profile_work: string | null; profile_transport: string | null };
  const usersByPhone = await sbGet(SB, KEY, `users?phone_number=eq.${encodeURIComponent(senderPhone)}&active=eq.true&select=id,active,system_prompt,profile_name,profile_home,profile_work,profile_transport`) as UserRow[];

  let matchedUsers: UserRow[];
  let convCode: string | null;
  let effectiveContent: string;

  if (usersByPhone.length) {
    // Znany numer — kod użytkownika zbędny
    matchedUsers = usersByPhone;
    const parsed = parseSmsKnownPhone(smsBody);
    convCode = parsed.convCode;
    effectiveContent = parsed.content;
    log("sms_parsed", { from: senderPhone, to: recipientDid, knownPhone: true, convCode, content: effectiveContent, smsBody });
  } else {
    // Nieznany numer — wymagany kod użytkownika (pierwsza linia)
    const parsed = parseSmsUnknownPhone(smsBody);
    convCode = parsed.convCode;
    effectiveContent = parsed.content;
    log("sms_parsed", { from: senderPhone, to: recipientDid, knownPhone: false, userCode: parsed.userCode, convCode, content: effectiveContent, smsBody });

    matchedUsers = await sbGet(SB, KEY, `users?code=eq.${parsed.userCode}&active=eq.true&select=id,active,system_prompt,profile_name,profile_home,profile_work,profile_transport`) as UserRow[];
    if (!matchedUsers.length) {
      log("error", { reason: "unknown_user", userCode: parsed.userCode, from: senderPhone });
      return new Response("Unknown user", { status: 200, headers: CORS });
    }
  }

  if (!effectiveContent) {
    log("error", { reason: "empty_content", from: senderPhone, smsBody });
    return new Response("Empty content", { status: 200, headers: CORS });
  }

  const userId = matchedUsers[0].id;
  const userSystemPrompt = matchedUsers[0].system_prompt ?? null;
  const profileName = matchedUsers[0].profile_name ?? null;
  const profileHome = matchedUsers[0].profile_home ?? null;
  const profileWork = matchedUsers[0].profile_work ?? null;
  const profileTransport = matchedUsers[0].profile_transport ?? null;

  log("sms_in", { from: senderPhone, to: recipientDid, convCode, content: effectiveContent });

  // Znalezienie lub utworzenie rozmowy
  type Conv = { id: string; code: string; summary: string | null; pending_reply: string | null; extended_mode: boolean };
  let conv: Conv | null = null;

  if (convCode) {
    const found = await sbGet(SB, KEY, `conversations?code=eq.${convCode}&user_id=eq.${userId}&status=eq.active&select=id,code,summary,pending_reply,extended_mode`) as Conv[];
    conv = found[0] ?? null;
    if (!conv) log("error", { reason: "conv_not_found", convCode, userId });
  }

  if (!conv) {
    let newCode = "";
    for (let i = 0; i < 10; i++) {
      newCode = generateCode(6);
      const existing = await sbGet(SB, KEY, `conversations?code=eq.${newCode}&select=id`);
      if (!existing.length) break;
    }
    await sbPost(SB, KEY, "conversations", { user_id: userId, code: newCode, status: "active" });
    const created = await sbGet(SB, KEY, `conversations?code=eq.${newCode}&select=id,code,summary,pending_reply,extended_mode`) as Conv[];
    conv = created[0] ?? null;
    if (conv) log("conv_new", { convCode: newCode, userId, requestedConvCode: convCode ?? null });
  }

  if (!conv) {
    log("error", { reason: "conv_create_failed", userId });
    return new Response("Failed to create conversation", { status: 500, headers: CORS });
  }

  const convId = conv.id;
  const convCodeFinal = conv.code;
  let summary = conv.summary ?? null;
  let pendingReply = conv.pending_reply ?? null;
  const extendedMode = conv.extended_mode ?? false;

  // Zamknięcie rozmowy słowem kluczowym
  const kwSettings = await sbGet(SB, KEY, `settings?key=eq.close_keywords&select=value`) as Array<{ value: string }>;
  const CLOSE_KEYWORDS = (kwSettings[0]?.value ?? "koniec,stop,zamknij,end").split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
  if (CLOSE_KEYWORDS.includes(effectiveContent.trim().toLowerCase())) {
    await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { status: "closed" });
    log("conv_closed", { convId, convCode: convCodeFinal, userId, trigger: effectiveContent.trim() });
    return new Response(JSON.stringify({ ok: true, closed: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Włączanie / wyłączanie trybu rozszerzonego przez SMS
  const msgLower = effectiveContent.trim().toLowerCase();
  if (EXTENDED_ON_KEYWORDS.includes(msgLower)) {
    await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { extended_mode: true, pending_reply: null });
    log("extended_mode_on", { convId, convCode: convCodeFinal });
    const suffix = `\n${convCodeFinal}`;
    const info = `Tryb rozszerzony wlaczony. Pisz --> po kolejne czesci.`;
    if (!dryRun) await sendSms(senderPhone, `${info}${suffix}`, recipientDid);
    return new Response(JSON.stringify({ ok: true, extended_mode: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  if (EXTENDED_OFF_KEYWORDS.includes(msgLower)) {
    await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { extended_mode: false, pending_reply: null });
    log("extended_mode_off", { convId, convCode: convCodeFinal });
    const suffix = `\n${convCodeFinal}`;
    const info = `Tryb rozszerzony wylaczony.`;
    if (!dryRun) await sendSms(senderPhone, `${info}${suffix}`, recipientDid);
    return new Response(JSON.stringify({ ok: true, extended_mode: false }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Nawigacja: "nawigacja A > B" (A/B mogą być "dom" lub "praca")
  const navMatch = effectiveContent.match(/^nav\s+(.+?)\s*>\s*(.+)$/i);
  if (navMatch) {
    const resolve = (s: string): string | null => {
      const t = s.trim().toLowerCase();
      if (t === "dom") return profileHome;
      if (t === "praca") return profileWork;
      return s.trim();
    };
    const fromAddr = resolve(navMatch[1]);
    const toAddr = resolve(navMatch[2]);

    const suffix = `\n${convCodeFinal}`;

    if (!fromAddr || !toAddr) {
      const missing = !fromAddr ? "dom" : "praca";
      const err = `Brak adresu "${missing}" w profilu. Uzupelnij w panelu admina.`;
      if (!dryRun) await sendSms(senderPhone, `${err}${suffix}`, recipientDid);
      return new Response(JSON.stringify({ ok: true, nav_error: "missing_address" }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    const transport = profileTransport ?? "pieszo";

    // Nawigacja zawsze z extended mode i continuation
    await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { extended_mode: true });
    await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "in", content: effectiveContent });

    const mapsResult = await getDirections(fromAddr, toAddr, transport);

    if (!mapsResult) {
      // Brak klucza Maps API lub błąd
      const noKey = !Deno.env.get("GOOGLE_MAPS_API_KEY");
      const errMsg = noKey
        ? "Nawigacja wymaga klucza Google Maps API. Dodaj sekret GOOGLE_MAPS_API_KEY w Supabase."
        : "Nie udalo sie pobrac trasy. Sprawdz adresy i sprobuj ponownie.";
      const suffix2 = `\n${convCodeFinal}`;
      if (!dryRun) await sendSms(senderPhone, `${errMsg}${suffix2}`, recipientDid);
      return new Response(JSON.stringify({ ok: true, nav_error: noKey ? "no_api_key" : "no_route" }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    const navText = sanitizeForSms(mapsResult);

    const CHUNK_SIZE = 160 - suffix.length;
    const firstChunk = navText.length > CHUNK_SIZE - 3 ? navText.slice(0, CHUNK_SIZE - 3) + "..." : navText;
    const remaining = navText.length > CHUNK_SIZE - 3 ? navText.slice(CHUNK_SIZE - 3) : null;

    await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "out", content: navText });
    await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, {
      last_activity_at: new Date().toISOString(),
      pending_reply: remaining,
    });
    log("nav_sent", { convId, from: fromAddr, to: toAddr, transport, chars: navText.length, hasMore: !!remaining });

    if (dryRun) {
      return new Response(JSON.stringify({ ok: true, dry_run: true, reply: `${firstChunk}${suffix}` }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    try {
      await sendSms(senderPhone, `${firstChunk}${suffix}`, recipientDid);
      sbPost(SB, KEY, 'rpc/increment_sms_count', {}).catch(() => {});
    } catch (e) {
      log("sms_error", { to: senderPhone, from: recipientDid, error: String(e) });
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, navigation: true, has_more: !!remaining }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Kontynuacja — wysyłamy następny chunk bez angażowania AI
  if (CONTINUE_KEYWORDS.includes(effectiveContent.trim().toLowerCase()) && pendingReply) {
    const suffix = `\n${convCodeFinal}`;
    const chunkSize = 160 - suffix.length;
    const chunk = pendingReply.slice(0, chunkSize);
    const remaining = pendingReply.slice(chunkSize) || null;

    await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "in", content: effectiveContent });
    await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "out", content: chunk });
    await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, {
      pending_reply: remaining,
      last_activity_at: new Date().toISOString(),
    });
    log("continuation_sent", { convId, convCode: convCodeFinal, chunkLen: chunk.length, hasMore: !!remaining });

    if (dryRun) {
      return new Response(JSON.stringify({ ok: true, dry_run: true, reply: `${chunk}${suffix}`, has_more: !!remaining }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    try {
      await sendSms(senderPhone, `${chunk}${suffix}`, recipientDid);
      sbPost(SB, KEY, 'rpc/increment_sms_count', {}).catch(() => {});
    } catch (e) {
      log("sms_error", { to: senderPhone, from: recipientDid, error: String(e) });
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, continuation: true, has_more: !!remaining }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Nowa wiadomość — czyścimy ewentualne pending_reply
  if (pendingReply) {
    pendingReply = null;
    await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { pending_reply: null });
  }

  // Historia wiadomości
  type Msg = { direction: string; content: string; created_at: string };
  const msgs = await sbGet(SB, KEY, `messages?conversation_id=eq.${convId}&order=created_at.asc&select=direction,content,created_at`) as Msg[];

  // Sprawdź duplikaty — Zadarma może wielokrotnie wysłać ten sam webhook
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const isDuplicate = msgs.some(
    (m) => m.direction === "in" && m.content === effectiveContent && m.created_at >= twoMinutesAgo
  );
  if (isDuplicate) {
    log("duplicate_skipped", { convId, convCode: convCodeFinal, content: effectiveContent });
    return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Kontekst dla AI
  const aiMessages: Array<{ role: string; content: string }> = [];
  let needsCompaction = false;

  if (msgs.length >= COMPACT_THRESHOLD) {
    needsCompaction = true;
    log("compaction", { convId, convCode: convCodeFinal, msgCount: msgs.length });
    const historyText = msgs.map((m) => `${m.direction === "in" ? "User" : "AI"}: ${m.content}`).join("\n");
    aiMessages.push({
      role: "user",
      content: `Historia rozmowy:\n${historyText}\n\nNowa wiadomość użytkownika: ${effectiveContent}\n\nZadanie: Odpowiedz w JSON z dwoma polami:\n1. "summary": szczegółowe podsumowanie całej historii rozmowy — bez ograniczeń długości, zachowaj wszystkie istotne fakty, kontekst i ustalenia\n2. "reply": odpowiedź do użytkownika, maksymalnie ${MAX_REPLY_CHARS} znaków\n\nFormat: {"summary":"...","reply":"..."}`,
    });
  } else {
    if (summary) aiMessages.push({ role: "user", content: `[Kontekst rozmowy: ${summary}]` });
    for (const m of msgs) {
      aiMessages.push({ role: m.direction === "in" ? "user" : "assistant", content: m.content });
    }
    aiMessages.push({ role: "user", content: effectiveContent });
  }

  let systemPrompt = userSystemPrompt ?? null;
  if (!systemPrompt) {
    const settings = await sbGet(SB, KEY, `settings?key=eq.system_prompt_default&select=value`) as Array<{ value: string }>;
    systemPrompt = settings[0]?.value ?? `Jesteś asystentem SMS. WAŻNE: ODPOWIADAJ MAKSYMALNIE ${MAX_REPLY_CHARS} ZNAKÓW. Żadnych linków URL. Tylko fakty, zero wstępów.`;
  }
  if (extendedMode) {
    systemPrompt = systemPrompt.replace(
      new RegExp(`MAKSYMALNIE ${MAX_REPLY_CHARS} ZNAKÓW`, 'g'),
      `MAKSYMALNIE ${MAX_CONT_CHARS} ZNAKÓW`
    ) + ` Możesz pisać do ${MAX_CONT_CHARS} znaków — odpowiedź zostanie automatycznie podzielona na SMS-y.`;
  }

  // Dołącz profil użytkownika do system promptu
  const profileLines: string[] = [];
  if (profileName) profileLines.push(`Imię: ${profileName}`);
  if (profileHome) profileLines.push(`Adres domowy: ${profileHome}`);
  if (profileWork) profileLines.push(`Adres pracy: ${profileWork}`);
  if (profileTransport) profileLines.push(`Domyślny środek transportu: ${profileTransport}`);
  if (profileLines.length) {
    systemPrompt = `[Profil użytkownika]\n${profileLines.join("\n")}\n\n${systemPrompt}`;
  }

  // Wywołaj AI
  const rawReply = await askAi(aiMessages, systemPrompt, needsCompaction ? 600 : extendedMode ? 300 : 100);
  let aiReply: string;

  if (needsCompaction) {
    try {
      const json = JSON.parse(rawReply.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      summary = json.summary ?? "";
      aiReply = sanitizeForSms(smartTrim(stripUrls(json.reply ?? rawReply), extendedMode ? MAX_CONT_CHARS : MAX_REPLY_CHARS));
      // Usuń stare wiadomości i zapisz summary PRZED zapisem nowych
      await sbDelete(SB, KEY, "messages", `conversation_id=eq.${convId}`);
      await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { summary });
    } catch {
      aiReply = sanitizeForSms(smartTrim(rawReply, extendedMode ? MAX_CONT_CHARS : MAX_REPLY_CHARS));
    }
  } else {
    aiReply = sanitizeForSms(smartTrim(stripUrls(rawReply), extendedMode ? MAX_CONT_CHARS : MAX_REPLY_CHARS));
  }

  // Podziel odpowiedź na chunki jeśli dłuższa niż jeden SMS
  const suffix = `\n${convCodeFinal}`;
  const CHUNK_SIZE = 160 - suffix.length; // 153
  let safeReply: string;
  let newPendingReply: string | null = null;

  if (aiReply.length > CHUNK_SIZE) {
    // Pierwsza część + "...", reszta trafia do pending_reply
    safeReply = aiReply.slice(0, CHUNK_SIZE - 3) + "...";
    newPendingReply = aiReply.slice(CHUNK_SIZE - 3);
  } else {
    safeReply = aiReply;
  }

  // Zapis wiadomości użytkownika i pełnej odpowiedzi AI
  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "in", content: effectiveContent });
  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "out", content: aiReply });

  // Aktualizuj aktywność i pending_reply
  await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, {
    last_activity_at: new Date().toISOString(),
    pending_reply: newPendingReply,
  });

  log("ai_response", { convId, convCode: convCodeFinal, reply: safeReply, chars: safeReply.length, hasMore: !!newPendingReply });

  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, dry_run: true, reply: `${safeReply}${suffix}` }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Wyślij SMS
  try {
    await sendSms(senderPhone, `${safeReply}${suffix}`, recipientDid);
    log("sms_sent", { to: senderPhone, from: recipientDid, chars: safeReply.length + suffix.length });
    sbPost(SB, KEY, 'rpc/increment_sms_count', {}).catch(() => {});
  } catch (e) {
    log("sms_error", { to: senderPhone, from: recipientDid, error: String(e) });
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
});
