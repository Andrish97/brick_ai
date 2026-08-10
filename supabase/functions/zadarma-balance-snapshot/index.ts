import { createHmac, createHash } from "node:crypto";

const ZADARMA_API_URL = "https://api.zadarma.com";

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

// Wywoływana wyłącznie przez cron w Supabase (pg_cron + pg_net) — nie ma tu sesji
// admina, więc zamiast weryfikacji JWT jest wspólny sekret INTERNAL_SECRET — ten
// sam, który autoryzuje każdą wewnętrzną, niepubliczną funkcję w tym projekcie
// (patrz też setup-zadarma-webhook).
Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("INTERNAL_SECRET");
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const path = "/v1/info/balance/";
  const res = await fetch(`${ZADARMA_API_URL}${path}`, { headers: { Authorization: buildAuth(path, {}) } });
  const body = await res.json().catch(() => null);

  if (!res.ok || !body || body.balance === undefined) {
    return new Response(JSON.stringify({ ok: false, status: res.status, body }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const balance = parseFloat(body.balance);
  const currency = body.currency ?? null;

  const SB = Deno.env.get("SUPABASE_URL")!;
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  await fetch(`${SB}/rest/v1/balance_observations`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ balance, currency, trigger: "periodic" }),
  });

  return new Response(JSON.stringify({ ok: true, balance, currency }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
