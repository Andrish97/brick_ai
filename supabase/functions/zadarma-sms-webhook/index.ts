import { createHmac, createHash } from "node:crypto";

const ZADARMA_API_URL = "https://api.zadarma.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const COMPACT_THRESHOLD = 20; // wiadomości przed kompaktowaniem
const MAX_REPLY_CHARS = 153;  // 160 - '\n' - 6 cyfr kodu rozmowy

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

function parseSms(body: string): { userCode: string; convCode: string | null; content: string } {
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

async function callGemini(messages: Array<{ role: string; content: string }>, system: string): Promise<string | null> {
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
          generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } },
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

async function askAi(messages: Array<{ role: string; content: string }>, system: string): Promise<string> {
  return (await callGemini(messages, system)) ?? "Przepraszam, wystąpił błąd. Spróbuj ponownie.";
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
  if (event !== "sms" && event !== "incoming_sms") return new Response("Ignored", { status: 200, headers: CORS });

  // Zadarma może wysłać dane SMS bezpośrednio lub zagnieżdżone w polu result (JSON string)
  let data: Record<string, string> = raw;
  if (raw.result && typeof raw.result === "string") {
    try { data = { ...raw, ...JSON.parse(raw.result) }; } catch { /* ignore */ }
  }

  const senderPhone = data.sms_from ?? data.caller_id ?? "";
  const recipientDid = data.sms_to ?? data.caller_did ?? data.called_did ?? "";
  const smsBody = data.msg ?? data.text ?? "";
  if (!senderPhone || !smsBody) return new Response("Missing fields", { status: 400, headers: CORS });

  const { userCode, convCode, content } = parseSms(smsBody);
  if (!content) return new Response("Empty content", { status: 200, headers: CORS });

  log("sms_in", { from: senderPhone, userCode, convCode, content });

  // Identyfikacja użytkownika
  const users = await sbGet(SB, KEY, `users?code=eq.${userCode}&select=id,active,system_prompt`) as Array<{ id: string; active: boolean; system_prompt: string | null }>;
  if (!users.length || !users[0].active) {
    log("error", { reason: "unknown_user", userCode, from: senderPhone });
    return new Response("Unknown user", { status: 200, headers: CORS });
  }
  const userId = users[0].id;
  const userSystemPrompt = users[0].system_prompt ?? null;

  // Znalezienie lub utworzenie rozmowy
  type Conv = { id: string; code: string; summary: string | null };
  let conv: Conv | null = null;

  if (convCode) {
    const found = await sbGet(SB, KEY, `conversations?code=eq.${convCode}&user_id=eq.${userId}&status=eq.active&select=id,code,summary`) as Conv[];
    conv = found[0] ?? null;
  }

  if (!conv) {
    let newCode = "";
    for (let i = 0; i < 10; i++) {
      newCode = generateCode(6);
      const existing = await sbGet(SB, KEY, `conversations?code=eq.${newCode}&select=id`);
      if (!existing.length) break;
    }
    await sbPost(SB, KEY, "conversations", { user_id: userId, code: newCode, status: "active" });
    const created = await sbGet(SB, KEY, `conversations?code=eq.${newCode}&select=id,code,summary`) as Conv[];
    conv = created[0] ?? null;
  }

  if (!conv) return new Response("Failed to create conversation", { status: 500, headers: CORS });

  const convId = conv.id;
  const convCodeFinal = conv.code;
  let summary = conv.summary ?? null;

  // Historia wiadomości
  type Msg = { direction: string; content: string };
  const msgs = await sbGet(SB, KEY, `messages?conversation_id=eq.${convId}&order=created_at.asc&select=direction,content`) as Msg[];

  // Kontekst dla AI
  const aiMessages: Array<{ role: string; content: string }> = [];
  let needsCompaction = false;

  if (msgs.length >= COMPACT_THRESHOLD) {
    // Jedno wywołanie AI: kompaktowanie + odpowiedź
    needsCompaction = true;
    const historyText = msgs.map((m) => `${m.direction === "in" ? "User" : "AI"}: ${m.content}`).join("\n");
    aiMessages.push({
      role: "user",
      content: `Historia rozmowy:\n${historyText}\n\nNowa wiadomość: ${content}\n\nOdpowiedz w JSON: {"summary":"max 300 znaków podsumowanie historii","reply":"odpowiedź max ${MAX_REPLY_CHARS} znaków"}`,
    });
  } else {
    if (summary) aiMessages.push({ role: "user", content: `[Kontekst rozmowy: ${summary}]` });
    for (const m of msgs) {
      aiMessages.push({ role: m.direction === "in" ? "user" : "assistant", content: m.content });
    }
    aiMessages.push({ role: "user", content });
  }

  let systemPrompt = userSystemPrompt ?? null;
  if (!systemPrompt) {
    const settings = await sbGet(SB, KEY, `settings?key=eq.system_prompt_default&select=value`) as Array<{ value: string }>;
    systemPrompt = settings[0]?.value ?? `Jesteś asystentem SMS. WAŻNE: ODPOWIADAJ MAKSYMALNIE ${MAX_REPLY_CHARS} ZNAKÓW. Żadnych linków URL. Tylko fakty, zero wstępów.`;
  }

  // Wywołaj AI
  const rawReply = await askAi(aiMessages, systemPrompt);
  let aiReply: string;

  if (needsCompaction) {
    try {
      const json = JSON.parse(rawReply.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      summary = (json.summary ?? "").slice(0, 300);
      aiReply = smartTrim(stripUrls(json.reply ?? rawReply), MAX_REPLY_CHARS);
      // Usuń stare wiadomości i zapisz summary PRZED zapisem nowych
      await sbDelete(SB, KEY, "messages", `conversation_id=eq.${convId}`);
      await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { summary });
    } catch {
      aiReply = smartTrim(rawReply, MAX_REPLY_CHARS);
    }
  } else {
    aiReply = smartTrim(stripUrls(rawReply), MAX_REPLY_CHARS);
  }

  // Zapis wiadomości użytkownika i odpowiedzi

  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "in", content });
  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "out", content: aiReply });

  // Aktualizuj aktywność
  await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { last_activity_at: new Date().toISOString() });

  log("ai_response", { convId, convCode: convCodeFinal, reply: aiReply, chars: aiReply.length });

  // Zabezpieczenie: upewnij się że aiReply + '\n' + kod nie przekracza 160 znaków
  const suffix = `\n${convCodeFinal}`;
  const safeReply = aiReply.slice(0, 160 - suffix.length);

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
