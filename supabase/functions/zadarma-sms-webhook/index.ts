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

async function callDeepSeek(messages: Array<{ role: string; content: string }>, system: string): Promise<string> {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("DEEPSEEK_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      max_tokens: 200,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  const data = await res.json();
  return data.choices[0].message.content;
}

async function askAi(messages: Array<{ role: string; content: string }>, system: string): Promise<string> {
  return (await callGemini(messages, system)) ?? (await callDeepSeek(messages, system));
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
  if (raw.event !== "sms" && raw.event !== "incoming_sms") return new Response("Ignored", { status: 200 });

  const senderPhone = raw.sms_from ?? raw.caller_id ?? "";
  const recipientDid = raw.sms_to ?? raw.called_did ?? "";
  const smsBody = raw.msg ?? "";
  if (!senderPhone || !smsBody) return new Response("Missing fields", { status: 400 });

  const { userCode, convCode, content } = parseSms(smsBody);
  const SB = Deno.env.get("SUPABASE_URL")!;
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Identyfikacja użytkownika
  const users = await sbGet(SB, KEY, `users?code=eq.${userCode}&select=id,active`) as Array<{ id: string; active: boolean }>;
  if (!users.length || !users[0].active) {
    await sendSms(senderPhone, "Nieznany kod użytkownika.", recipientDid);
    return new Response("Unknown user", { status: 200 });
  }
  const userId = users[0].id;

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
    conv = created[0];
  }

  const convId = conv.id;
  const convCodeFinal = conv.code;
  let summary = conv.summary ?? null;

  // Historia wiadomości
  type Msg = { direction: string; content: string };
  const msgs = await sbGet(SB, KEY, `messages?conversation_id=eq.${convId}&order=created_at.asc&select=direction,content`) as Msg[];

  // Kompaktowanie jeśli za dużo wiadomości
  if (msgs.length >= COMPACT_THRESHOLD) {
    const historyText = msgs.map((m) => `${m.direction === "in" ? "User" : "AI"}: ${m.content}`).join("\n");
    const newSummary = await askAi(
      [{ role: "user", content: `Skompaktuj poniższą rozmowę do max 300 znaków, zachowując kluczowy kontekst:\n\n${historyText}` }],
      "Jesteś asystentem kompaktującym rozmowy. Odpowiedz tylko podsumowaniem, bez komentarzy.",
    );
    summary = newSummary.slice(0, 300);
    await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { summary });
    await sbDelete(SB, KEY, "messages", `conversation_id=eq.${convId}`);
  }

  // Kontekst dla AI
  const aiMessages: Array<{ role: string; content: string }> = [];
  if (summary) aiMessages.push({ role: "user", content: `[Kontekst rozmowy: ${summary}]` });
  if (msgs.length < COMPACT_THRESHOLD) {
    for (const m of msgs) {
      aiMessages.push({ role: m.direction === "in" ? "user" : "assistant", content: m.content });
    }
  }
  aiMessages.push({ role: "user", content });

  const systemPrompt = `Jesteś pomocnym asystentem AI działającym przez SMS. Odpowiadaj maksymalnie ${MAX_REPLY_CHARS} znaków. Bądź zwięzły i konkretny.`;

  // Zapis wiadomości użytkownika
  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "in", content });

  // Wywołaj AI
  const aiReply = (await askAi(aiMessages, systemPrompt)).slice(0, MAX_REPLY_CHARS);

  // Zapis odpowiedzi
  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "out", content: aiReply });

  // Aktualizuj aktywność
  await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { last_activity_at: new Date().toISOString() });

  // Wyślij SMS
  await sendSms(senderPhone, `${aiReply}\n${convCodeFinal}`, recipientDid);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
