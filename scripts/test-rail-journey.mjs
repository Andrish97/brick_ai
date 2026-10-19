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
const expectedIntent = (process.env.EXPECTED_INTENT || "any").trim();
const minTransferMinutes = Number(process.env.RAIL_MIN_TRANSFER_MINUTES || 30);
const maxTransferMinutes = Number(process.env.RAIL_MAX_TRANSFER_MINUTES || 150);
const originWindowHours = Number(process.env.RAIL_ORIGIN_WINDOW_HOURS || 4);
const verifyLive = process.env.VERIFY_LIVE !== "false";

if (![1, 3, 4].includes(grantedParts)) throw new Error("REPLY_PARTS musi wynosić 1, 3 albo 4.");
if (!["any", "departure_only", "journey", "transfer"].includes(expectedIntent)) throw new Error("EXPECTED_INTENT musi wynosić any, departure_only, journey albo transfer.");
if (!["any", "local"].includes(expectedSource)) throw new Error("EXPECTED_SOURCE musi wynosić any albo local.");
if (!["any", "one", "multiple", "two_transfers", "three_transfers"].includes(expectedLegs)) throw new Error("EXPECTED_LEGS musi wynosić any, one, multiple, two_transfers albo three_transfers.");
if (!Number.isInteger(expectedVariants) || expectedVariants < 0 || expectedVariants > 3) throw new Error("EXPECTED_VARIANTS musi wynosić 0–3.");
if (![30, 45, 60].includes(minTransferMinutes)) throw new Error("RAIL_MIN_TRANSFER_MINUTES ma nieobsługiwaną wartość.");
if (![90, 120, 150, 180].includes(maxTransferMinutes) || maxTransferMinutes <= minTransferMinutes) throw new Error("RAIL_MAX_TRANSFER_MINUTES ma nieobsługiwaną wartość.");
if (![1, 2, 3, 4].includes(originWindowHours)) throw new Error("RAIL_ORIGIN_WINDOW_HOURS ma nieobsługiwaną wartość.");

