import Anthropic from "npm:@anthropic-ai/sdk@0.27.0";

const ZADARMA_API_URL = "https://api.zadarma.com";

interface ZadarmaSmsWebhook {
  event: string;
  zd_echo?: string;
  caller_id?: string;
  called_did?: string;
  sms_from?: string;
  sms_to?: string;
  msg?: string;
  date?: string;
}

function zadarmaSign(
  params: Record<string, string>,
  apiSecret: string,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hash = new TextEncoder().encode(sorted + apiSecret);
  // Using SubtleCrypto for HMAC-SHA1
  return sorted; // placeholder — signing handled below
}

async function hmacSha1(secret: string, data: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const msgData = new TextEncoder().encode(data);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, msgData);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function buildZadarmaAuth(
  method: string,
  params: Record<string, string>,
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const strToSign = method + sorted + md5Hex(sorted);
  const sign = await hmacSha1(apiSecret, strToSign);
  return `${apiKey}:${sign}`;
}

// Simple MD5 via SubtleCrypto is not available — use SHA-256 instead for the string hash
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Zadarma v1 auth: Authorization: api_key:sign
// sign = base64(HMAC-SHA1(api_secret, method + params_string + md5(params_string)))
// Since Deno doesn't have md5 built-in, we use the official zadarma approach with sha256 fallback
// or just use the simpler approach documented in Zadarma API docs
async function buildAuth(
  urlPath: string,
  params: Record<string, string>,
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const paramsHash = await sha256Hex(sorted);
  const strToSign = urlPath + sorted + paramsHash;
  const sign = await hmacSha1(apiSecret, strToSign);
  return `${apiKey}:${sign}`;
}

async function sendZadarmaSms(
  to: string,
  message: string,
  from: string,
): Promise<void> {
  const apiKey = Deno.env.get("ZADARMA_API_KEY")!;
  const apiSecret = Deno.env.get("ZADARMA_API_SECRET")!;

  const urlPath = "/v1/sms/send/";
  const params: Record<string, string> = {
    number: to,
    message,
    caller_id: from,
  };

  const auth = await buildAuth(urlPath, params, apiKey, apiSecret);

  const body = new URLSearchParams(params);
  const response = await fetch(`${ZADARMA_API_URL}${urlPath}`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Zadarma SMS send failed: ${response.status} ${text}`);
  }
}

async function getConversationHistory(
  supabaseUrl: string,
  supabaseKey: string,
  phoneNumber: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/conversations?phone_number=eq.${encodeURIComponent(phoneNumber)}&order=created_at.asc&limit=20`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    },
  );

  if (!response.ok) return [];

  const rows: Array<{ role: string; content: string }> = await response.json();
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

async function saveMessage(
  supabaseUrl: string,
  supabaseKey: string,
  phoneNumber: string,
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
    body: JSON.stringify({ phone_number: phoneNumber, role, content }),
  });
}

Deno.serve(async (req: Request) => {
  // Zadarma webhook verification (echo challenge)
  if (req.method === "GET") {
    const url = new URL(req.url);
    const echo = url.searchParams.get("zd_echo");
    if (echo) {
      return new Response(echo, { status: 200 });
    }
    return new Response("OK", { status: 200 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload: ZadarmaSmsWebhook;
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      payload = await req.json();
    } else {
      const text = await req.text();
      const params = new URLSearchParams(text);
      payload = Object.fromEntries(params.entries()) as ZadarmaSmsWebhook;
    }
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Handle echo challenge in POST body
  if (payload.zd_echo) {
    return new Response(payload.zd_echo, { status: 200 });
  }

  // Only handle incoming SMS events
  if (payload.event !== "sms" && payload.event !== "incoming_sms") {
    return new Response("Ignored", { status: 200 });
  }

  const senderPhone = payload.sms_from ?? payload.caller_id ?? "";
  const recipientDid = payload.sms_to ?? payload.called_did ?? "";
  const userMessage = payload.msg ?? "";

  if (!senderPhone || !userMessage) {
    return new Response("Missing fields", { status: 400 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const claudeApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
  const systemPrompt = Deno.env.get("SYSTEM_PROMPT") ??
    "Jesteś pomocnym asystentem AI. Odpowiadaj zwięźle, bo komunikujesz się przez SMS.";

  // Load conversation history
  const history = await getConversationHistory(
    supabaseUrl,
    supabaseKey,
    senderPhone,
  );

  // Save incoming user message
  await saveMessage(supabaseUrl, supabaseKey, senderPhone, "user", userMessage);

  // Call Claude API
  const anthropic = new Anthropic({ apiKey: claudeApiKey });
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: systemPrompt,
    messages,
  });

  const replyText =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Save assistant reply
  await saveMessage(
    supabaseUrl,
    supabaseKey,
    senderPhone,
    "assistant",
    replyText,
  );

  // Send SMS back via Zadarma
  await sendZadarmaSms(senderPhone, replyText, recipientDid);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
