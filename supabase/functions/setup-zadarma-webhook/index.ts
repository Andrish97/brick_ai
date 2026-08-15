import { createHmac, createHash } from "node:crypto";

const ZADARMA_API_URL = "https://api.zadarma.com";

function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

// Zadarma (backend PHP) podpisuje żądanie stringiem zbudowanym jak PHP-owe
// urlencode()/http_build_query z PHP_QUERY_RFC1738 — koduje procentowo wszystko
// poza literami/cyframi/"-_.", spacja to "+". encodeURIComponent zostawia !~*'()
// niekodowane, więc phpUrlEncode() to koryguje. Kolejność parametrów w podpisie
// i w treści żądania musi być identyczna — dziś każde wywołanie ma tu maks. 1
// parametr (kolejność bez znaczenia), ale sortedParamString() zabezpiecza przed
// tym samym błędem, gdyby ktoś kiedyś dodał drugi parametr.
function phpUrlEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/%20/g, "+")
    .replace(/[!~*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

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

async function zadarmaReq(method: string, path: string, params: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const isGet = method === "GET";
  const qs = isGet && Object.keys(params).length ? "?" + sortedParamString(params) : "";
  const res = await fetch(`${ZADARMA_API_URL}${path}${qs}`, {
    method,
    headers: { Authorization: buildAuth(path, params), ...(isGet ? {} : { "Content-Type": "application/x-www-form-urlencoded" }) },
    ...(isGet ? {} : { body: sortedParamString(params) }),
  });
  return { status: res.status, body: await res.json() };
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("INTERNAL_SECRET");
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const webhookUrl = `${supabaseUrl}/functions/v1/zadarma-sms-webhook`;

  const getResult = await zadarmaReq("GET", "/v1/pbx/webhooks/", {});
  const current = getResult.body as { url?: string; hooks?: { sms?: string } };

  const urlAlreadySet = current?.url === webhookUrl;
  const smsAlreadyEnabled = current?.hooks?.sms === "true";

  const urlResult = urlAlreadySet
    ? { status: 200, body: { status: "skipped", message: "URL already set" } }
    : await zadarmaReq("POST", "/v1/pbx/webhooks/url/", { url: webhookUrl });

  const hooksResult = smsAlreadyEnabled
    ? { status: 200, body: { status: "skipped", message: "SMS hooks already enabled" } }
    : await zadarmaReq("POST", "/v1/pbx/webhooks/hooks/", { sms: "true" });

  return new Response(JSON.stringify({ webhookUrl, urlResult, hooksResult }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