const supabaseUrl = (process.env.SUPABASE_URL || `https://${projectRef}.supabase.co`).replace(/\/$/, "");
const internalSecret = required("INTERNAL_SECRET");
const url = process.env.TEST_ENDPOINT_URL || `${supabaseUrl}/functions/v1/zadarma-sms-webhook?endpoint_test=1`;
const question = (process.env.QUESTION || `Jak dojadę pociągiem z ${from} do ${to} ${date} ${time}?`).trim();
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Internal-Secret": internalSecret },
  body: JSON.stringify({
    event: "incoming_sms", msg: question, history: [], grantedParts,
    testLocalOnly: !verifyLive,
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
if (source !== "local") {
  throw new Error(`Planer nie zwrócił ścieżki lokalnej. Wynik: ${JSON.stringify(journey.result)}`);
}
if (expectedSource !== "any" && source !== expectedSource) {
  throw new Error(`Oczekiwano ścieżki ${expectedSource}, użyto ${source}.`);
}
const routeFound = Array.isArray(journey.result?.legs) && journey.result.legs.length > 0;
const legCount = Array.isArray(journey.result?.legs) ? journey.result.legs.length : 0;
const variantCount = Array.isArray(journey.result?.journeys) ? journey.result.journeys.length : (routeFound ? 1 : 0);
const liveVerification = journey.result?.live_verification;
if (verifyLive && routeFound && source === "local" && !liveVerification) {
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
  // Validate against the time window asked by the test, not the model's tool args.
  // Otherwise an incorrect interpretation of "rano" as 04:00 would pass unnoticed.
  const requestedTime = time;
  for (const [index, option] of options.entries()) {
    const issue = validateJourney(option.legs, requestedTime, minTransferMinutes, maxTransferMinutes, originWindowHours);
    if (issue) throw new Error(`Wariant ${index + 1} ma nieprawidłową chronologię: ${issue}. Argumenty narzędzia: ${JSON.stringify(journey.args)}. Odcinki: ${JSON.stringify(option.legs)}`);
  }
}
if (expectedVariants && variantCount < expectedVariants) throw new Error(`Oczekiwano co najmniej ${expectedVariants} wariantów, zwrócono ${variantCount}.`);
if (typeof result.reply !== "string" || !result.reply.trim()) throw new Error("Brak tekstowej odpowiedzi asystenta.");
const normalize = (text) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/ł/g, "l").toLocaleLowerCase("pl");
if (expectedIntent === "departure_only") {
  const firstLeg = journey.result.legs?.[0];
  const expectedReply = firstLeg && `${firstLeg.from} ${firstLeg.departure}`;
  if (!expectedReply || normalize(result.reply) !== normalize(expectedReply)) {
    throw new Error(`Odpowiedź o samym odjeździe powinna brzmieć "${expectedReply}". Odpowiedź: ${result.reply}`);
  }
}
if (["journey", "transfer"].includes(expectedIntent)) {
  const legs = journey.result.journeys?.[0]?.legs || journey.result.legs || [];
  if (legs.length < 2) throw new Error(`Test ${expectedIntent} wymaga trasy z przesiadką; otrzymano ${legs.length} odcinków.`);
  const transferCount = legs.length - 1;
  const transferLabel = `${transferCount} ${transferCount === 1 ? "przesiadka" : transferCount < 5 ? "przesiadki" : "przesiadek"}`;
  if (expectedIntent === "transfer") {
    const expectedReply = `${transferLabel}: ${legs.slice(0, -1).map((leg, index) => `${leg.arrival} ${leg.to} ${legs[index + 1].departure}`).join("-")}`;
    if (normalize(result.reply) !== normalize(expectedReply)) {
      throw new Error(`Odpowiedź o przesiadce powinna zawierać wyłącznie "${expectedReply}". Odpowiedź: ${result.reply}`);
    }
  }
  if (expectedIntent === "journey") {
    const route = [`${legs[0].from} ${legs[0].departure}`];
    for (let index = 0; index < legs.length - 1; index++) {
      route.push(`${legs[index].arrival} ${legs[index].to} ${legs[index + 1].departure}`);
    }
    route.push(`${legs.at(-1).arrival} ${legs.at(-1).to}`);
    const expectedReply = `${transferLabel}: ${route.join("-")}`;
    if (normalize(result.reply) !== normalize(expectedReply)) {
      throw new Error(`Odpowiedź o całym połączeniu powinna zawierać "${expectedReply}". Odpowiedź: ${result.reply}`);
    }
  }
  const transferIndices = expectedIntent === "transfer" ? [0] : legs.slice(0, -1).map((_, index) => index);
  for (const index of transferIndices) {
    const previous = legs[index];
    const next = legs[index + 1];
    for (const detail of [previous.arrival, previous.to, next.departure]) {
      if (!normalize(result.reply).includes(normalize(String(detail)))) {
        throw new Error(`Odpowiedź ${expectedIntent} pomija element przesiadki "${detail}". Odpowiedź: ${result.reply}`);
      }
    }
  }
}
if (expectedText && !normalize(result.reply).includes(normalize(expectedText))) {
  throw new Error(`Odpowiedź nie zawiera oczekiwanego tekstu "${expectedText}". Odpowiedź: ${result.reply}`);
}
if (Number(result.parts) > grantedParts) throw new Error(`Odpowiedź przekroczyła limit: ${result.parts}/${grantedParts} SMS.`);

const summary = [
  "## Test planera kolejowego (bez wysyłki SMS)",
  "",
  `- Trasa: ${from} → ${to}`,
  `- Pytanie: ${question}`,
  `- Kiedy: ${date} ${time}`,
  `- Ścieżka planera: **${source}**`,
  `- Weryfikacja API PKP: ${verifyLive ? "tylko po znalezieniu trasy lokalnej" : "wyłączona"}`,
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
console.log(`Tool arguments: ${JSON.stringify(journey.args)}`);
console.log(`Tool result: ${JSON.stringify(journey.result)}`);
console.log(`Legs: ${JSON.stringify(journey.result?.legs || [])}`);
console.log(`Reply: ${result.reply}`);

function validateJourney(legs, preferredTime, minTransferMinutes, maxTransferMinutes, originWindowHours) {
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
      if (wait < minTransferMinutes || wait > maxTransferMinutes) return `oczekiwanie na przesiadkę wynosi ${wait} min`;
    }
    if (index === 0) firstDeparture = departure;
    previousArrival = arrival;
  }
  if (legs.length > 4) return `więcej niż trzy przesiadki (${legs.length - 1})`;
  const windowStart = preferredWindowStart(preferredTime);
  if (windowStart !== null && (firstDeparture < windowStart || firstDeparture >= windowStart + originWindowHours * 60)) {
    return `pierwszy odjazd ${String(legs[0].departure)} poza ${originWindowHours}-godzinnym oknem od ${preferredTime}`;
  }
  return null;
}

function preferredWindowStart(value) {
  const normalized = value.toLocaleLowerCase("pl");
  const exact = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  if (exact) return Number(exact[1]) * 60 + Number(exact[2]);
  if (normalized.includes("rano")) return 8 * 60;
  if (normalized.includes("połud")) return 12 * 60;
  if (normalized.includes("wiecz")) return 18 * 60;
  return null;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Brak parametru ${name}.`);
  return value;
}
