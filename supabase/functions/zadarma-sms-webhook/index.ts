import { createHmac, createHash } from "node:crypto";

const ZADARMA_API_URL = "https://api.zadarma.com";
const COMPACT_THRESHOLD = 20; // wiadomości przed kompaktowaniem
const MAX_REPLY_CHARS = 153;  // 160 - '\n' - 6 cyfr kodu rozmowy

// --- Zadarma auth ---

function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

function buildAuth(path: string, params: Record<string, string>): string {
  const paramStr = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]).replace(/%20/g, "+")}`)
    .join("&");
  const hex = createHmac("sha1", Deno.env.get("ZADARMA_API_SECRET")!)
    .update(path + paramStr + md5Hex(paramStr))
    .digest("hex");
  return `${Deno.env.get("ZADARMA_API_KEY")}:${btoa(hex)}`;
}

async function sendSms(to: string, text: string, from: string): Promise<void> {
  const path = "/v1/sms/send/";
  const params = { number: to, message: text, caller_id: from };
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
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("GEMINI_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.0-flash",
        max_tokens: 200,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

async function callDeepSeek(messages: Array<{ role: string; content: string }>, system: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("DEEPSEEK_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 200,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

async function callClaude(messages: Array<{ role: string; content: string }>, system: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system,
        messages,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

type AiEntry = { id: string; enabled: boolean };

async function askAi(messages: Array<{ role: string; content: string }>, system: string, config: AiEntry[]): Promise<string> {
  const callers: Record<string, (m: typeof messages, s: string) => Promise<string | null>> = {
    gemini: callGemini,
    claude: callClaude,
    deepseek: callDeepSeek,
  };
  for (const { id, enabled } of config) {
    if (!enabled) continue;
    const result = await callers[id]?.(messages, system);
    if (result) return result;
  }
  return "Przepraszam, wystąpił błąd. Spróbuj ponownie.";
}

// --- Handler ---

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    const echo = new URL(req.url).searchParams.get("zd_echo");
    return new Response(echo ?? "OK", { status: 200 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let raw: Record<string, string>;
  try {
    const ct = req.headers.get("content-type") ?? "";
    raw = ct.includes("application/json")
      ? await req.json()
      : Object.fromEntries(new URLSearchParams(await req.text()));
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (raw.zd_echo) return new Response(raw.zd_echo, { status: 200 });

  const SB = Deno.env.get("SUPABASE_URL")!;
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Zapisz raw payload do webhook_logs
  await sbPost(SB, KEY, "webhook_logs", { raw_payload: raw });

  const event = (raw.event ?? "").toLowerCase();
  if (event !== "sms" && event !== "incoming_sms") return new Response("Ignored", { status: 200 });

  // Zadarma może wysłać dane SMS bezpośrednio lub zagnieżdżone w polu result (JSON string)
  let data: Record<string, string> = raw;
  if (raw.result && typeof raw.result === "string") {
    try { data = { ...raw, ...JSON.parse(raw.result) }; } catch { /* ignore */ }
  }

  const senderPhone = data.sms_from ?? data.caller_id ?? "";
  const recipientDid = data.sms_to ?? data.caller_did ?? data.called_did ?? "";
  const smsBody = data.msg ?? data.text ?? "";
  if (!senderPhone || !smsBody) return new Response("Missing fields", { status: 400 });

  const { userCode, convCode, content } = parseSms(smsBody);
  if (!content) return new Response("Empty content", { status: 200 });

  // Identyfikacja użytkownika
  const users = await sbGet(SB, KEY, `users?code=eq.${userCode}&select=id,active,system_prompt`) as Array<{ id: string; active: boolean; system_prompt: string | null }>;
  if (!users.length || !users[0].active) {
    return new Response("Unknown user", { status: 200 });
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

  if (!conv) return new Response("Failed to create conversation", { status: 500 });

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
    systemPrompt = settings[0]?.value ?? `Jesteś pomocnym asystentem AI działającym przez SMS. Odpowiadaj maksymalnie ${MAX_REPLY_CHARS} znaków. Bądź zwięzły i konkretny.`;
  }

  // Konfiguracja kolejki AI
  const aiConfigRows = await sbGet(SB, KEY, `settings?key=eq.ai_config&select=value`) as Array<{ value: string }>;
  let aiConfig: AiEntry[] = [{ id: "gemini", enabled: true }, { id: "deepseek", enabled: true }];
  try { if (aiConfigRows[0]?.value) aiConfig = JSON.parse(aiConfigRows[0].value); } catch { /* fallback */ }

  // Wywołaj AI
  const rawReply = await askAi(aiMessages, systemPrompt, aiConfig);
  let aiReply: string;

  if (needsCompaction) {
    try {
      const json = JSON.parse(rawReply.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      summary = (json.summary ?? "").slice(0, 300);
      aiReply = (json.reply ?? rawReply).slice(0, MAX_REPLY_CHARS);
      // Usuń stare wiadomości i zapisz summary PRZED zapisem nowych
      await sbDelete(SB, KEY, "messages", `conversation_id=eq.${convId}`);
      await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { summary });
    } catch {
      aiReply = rawReply.slice(0, MAX_REPLY_CHARS);
    }
  } else {
    aiReply = rawReply.slice(0, MAX_REPLY_CHARS);
  }

  // Zapis wiadomości użytkownika i odpowiedzi

  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "in", content });
  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "out", content: aiReply });

  // Aktualizuj aktywność
  await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { last_activity_at: new Date().toISOString() });

  // Zabezpieczenie: upewnij się że aiReply + '\n' + kod nie przekracza 160 znaków
  const suffix = `\n${convCodeFinal}`;
  const safeReply = aiReply.slice(0, 160 - suffix.length);

  // Wyślij SMS
  await sendSms(senderPhone, `${safeReply}${suffix}`, recipientDid);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
