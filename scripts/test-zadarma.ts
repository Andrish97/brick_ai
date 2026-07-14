/**
 * Test połączenia z Zadarma API
 * Użycie: deno run --allow-net scripts/test-zadarma.ts <API_KEY> <API_SECRET>
 */
import { createHmac, createHash } from "node:crypto";

const API_KEY = Deno.args[0];
const API_SECRET = Deno.args[1];

if (!API_KEY || !API_SECRET) {
  console.error("Użycie: deno run --allow-net scripts/test-zadarma.ts <API_KEY> <API_SECRET>");
  Deno.exit(1);
}

function redact(text: string): string {
  return text.replaceAll(API_KEY, "***KEY***").replaceAll(API_SECRET, "***SECRET***");
}

function log(label: string, value: unknown) {
  const str = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  console.log(label, redact(str));
}

function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

function hmacSha1Base64(secret: string, data: string): string {
  // PHP hash_hmac zwraca hex, a base64_encode koduje ten hex string — nie binarny output
  const hex = createHmac("sha1", secret).update(data).digest("hex");
  return btoa(hex);
}

// PHP http_build_query RFC1738: spaces as +, standard percent-encoding otherwise
function httpBuildQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]).replace(/%20/g, "+")}`)
    .join("&");
}

function buildAuth(path: string, params: Record<string, string> = {}): string {
  const paramStr = httpBuildQuery(params);
  const sign = hmacSha1Base64(API_SECRET, path + paramStr + md5Hex(paramStr));
  return `${API_KEY}:${sign}`;
}

async function zadarmaGet(path: string, params: Record<string, string> = {}) {
  const auth = buildAuth(path, params);
  const paramStr = Object.keys(params).sort().map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const url = `https://api.zadarma.com${path}${paramStr ? "?" + paramStr : ""}`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  return { status: res.status, body: await res.json() };
}

async function zadarmaPost(path: string, params: Record<string, string>) {
  const auth = buildAuth(path, params);
  const res = await fetch(`https://api.zadarma.com${path}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.json() };
}

console.log("=== Test 1: balans konta ===");
const info = await zadarmaGet("/v1/info/balance/");
console.log("Status:", info.status);
log("", info.body);

// Test wysyłki SMS — podaj numer docelowy jako 3. argument
const TO = Deno.args[2];
if (TO) {
  console.log(`\n=== Test 2: wysyłka SMS na ${TO} ===`);
  const sms = await zadarmaPost("/v1/sms/send/", { number: TO, message: "Test SMS z Zadarma AI Agent", caller_id: "48459569689" });
  console.log("Status:", sms.status);
  log("", sms.body);
}
