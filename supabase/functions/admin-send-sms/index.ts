import { createHmac, createHash } from "node:crypto";

// Globalny w środowisku Supabase Edge Functions (Deno Deploy) — pozwala kontynuować
// pracę w tle po zwróceniu odpowiedzi HTTP. Brak w standardowych typach Deno.
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;

const ZADARMA_API_URL = "https://api.zadarma.com";

// --- Zadarma auth ---

function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

// Zadarma (backend PHP) podpisuje żądanie stringiem zbudowanym jak PHP-owe
// urlencode()/http_build_query z PHP_QUERY_RFC1738: procentowo kodowane jest
// WSZYSTKO poza literami, cyframi i "-_.", a spacja to "+" — inaczej niż JS-owy
// encodeURIComponent, który zostawia !~*'() niekodowane. Jeśli treść SMS-a
// zawiera taki znak, źle zakodowany parametr psuje podpis → 401 mimo poprawnego
// klucza/sekretu. phpUrlEncode() naprawia to dokładnie do zachowania PHP.
function phpUrlEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/%20/g, "+")
    .replace(/[!~*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// Kolejność parametrów w podpisie i w treści żądania musi być identyczna (Zadarma
// podpisuje posortowane alfabetycznie parametry) — sortedParamString() jest jedynym
// miejscem budującym ten string, używane identycznie do podpisu i do treści żądania.
function sortedParamString(params: Record<string, string>): string {
  return Object.keys(params).sort()
    .map((k) => `${k}=${phpUrlEncode(params[k])}`)
    .join("&");
}

function buildAuth(path: string, params: Record<string, string>): string {
  const paramStr = sortedParamString(params);
  const hex = createHmac("sha1", Deno.env.get("ZADARMA_API_SECRET")!)
    .update(path + paramStr + md5Hex(paramStr))
    .digest("hex");
  return `${Deno.env.get("ZADARMA_API_KEY")}:${btoa(hex)}`;
}

async function getZadarmaBalance(): Promise<number | null> {
  try {
    const path = "/v1/info/balance/";
    const res = await fetch(`${ZADARMA_API_URL}${path}`, { headers: { Authorization: buildAuth(path, {}) } });
    const body = await res.json();
    if (body?.balance === undefined) return null;
    return parseFloat(body.balance);
  } catch {
    return null;
  }
}

function sbHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" };
}

async function sbPost(url: string, key: string, table: string, body: object): Promise<void> {
  await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers: sbHeaders(key), body: JSON.stringify(body) });
}

// --- JWT verification ---

async function verifyJwt(token: string): Promise<boolean> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
      },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// --- Handler ---

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // Verify JWT
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const isValid = await verifyJwt(token);
  if (!isValid) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // Parse body
  let body: { phone: string; message: string; caller_id: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const { phone, message, caller_id } = body;
  if (!phone || !message || !caller_id) {
    return new Response(JSON.stringify({ error: "Missing required fields: phone, message, caller_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Saldo tuż przed wysyłką — gęstszy strumień obserwacji zmniejsza ryzyko, że
  // doładowanie/opłata trafi w to samo okno co ta wysyłka (patrz zadarma-sms-webhook).
  const balanceBefore = await getZadarmaBalance();
  if (balanceBefore !== null) {
    sbPost(supabaseUrl, serviceRoleKey, "balance_observations", { balance: balanceBefore, trigger: "pre_send" }).catch(() => {});
  }

  // Send SMS via Zadarma
  try {
    const path = "/v1/sms/send/";
    // Aktualna dokumentacja Zadarmy nazywa ten parametr "sender", nie "caller_id".
    const params = { number: phone, message, sender: caller_id };
    const res = await fetch(`${ZADARMA_API_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: buildAuth(path, params),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: sortedParamString(params),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Zadarma error: ${res.status} ${bodyText}` }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    let data: unknown = bodyText;
    try { data = JSON.parse(bodyText); } catch { /* nie JSON — ufamy HTTP 200 */ }
    // HTTP 200 z treścią jawnie mówiącą o błędzie — nie liczymy jako sukces mimo statusu.
    if (data && typeof data === "object" && (data as { status?: string }).status === "error") {
      return new Response(JSON.stringify({ error: `Zadarma error: HTTP 200 ale status=error: ${bodyText}` }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    sbPost(supabaseUrl, serviceRoleKey, "sms_sends", { parts_sent: 1, source: "admin" }).catch(() => {});
    const afterCheck = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const balanceAfter = await getZadarmaBalance();
      if (balanceAfter !== null) {
        await sbPost(supabaseUrl, serviceRoleKey, "balance_observations", { balance: balanceAfter, trigger: "post_send" });
      }
    })();
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(afterCheck);

    return new Response(JSON.stringify({ ok: true, zadarma: data }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
