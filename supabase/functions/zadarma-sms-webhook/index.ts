import { createHmac, createHash } from "node:crypto";

const ZADARMA_API_URL = "https://api.zadarma.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const COMPACT_THRESHOLD = 20; // wiadomości przed kompaktowaniem
const SUFFIX_LEN = 7; // "\n" + 6-cyfrowy kod rozmowy
const SMS_PART_CHARS = 160 - SUFFIX_LEN; // 153 — treść jednej części SMS bez suffixu
const CLOSE_KEYWORDS = ["koniec", "stop", "zamknij", "end"]; // szybka ścieżka bez wywoływania modelu

// Liczba tokenów wyjściowych Gemini w zależności od przyznanego limitu SMS-ów odpowiedzi
const TOKENS_FOR_PARTS: Record<number, number> = { 1: 100, 3: 300, 4: 400 };

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

// Dzieli tekst na maks. `maxParts` części po `SMS_PART_CHARS` znaków. Jeśli tekst
// jest dłuższy, obcina go najpierw na granicy zdania/słowa (smartTrim), więc nigdy
// nie wysyłamy więcej niż `maxParts` SMS-ów za jedną odpowiedź.
function chunkForSms(text: string, maxParts: number): string[] {
  const budget = SMS_PART_CHARS * maxParts;
  const fitted = text.length > budget ? smartTrim(text, budget - 3) + "..." : text;
  const parts: string[] = [];
  for (let i = 0; i < fitted.length; i += SMS_PART_CHARS) {
    parts.push(fitted.slice(i, i + SMS_PART_CHARS));
  }
  return parts.length ? parts : [""];
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

// --- Gemini function calling ---

type GeminiContent = { role: string; parts: Array<Record<string, unknown>> };

const TOOLS = [
  { google_search: {} },
  {
    functionDeclarations: [
      {
        name: "allow_long_reply",
        description:
          "Pozwala AI odpowiedzieć dłużej niż jednym SMS-em w BIEŻĄCEJ rozmowie. Wywołaj WYŁĄCZNIE gdy użytkownik wyraźnie zgadza się na dłuższą odpowiedź (np. 'możesz odpisać szerzej', 'pisz w czterech SMS-ach', 'możesz kontynuować' w kontekście zgody na dłuższą odpowiedź). Nie wywołuj tylko dlatego, że Twoja odpowiedź mogłaby być długa.",
        parameters: {
          type: "OBJECT",
          properties: {
            parts: { type: "INTEGER", description: "Liczba SMS-ów, na jaką zgodził się użytkownik: 3 lub 4." },
          },
          required: ["parts"],
        },
      },
      {
        name: "close_conversation",
        description:
          "Definitywnie zamyka bieżącą rozmowę. Wywołaj WYŁĄCZNIE gdy użytkownik naprawdę chce zakończyć rozmowę (np. 'to koniec', 'żegnam się', 'nie kontynuuj'). Nie wywołuj tylko dlatego, że w tekście pojawiło się słowo podobne do 'koniec' bez takiej intencji.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "get_user_profile",
        description:
          "Pobiera wybrane pola profilu bieżącego użytkownika (imię, dom, praca, transport). Wywołaj tylko gdy odpowiedź faktycznie tego wymaga — np. użytkownik pyta o swoje imię albo ustawiony transport. Nie wywołuj, aby uzyskać adres domu/pracy do nawigacji — get_directions/get_transit/get_fastest_arrival rozwiązują to samodzielnie.",
        parameters: {
          type: "OBJECT",
          properties: {
            fields: {
              type: "ARRAY",
              items: { type: "STRING", enum: ["name", "home", "work", "transport"] },
              description: "Lista pól do pobrania. Domyślnie wszystkie.",
            },
          },
        },
      },
      {
        name: "get_directions",
        description:
          "Pobiera i formatuje trasę krok po kroku między dwoma punktami (bez samochodu — tylko pieszo, rower, hulajnoga lub komunikacja miejska). Słowa 'dom' i 'praca' zostaną automatycznie rozwinięte z profilu użytkownika po stronie serwera — przekaż je dosłownie, nie pytaj o adres.",
        parameters: {
          type: "OBJECT",
          properties: {
            origin: { type: "STRING", description: "Punkt startowy: adres albo 'dom'/'praca'." },
            destination: { type: "STRING", description: "Cel podróży: adres albo 'dom'/'praca'." },
            mode: {
              type: "STRING",
              enum: ["pieszo", "rower", "hulajnoga", "komunikacja miejska"],
              description: "Środek transportu. Jeśli pominięty, użyty zostanie transport z profilu użytkownika.",
            },
          },
          required: ["origin", "destination"],
        },
      },
      {
        name: "get_transit",
        description:
          "Pobiera szczegółową trasę komunikacją miejską (autobus/tramwaj/metro) między dwoma punktami, z przesiadkami i godzinami odjazdu/przyjazdu, wyliczoną od teraz.",
        parameters: {
          type: "OBJECT",
          properties: {
            origin: { type: "STRING", description: "Punkt startowy: adres albo 'dom'/'praca'." },
            destination: { type: "STRING", description: "Cel podróży: adres albo 'dom'/'praca'." },
          },
          required: ["origin", "destination"],
        },
      },
      {
        name: "get_fastest_arrival",
        description:
          "Porównuje dostępne środki transportu (pieszo, rower, komunikacja miejska — bez samochodu) i zwraca najszybszy sposób dotarcia do celu wraz z przewidywaną godziną przyjazdu, licząc od teraz.",
        parameters: {
          type: "OBJECT",
          properties: {
            origin: { type: "STRING", description: "Punkt startowy: adres albo 'dom'/'praca'." },
            destination: { type: "STRING", description: "Cel podróży: adres albo 'dom'/'praca'." },
          },
          required: ["origin", "destination"],
        },
      },
    ],
  },
];

const DETERMINISTIC_ACTIONS = new Set(["get_directions", "get_transit", "get_fastest_arrival"]);

type GeminiTurn = {
  functionCall: { name: string; args: Record<string, unknown> } | null;
  functionCallPart: Record<string, unknown> | null;
  text: string | null;
};

async function generateContent(contents: GeminiContent[], system: string, maxOutputTokens: number, includeTools = true): Promise<GeminiTurn> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${Deno.env.get("GEMINI_API_KEY")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: system }] },
          tools: includeTools ? TOOLS : undefined,
          // Wymagane przez API, gdy w tools łączymy wbudowane narzędzie (google_search)
          // z własnymi functionDeclarations — bez tego 400 INVALID_ARGUMENT.
          tool_config: includeTools ? { include_server_side_tool_invocations: true } : undefined,
          generationConfig: { maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const resText = await res.text();
    if (!res.ok) {
      log("gemini_error", { status: res.status, body: resText.slice(0, 500) });
      return { functionCall: null, functionCallPart: null, text: null };
    }
    const data = JSON.parse(resText);
    const candidate = data.candidates?.[0];
    const parts: Array<Record<string, unknown>> = candidate?.content?.parts ?? [];
    const functionCallPart = parts.find((p) => p.functionCall) as { functionCall?: { name: string; args?: Record<string, unknown> } } | undefined;
    const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text as string).join("").trim();
    log("gemini_raw", {
      model: "gemini-3.5-flash",
      finishReason: candidate?.finishReason,
      partsCount: parts.length,
      functionCall: functionCallPart?.functionCall?.name ?? null,
      chars: text.length,
    });
    return {
      functionCall: functionCallPart?.functionCall ? { name: functionCallPart.functionCall.name, args: functionCallPart.functionCall.args ?? {} } : null,
      // Zwracamy CAŁĄ oryginalną część odpowiedzi (może zawierać thoughtSignature),
      // żeby odesłać ją do Gemini bez zmian w drugiej turze — API odrzuca odtworzone
      // od zera { functionCall: {name, args} } błędem "missing a thought_signature".
      functionCallPart: functionCallPart ?? null,
      text: text || null,
    };
  } catch (e) {
    log("gemini_error", { exception: String(e) });
    return { functionCall: null, functionCallPart: null, text: null };
  }
}

