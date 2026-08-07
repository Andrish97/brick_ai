/**
 * Testuje rozpoznawanie intencji i wszystkie narzędzia asystenta
 * (allow_long_reply, close_conversation, get_user_profile, get_directions,
 * get_transit, get_fastest_arrival) przez tryb testowy webhooka
 * (`?endpoint_test=1`). Gemini, assistant-tools i Google Maps są wywoływane
 * naprawdę — to nie jest atrapa — ale endpoint używa syntetycznego profilu
 * (dom/praca w Katowicach) i nie zakłada, nie wymaga ani nie zapisuje żadnej
 * prawdziwej rozmowy, wiadomości ani użytkownika. Zero SMS-ów, zero danych
 * w tabelach conversations/messages.
 *
 * Użycie:
 *   deno run --allow-net scripts/test-endpoints.ts <SUPABASE_URL>
 * np.
 *   deno run --allow-net scripts/test-endpoints.ts https://rjnqpenbjyeiygedjvzk.supabase.co
 */

const SB_URL = Deno.args[0];

if (!SB_URL) {
  console.error("Użycie: deno run --allow-net scripts/test-endpoints.ts <SUPABASE_URL>");
  Deno.exit(1);
}

const WEBHOOK_URL = `${SB_URL.replace(/\/$/, "")}/functions/v1/zadarma-sms-webhook?endpoint_test=1`;

type Case = { label: string; msg: string };

const cases: Case[] = [
  { label: "zwykłe pytanie (bez narzędzi)", msg: "jaka jest stolica Francji?" },
  { label: "get_user_profile", msg: "jakie mam ustawione imię w tym systemie?" },
  { label: "allow_long_reply", msg: "mozesz napisac dluzej, uzyj 4 smsow i opisz krotko historie Polski" },
  { label: "get_directions (pieszo, dom->praca)", msg: "poprowadz mnie pieszo z domu do pracy" },
  { label: "get_transit (dom->praca)", msg: "jak dojade komunikacja miejska z domu do pracy?" },
  { label: "get_fastest_arrival", msg: "o ktorej najszybciej bede w pracy jesli wyjde teraz z domu?" },
  { label: "close_conversation (intencja, nie slowo-klucz)", msg: "dzieki, to na razie wszystko, nie musisz juz odpisywac, konczymy" },
];

async function runCase(c: Case): Promise<void> {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "sms", msg: c.msg }),
  });
  const status = res.status;
  let data: unknown;
  try { data = await res.json(); } catch { data = await res.text(); }

  console.log(`\n=== ${c.label} ===`);
  console.log(`> ${c.msg}`);
  console.log(`HTTP ${status}`);
  console.log(JSON.stringify(data, null, 2));
}

console.log(`Testuję ${cases.length} scenariuszy przez endpoint_test=1 — zero SMS-ów, zero zapisów do bazy.\n`);
for (const c of cases) {
  await runCase(c);
}
console.log("\nGotowe. Sprawdź w panelu admina → Logi (filtr: Narzędzie / Wynik narzędzia), czy każdy scenariusz faktycznie wywołał oczekiwane narzędzie — sama treść odpowiedzi tego nie gwarantuje, jeśli model źle rozpozna intencję.");
