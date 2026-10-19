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
const verifyLive = process.env.VERIFY_LIVE !== "false";

if (![1, 3, 4].includes(grantedParts)) throw new Error("REPLY_PARTS musi wynosić 1, 3 albo 4.");
if (!["any", "local", "live"].includes(expectedSource)) throw new Error("EXPECTED_SOURCE musi wynosić any, local albo live.");
if (!["any", "one", "multiple", "two_transfers", "three_transfers"].includes(expectedLegs)) throw new Error("EXPECTED_LEGS musi wynosić any, one, multiple, two_transfers albo three_transfers.");
if (!Number.isInteger(expectedVariants) || expectedVariants < 0 || expectedVariants > 3) throw new Error("EXPECTED_VARIANTS musi wynosić 0–3.");

const supabaseUrl = (process.env.SUPABASE_URL || `https://${projectRef}.supabase.co`).replace(/\/$/, "");
const internalSecret = required("INTERNAL_SECRET");
const url = process.env.TEST_ENDPOINT_URL || `${supabaseUrl}/functions/v1/zadarma-sms-webhook?endpoint_test=1`;
const question = `Jak dojadę pociągiem z ${from} do ${to} ${date} ${time}?`;
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Internal-Secret": internalSecret },
  body: JSON.stringify({
    event: "incoming_sms", msg: question, history: [], grantedParts,
    testLocalOnly: !verifyLive,
    disableLiveFallback: !allowLiveFallback,
  }),
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
const liveVerification = journey.result?.live_verification;
if (verifyLive && source === "local" && !liveVerification) {
  throw new Error(`Lokalny wynik nie zawiera potwierdzenia przez PKP /schedules. Wynik: ${JSON.stringify(journey.result)}`);
}
if (expectRoute && !routeFound) {
  throw new Error(`Oczekiwano znalezionej trasy, planer jej nie zwrócił. Wynik: ${JSON.stringify(journey.result)}; odpowiedź: ${result.reply}`);
}
if (expectedLegs === "one" && legCount !== 1) throw new Error(`Oczekiwano trasy bezpośredniej, zwrócono ${legCount} odcinków.`);
if (expectedLegs === "multiple" && legCount < 2) throw new Error(`Oczekiwano trasy z przesiadką, zwrócono ${legCount} odcinków.`);
if (expectedLegs === "two_transfers" && !journey.result.journeys?.some((option) => option.legs?.length >= 3)) {
  throw new Error(`Oczekiwano wariantu z dwiema przesiadkami, otrzymano ${variantCount} wariantów; odcinki: ${JSON.stringify(journey.result.journeys?.map((option) => option.legs?.length))}`);
}
if (expectedLegs === "three_transfers" && !journey.result.journeys?.some((option) => option.legs?.length >= 4)) {
  throw new Error(`Oczekiwano wariantu z trzema przesiadkami, otrzymano ${variantCount} wariantów; odcinki: ${JSON.stringify(journey.result.journeys?.map((option) => option.legs?.length))}`);
}
if (routeFound) {
  const options = journey.result.journeys?.length ? journey.result.journeys : [journey.result];
  for (const [index, option] of options.entries()) {
    const issue = validateJourney(option.legs, time);
    if (issue) throw new Error(`Wariant ${index + 1} ma nieprawidłową chronologię: ${issue}. Odcinki: ${JSON.stringify(option.legs)}`);
  }
}
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
  `- Weryfikacja PKP API: ${liveVerification ? `${liveVerification.verified_candidates}/${liveVerification.checked_candidates} wariantów, ${liveVerification.duration_ms} ms` : "pominięta lub nie dotyczy tej daty"}`,
  `- Czas wywołania planera: ${journey.duration_ms ?? "brak"} ms`,
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
console.log(`Search tool elapsed: ${journey.duration_ms ?? "unavailable"} ms`);
console.log(`PKP API verification: ${liveVerification ? `${liveVerification.verified_candidates}/${liveVerification.checked_candidates}; ${liveVerification.duration_ms} ms` : "skipped/not applicable"}`);
console.log(`Legs: ${JSON.stringify(journey.result?.legs || [])}`);
console.log(`Reply: ${result.reply}`);

function validateJourney(legs, preferredTime) {
  if (!Array.isArray(legs) || !legs.length) return "brak odcinków";
  const parse = (value) => {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  let previousArrival = null;
  let firstDeparture = null;
  for (const [index, leg] of legs.entries()) {
    let departure = parse(leg.departure);
    let arrival = parse(leg.arrival);
    if (departure === null || arrival === null) return `brak poprawnej godziny w odcinku ${index + 1}`;
    if (previousArrival !== null) while (departure < previousArrival) departure += 24 * 60;
    while (arrival <= departure) arrival += 24 * 60;
    if (index > 0) {
      const wait = departure - previousArrival;
      if (wait < 30 || wait > 150) return `oczekiwanie na przesiadkę wynosi ${wait} min`;
    }
    if (index === 0) firstDeparture = departure;
    previousArrival = arrival;
  }
  if (legs.length > 4) return `więcej niż trzy przesiadki (${legs.length - 1})`;
  const windowStart = preferredWindowStart(preferredTime);
  if (windowStart !== null && (firstDeparture < windowStart || firstDeparture >= windowStart + 240)) {
    return `pierwszy odjazd ${String(legs[0].departure)} poza czterogodzinnym oknem od ${preferredTime}`;
  }
  return null;
}

function preferredWindowStart(value) {
  const normalized = value.toLocaleLowerCase("pl");
  const exact = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  if (exact) return Number(exact[1]) * 60 + Number(exact[2]);
  if (normalized.includes("rano")) return 6 * 60;
  if (normalized.includes("połud")) return 12 * 60;
  if (normalized.includes("wiecz")) return 18 * 60;
  return null;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Brak parametru ${name}.`);
  return value;
}