async function callAssistantTool(action: string, args: Record<string, unknown>, userId: string, conversationId: string): Promise<Record<string, unknown>> {
  const url = Deno.env.get("SUPABASE_URL");
  const secret = Deno.env.get("ASSISTANT_TOOLS_SECRET") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const res = await fetch(`${url}/functions/v1/assistant-tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": secret ?? "" },
      body: JSON.stringify({ action, user_id: userId, conversation_id: conversationId, args }),
    });
    return await res.json();
  } catch (e) {
    return { error: "tool_unreachable", detail: String(e) };
  }
}

function directionsErrorMessage(toolResult: Record<string, unknown>): string {
  const error = String(toolResult.error ?? "");
  if (error === "no_api_key") return "Nawigacja jest chwilowo niedostępna (brak konfiguracji).";
  if (error === "missing_address") return `Brak adresu "${toolResult.missing ?? "?"}" w profilu. Uzupełnij go w panelu admina.`;
  if (error === "unsupported_transport") return String(toolResult.message ?? "Ustaw obsługiwany transport w profilu.");
  if (error === "route_too_long") return `Trasa jest zbyt długa na SMS (limit ${toolResult.max_sms_parts ?? 6} części). Wybierz bliższy cel.`;
  if (error === "no_route") return "Nie udało się znaleźć trasy. Sprawdź adresy i spróbuj ponownie.";
  return "Nie udało się pobrać trasy. Spróbuj ponownie.";
}

function formatFastestArrival(toolResult: Record<string, unknown>): string {
  if (toolResult.error) return directionsErrorMessage(toolResult);
  const mode = String(toolResult.best_mode ?? "?");
  const minutes = toolResult.minutes;
  const arrival = toolResult.arrival_time;
  return `Najszybciej: ${mode}, ${minutes} min (przyjazd ~${arrival}).`;
}

type ToolContext = { userId: string; convId: string };

type AssistantOutcome =
  | { kind: "closed" }
  | { kind: "route"; text: string }
  | { kind: "text"; text: string; grantedParts?: 1 | 3 | 4 };

async function runAssistant(contents: GeminiContent[], systemPrompt: string, maxOutputTokens: number, ctx: ToolContext): Promise<AssistantOutcome> {
  let first = await generateContent(contents, systemPrompt, maxOutputTokens);
  if (!first.functionCall && !first.text) {
    // Zapytanie z narzędziami (funkcje + wbudowane wyszukiwanie) całkowicie zawiodło
    // (np. błąd API 400 przy łączeniu obu typów tools) — spróbuj bez narzędzi, żeby
    // użytkownik dostał realną odpowiedź zamiast zmarnowanego SMS-a z błędem. Tymczasowy
    // bezpiecznik: dopóki przyczyna nie jest naprawiona, narzędzia w tej turze nie zadziałają.
    log("tools_call_failed_retry", { convId: ctx.convId });
    first = await generateContent(contents, systemPrompt, maxOutputTokens, false);
  }
  if (!first.functionCall) {
    return { kind: "text", text: first.text ?? "Przepraszam, wystąpił błąd. Spróbuj ponownie." };
  }

  const { name, args } = first.functionCall;
  log("tool_call", { convId: ctx.convId, name, args });

  if (name === "close_conversation") {
    await callAssistantTool("close_conversation", {}, ctx.userId, ctx.convId);
    return { kind: "closed" };
  }

  if (DETERMINISTIC_ACTIONS.has(name)) {
    const toolResult = await callAssistantTool(name, args, ctx.userId, ctx.convId);
    log("tool_result", { convId: ctx.convId, name, result: toolResult });
    if (toolResult.error) {
      return { kind: "text", text: directionsErrorMessage(toolResult) };
    }
    if (name === "get_fastest_arrival") {
      return { kind: "text", text: formatFastestArrival(toolResult) };
    }
    return { kind: "route", text: String(toolResult.route ?? "") };
  }

  // get_user_profile / allow_long_reply: wynik wraca do modelu, który układa właściwą odpowiedź
  const toolResult = await callAssistantTool(name, args, ctx.userId, ctx.convId);
  log("tool_result", { convId: ctx.convId, name, result: toolResult });

  const grantedParts = name === "allow_long_reply" && [1, 3, 4].includes(toolResult.granted_parts as number)
    ? (toolResult.granted_parts as 1 | 3 | 4)
    : undefined;

  const followupContents: GeminiContent[] = [
    ...contents,
    { role: "model", parts: [first.functionCallPart ?? { functionCall: { name, args } }] },
    { role: "function", parts: [{ functionResponse: { name, response: toolResult } }] },
  ];
  const followupMax = grantedParts ? TOKENS_FOR_PARTS[grantedParts] : maxOutputTokens;
  const second = await generateContent(followupContents, systemPrompt, followupMax);

  return { kind: "text", text: second.text ?? "Przepraszam, wystąpił błąd. Spróbuj ponownie.", grantedParts };
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
  type UserRow = { id: string; active: boolean; system_prompt: string | null };
  const usersByPhone = await sbGet(SB, KEY, `users?phone_number=eq.${encodeURIComponent(senderPhone)}&active=eq.true&select=id,active,system_prompt`) as UserRow[];

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

    matchedUsers = await sbGet(SB, KEY, `users?code=eq.${parsed.userCode}&active=eq.true&select=id,active,system_prompt`) as UserRow[];
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

  log("sms_in", { from: senderPhone, to: recipientDid, convCode, content: effectiveContent });

  // Znalezienie lub utworzenie rozmowy
  type Conv = { id: string; code: string; summary: string | null; reply_sms_parts: number };
  let conv: Conv | null = null;

  if (convCode) {
    const found = await sbGet(SB, KEY, `conversations?code=eq.${convCode}&user_id=eq.${userId}&status=eq.active&select=id,code,summary,reply_sms_parts`) as Conv[];
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
    const created = await sbGet(SB, KEY, `conversations?code=eq.${newCode}&select=id,code,summary,reply_sms_parts`) as Conv[];
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
  let replySmsParts = ([1, 3, 4].includes(conv.reply_sms_parts) ? conv.reply_sms_parts : 1) as 1 | 3 | 4;
  const suffix = `\n${convCodeFinal}`;

  // Zamknięcie rozmowy szybką ścieżką — bez angażowania modelu dla oczywistej intencji
  if (CLOSE_KEYWORDS.includes(effectiveContent.trim().toLowerCase())) {
    await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { status: "closed", pending_reply: null });
    log("conv_closed", { convId, convCode: convCodeFinal, userId, trigger: effectiveContent.trim() });
    return new Response(JSON.stringify({ ok: true, closed: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
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

  // Kompaktowanie historii — czysto techniczny krok utrzymania pamięci, osobny
  // od odpowiadania na wiadomość. Dzięki temu narzędzia (nawigacja, dłuższa
  // odpowiedź, zamknięcie rozmowy) działają zawsze, niezależnie od długości
  // rozmowy — nie tylko wtedy, gdy akurat nie trafiamy na próg kompaktowania.
  if (msgs.length >= COMPACT_THRESHOLD) {
    log("compaction", { convId, convCode: convCodeFinal, msgCount: msgs.length });
    const historyText = msgs.map((m) => `${m.direction === "in" ? "User" : "AI"}: ${m.content}`).join("\n");
    const summaryPrompt: GeminiContent[] = [{
      role: "user",
      parts: [{
        text: `Historia rozmowy SMS:\n${historyText}${summary ? `\n\nPoprzednie streszczenie: ${summary}` : ""}\n\nZadanie: zwróć wyłącznie zwięzłe, ale kompletne podsumowanie całej rozmowy — zachowaj wszystkie istotne fakty, ustalenia i kontekst potrzebny do dalszej rozmowy. Nie odpowiadaj na żadną wiadomość, tylko podsumuj.`,
      }],
    }];
    const summaryResult = await generateContent(
      summaryPrompt,
      "Jesteś systemem podsumowującym rozmowy SMS. Zwróć czysty tekst podsumowania, bez wstępów i bez JSON-a.",
      600,
      false, // bez narzędzi — to tylko streszczenie, nie odpowiedź na wiadomość
    );
    if (summaryResult.text) {
      summary = summaryResult.text;
      await sbDelete(SB, KEY, "messages", `conversation_id=eq.${convId}`);
      await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { summary });
      msgs.length = 0; // historia już w streszczeniu — nie dubluj jej w kontekście odpowiedzi
    } else {
      log("compaction_failed", { convId, convCode: convCodeFinal });
    }
  }

  // Kontekst dla AI — zawsze ta sama ścieżka, z narzędziami, niezależnie od tego,
  // czy chwilę wcześniej doszło do kompaktowania.
  const aiContents: GeminiContent[] = [];
  if (summary) aiContents.push({ role: "user", parts: [{ text: `[Kontekst rozmowy: ${summary}]` }] });
  for (const m of msgs) {
    aiContents.push({ role: m.direction === "in" ? "user" : "model", parts: [{ text: m.content }] });
  }
  aiContents.push({ role: "user", parts: [{ text: effectiveContent }] });

  let systemPrompt = userSystemPrompt ?? null;
  if (!systemPrompt) {
    const settings = await sbGet(SB, KEY, `settings?key=eq.system_prompt_default&select=value`) as Array<{ value: string }>;
    systemPrompt = settings[0]?.value ?? `Jesteś asystentem SMS. WAŻNE: ODPOWIADAJ MAKSYMALNIE ${SMS_PART_CHARS} ZNAKÓW. Żadnych linków URL. Tylko fakty, zero wstępów.`;
  }
  systemPrompt += `\n\nMasz dostęp do narzędzi: allow_long_reply, close_conversation, get_user_profile, get_directions, get_transit, get_fastest_arrival. Wywołuj je tylko gdy intencja użytkownika jest jednoznaczna — nigdy nie zgaduj. Wyniki nawigacji formatuje sam endpoint; nie twórz własnego formatu trasy. Bieżący limit długości Twojej odpowiedzi tekstowej to ${replySmsParts} SMS (${SMS_PART_CHARS * replySmsParts} znaków).`;

  const outcome: AssistantOutcome = await runAssistant(aiContents, systemPrompt, TOKENS_FOR_PARTS[replySmsParts], { userId, convId });

  // Zamknięcie rozmowy przez narzędzie — bez odpowiedzi SMS, zgodnie z ustaloną decyzją produktową
  if (outcome.kind === "closed") {
    await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "in", content: effectiveContent });
    log("conv_closed", { convId, convCode: convCodeFinal, userId, trigger: "tool" });
    return new Response(JSON.stringify({ ok: true, closed: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  if (outcome.kind === "text" && outcome.grantedParts) {
    replySmsParts = outcome.grantedParts;
    log("reply_sms_parts_granted", { convId, convCode: convCodeFinal, granted: replySmsParts });
  }

  const cleanReply = outcome.kind === "route" ? outcome.text : sanitizeForSms(stripUrls(outcome.text));
  const maxParts = outcome.kind === "route" ? 6 : replySmsParts;
  const parts = chunkForSms(cleanReply, maxParts);

  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "in", content: effectiveContent });
  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "out", content: cleanReply });
  await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, {
    last_activity_at: new Date().toISOString(),
    reply_sms_parts: replySmsParts,
    pending_reply: null,
  });

  log("ai_response", { convId, convCode: convCodeFinal, kind: outcome.kind, chars: cleanReply.length, parts: parts.length });

  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, dry_run: true, reply: parts.map((p) => `${p}${suffix}`).join("\n---\n"), parts: parts.length }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  try {
    for (const part of parts) {
      await sendSms(senderPhone, `${part}${suffix}`, recipientDid);
      sbPost(SB, KEY, "rpc/increment_sms_count", {}).catch(() => {});
    }
    log("sms_sent", { to: senderPhone, from: recipientDid, parts: parts.length });
  } catch (e) {
    log("sms_error", { to: senderPhone, from: recipientDid, error: String(e) });
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ ok: true, parts: parts.length }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
});
