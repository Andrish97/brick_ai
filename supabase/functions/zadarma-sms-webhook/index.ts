import { createHmac, createHash } from "node:crypto";

const ZADARMA_API_URL = "https://api.zadarma.com";

interface ZadarmaSmsWebhook {
  event?: string;
  zd_echo?: string;
  caller_id?: string;
  called_did?: string;
  sms_from?: string;
  sms_to?: string;
  msg?: string;
}

function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

// Zadarma auth: base64(hex(HMAC-SHA1)) — PHP hash_hmac zwraca hex, base64_encode koduje ten hex
function buildAuth(path: string, params: Record<string, string>, apiKey: string, apiSecret: string): string {
  const paramStr = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]).replace(/%20/g, "+")}`)
    .join("&");
  const hex = createHmac("sha1", apiSecret).update(path + paramStr + md5Hex(paramStr)).digest("hex");
  const sign = btoa(hex);
  return `${apiKey}:${sign}`;
}

async function sendZadarmaSms(to: string, message: string, from: string): Promise<void> {
  const apiKey = Deno.env.get("ZADARMA_API_KEY")!;
  const apiSecret = Deno.env.get("ZADARMA_API_SECRET")!;
  const path = "/v1/sms/send/";
  const params: Record<string, string> = { number: to, message, caller_id: from };
  const auth = buildAuth(path, params, apiKey, apiSecret);

  const res = await fetch(`${ZADARMA_API_URL}${path}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

  if (!res.ok) {
    throw new Error(`Zadarma SMS send failed: ${res.status} ${await res.text()}`);
  }
}

async function getHistory(
  supabaseUrl: string,
  supabaseKey: string,
  phone: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/conversations?phone_number=eq.${encodeURIComponent(phone)}&order=created_at.asc&limit=20`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return [];
  const rows: Array<{ role: string; content: string }> = await res.json();
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

async function saveMessage(
  supabaseUrl: string,
  supabaseKey: string,
  phone: string,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/conversations`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ phone_number: phone, role, content }),
  });
}

Deno.serve(async (req: Request) => {
  // Echo challenge (GET)
  if (req.method === "GET") {
    const echo = new URL(req.url).searchParams.get("zd_echo");
    return new Response(echo ?? "OK", { status: 200 });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let payload: ZadarmaSmsWebhook;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      payload = await req.json();
    } else {
      payload = Object.fromEntries(new URLSearchParams(await req.text())) as ZadarmaSmsWebhook;
    }
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Echo challenge (POST body)
  if (payload.zd_echo) return new Response(payload.zd_echo, { status: 200 });

  if (payload.event !== "sms" && payload.event !== "incoming_sms") {
    return new Response("Ignored", { status: 200 });
  }

  const senderPhone = payload.sms_from ?? payload.caller_id ?? "";
  const recipientDid = payload.sms_to ?? payload.called_did ?? "";
  const userMessage = payload.msg ?? "";

  if (!senderPhone || !userMessage) return new Response("Missing fields", { status: 400 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const systemPrompt = "Jesteś pomocnym asystentem AI. Odpowiadaj zwięźle, bo komunikujesz się przez SMS.";

  const history = await getHistory(supabaseUrl, supabaseKey, senderPhone);
  await saveMessage(supabaseUrl, supabaseKey, senderPhone, "user", userMessage);

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  async function callGemini(): Promise<string | null> {
    try {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("GEMINI_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "gemini-2.0-flash", max_tokens: 300, messages }),
        },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? null;
    } catch {
      return null;
    }
  }

  async function callDeepSeek(): Promise<string> {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("DEEPSEEK_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek-chat", max_tokens: 300, messages }),
    });
    const data = await res.json();
    return data.choices[0].message.content;
  }

  const reply = (await callGemini()) ?? (await callDeepSeek());

  await saveMessage(supabaseUrl, supabaseKey, senderPhone, "assistant", reply);
  await sendZadarmaSms(senderPhone, reply, recipientDid);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
