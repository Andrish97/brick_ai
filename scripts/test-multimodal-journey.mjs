const projectRef = process.env.SUPABASE_PROJECT_REF || "rjnqpenbjyeiygedjvzk";
const secret = process.env.INTERNAL_SECRET;
if (!secret) throw new Error("Brak INTERNAL_SECRET.");
const question = process.env.QUESTION || "O której mam wyjść z domu, żeby być w Przemyślu w poniedziałek 26.10.2026 przed 20?";
const direction = process.env.EXPECT_DIRECTION || "arrive_by";
const expectedMode = process.env.EXPECT_MODE || "";
const expectTrain = process.env.EXPECT_TRAIN === "true";
const url = process.env.TEST_ENDPOINT_URL || `https://${projectRef}.supabase.co/functions/v1/zadarma-sms-webhook?endpoint_test=1`;
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
  body: JSON.stringify({ event: "incoming_sms", msg: question, history: [], grantedParts: 4 }),
  signal: AbortSignal.timeout(120_000),
});
const raw = await response.text();
let result;
try { result = JSON.parse(raw); } catch { throw new Error(`Endpoint zwrócił niepoprawny JSON (HTTP ${response.status}): ${raw}`); }
if (!response.ok || result.ok !== true || result.test_mode !== true) throw new Error(`Test webhooka nie powiódł się: ${raw}`);
const trace = result.journey_trace?.find((entry) => entry.result?.route_source === "Google Directions API");
if (!trace) throw new Error(`Gemini nie wywołał planera trasy. Odpowiedź: ${result.reply}`);
if (trace.result?.error) throw new Error(`Planer zwrócił błąd: ${JSON.stringify(trace.result)}`);
if (trace.args.time_direction !== direction) throw new Error(`Oczekiwano ${direction}, otrzymano ${JSON.stringify(trace.args)}.`);
if (expectedMode && trace.result.mode !== expectedMode) throw new Error(`Oczekiwano trybu ${expectedMode}, otrzymano ${trace.result.mode}.`);
if (expectTrain && trace.result.has_train !== true) throw new Error(`Długa trasa nie zawiera rozpoznanego odcinka kolejowego: ${JSON.stringify(trace.result)}`);
if (trace.result.route_source !== "Google Directions API" || typeof trace.result.route !== "string" || !trace.result.route.trim()) {
  throw new Error(`Brak trasy door-to-door: ${JSON.stringify(trace.result)}`);
}
if (direction === "arrive_by" && !trace.result.route.startsWith("Wyjdź ")) throw new Error(`Brak wyliczonej godziny wyjścia: ${trace.result.route}`);
if (direction === "arrive_by" && trace.result.arrive_at >= "20:00") throw new Error(`Trasa nie dociera przed 20:00: ${JSON.stringify(trace.result)}`);
if (direction === "depart_at" && !trace.result.route.startsWith("Wyjazd ")) throw new Error(`Brak wyniku dla wyjazdu: ${trace.result.route}`);
if (!result.reply?.trim()) throw new Error("Brak odpowiedzi testowej.");
console.log(JSON.stringify({ ok: true, test_mode: true, direction, args: trace.args, result: trace.result, reply: result.reply, parts: result.parts }, null, 2));
