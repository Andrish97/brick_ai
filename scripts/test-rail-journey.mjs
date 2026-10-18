const projectRef = process.env.SUPABASE_PROJECT_REF || "rjnqpenbjyeiygedjvzk";
const from = required("FROM_STATION");
const to = required("TO_STATION");
const date = (process.env.TRAVEL_DATE || "jutro").trim();
const time = (process.env.PREFERRED_TIME || "rano").trim();
const grantedParts = Number(process.env.REPLY_PARTS || 4);
const expectedSource = (process.env.EXPECTED_SOURCE || "any").trim();
const expectRoute = process.env.EXPECT_ROUTE === "true";
const expectedLegs = (process.env.EXPECTED_LEGS || "any").trim();
const expectedVariants = Number(process.env.EXPECTED_VARIANTS || 0);
const expectedText = (process.env.EXPECTED_TEXT || "").trim();
const allowLiveFallback = process.env.ALLOW_LIVE_FALLBACK === "true";

if (![1, 3, 4].includes(grantedParts)) throw new Error("REPLY_PARTS musi wynosić 1, 3 albo 4.");
if (!["any", "local", "live"].includes(expectedSource)) throw new Error("EXPECTED_SOURCE musi wynosić any, local albo live.");
if (!["any", "one", "multiple"].includes(expectedLegs)) throw new Error("EXPECTED_LEGS musi wynosić any, one albo multiple.");
if (!Number.isInteger(expectedVariants) || expectedVariants < 0 || expectedVariants > 3) throw new Error("EXPECTED_VARIANTS musi wynosić 0–3.");

const url = process.env.TEST_ENDPOINT_URL || `https://${projectRef}.supabase.co/functions/v1/zadarma-sms-webhook?endpoint_test=1`;
const question = `Jak dojadę pociągiem z ${from} do ${to} ${date} ${time}?`;
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ event: "incoming_sms", msg: question, history: [], grantedParts, testLocalOnly: !allowLiveFallback }),
  signal: AbortSignal.timeout(120_000),
});
const raw = await response.text();
let result;
try { result = JSON.parse(raw); } catch { throw new Error(`Endpoint zwrócił niepoprawny JSON (HTTP ${response.status}): ${raw}`); }
if (!response.ok || result.ok !== true || result.test_mode !== true) {
  throw new Error(`Test endpointu nie powiódł się (HTTP ${response.status}): ${result.error || raw}`);
}

const journey = Array.isArray(result.journey_trace) ? result.journey_trace.at(-1) : null;
if (!journey) throw new Error(`Gemini nie wywołał plan_train_journey. Odpowiedź: ${result.reply || "(pusta)"}`);
const source = journey.result?.route_source;
if (source !== "local" && source !== "live") {
  throw new Error(`Planer nie zwrócił ścieżki local/live. Wynik: ${JSON.stringify(journey.result)}`);
}
if (expectedSource !== "any" && source !== expectedSource) {
  throw new Error(`Oczekiwano ścieżki ${expectedSource}, użyto ${source}.`);
}
const routeFound = Array.isArray(journey.result?.legs) && journey.result.legs.length > 0;
const legCount = Array.isArray(journey.result?.legs) ? journey.result.legs.length : 0;
const variantCount = Array.isArray(journey.result?.journeys) ? journey.result.journeys.length : (routeFound ? 1 : 0);
if (expectRoute && !routeFound) {
  throw new Error(`Oczekiwano znalezionej trasy, planer jej nie zwrócił. Wynik: ${JSON.stringify(journey.result)}; odpowiedź: ${result.reply}`);
}
if (expectedLegs === "one" && legCount !== 1) throw new Error(`Oczekiwano trasy bezpośredniej, zwrócono ${legCount} odcinków.`);
if (expectedLegs === "multiple" && legCount < 2) throw new Error(`Oczekiwano trasy z przesiadką, zwrócono ${legCount} odcinków.`);
if (expectedVariants && variantCount < expectedVariants) throw new Error(`Oczekiwano co najmniej ${expectedVariants} wariantów, zwrócono ${variantCount}.`);
if (typeof result.reply !== "string" || !result.reply.trim()) throw new Error("Brak tekstowej odpowiedzi asystenta.");
const normalize = (text) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pl");
if (expectedText && !normalize(result.reply).includes(normalize(expectedText))) {
  throw new Error(`Odpowiedź nie zawiera oczekiwanego tekstu "${expectedText}". Odpowiedź: ${result.reply}`);
}
if (Number(result.parts) > grantedParts) throw new Error(`Odpowiedź przekroczyła limit: ${result.parts}/${grantedParts} SMS.`);

const summary = [
  "## Test planera kolejowego (bez wysyłki SMS)",
  "",
  `- Trasa: ${from} → ${to}`,
  `- Kiedy: ${date} ${time}`,
  `- Ścieżka planera: **${source}**`,
  `- Tryb fallback: ${allowLiveFallback ? "pełny (może użyć limitowanego API PKP)" : "lokalny (bez zapytań do PKP)"}`,
  `- Trasa znaleziona: ${routeFound ? "tak" : "nie"}`,
  `- Liczba odcinków: ${legCount}`,
  `- Liczba wariantów: ${variantCount}`,
  `- Wiadomości SMS: ${result.parts}/${grantedParts} (tryb testowy, nic nie wysłano)`,
  `- ID diagnostyczne: \`${result.conv_id || "brak"}\``,
  `- Wywołane argumenty narzędzia: \`${JSON.stringify(journey.args)}\``,
  `- Wynik narzędzia: \`${JSON.stringify(journey.result)}\``,
  "",
  "### Odpowiedź",
  "",
  "```text",
  result.reply,
  "```",
];
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs/promises");
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
}

console.log(`PASS: ${from} -> ${to}; route_source=${source}; parts=${result.parts}/${grantedParts}`);
console.log(`Reply: ${result.reply}`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Brak parametru ${name}.`);
  return value;
}
