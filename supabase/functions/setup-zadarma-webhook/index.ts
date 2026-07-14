import { createHmac, createHash } from "node:crypto";

const ZADARMA_API_URL = "https://api.zadarma.com";

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

async function zadarmaReq(method: string, path: string, params: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ZADARMA_API_URL}${path}`, {
    method,
    headers: { Authorization: buildAuth(path, params), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.json() };
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("SETUP_SECRET");
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const webhookUrl = `${supabaseUrl}/functions/v1/zadarma-sms-webhook`;

  const urlResult = await zadarmaReq("POST", "/v1/pbx/webhooks/url/", { url: webhookUrl });
  const hooksResult = await zadarmaReq("POST", "/v1/pbx/webhooks/hooks/", { sms: "true" });

  return new Response(JSON.stringify({ webhookUrl, urlResult, hooksResult }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
