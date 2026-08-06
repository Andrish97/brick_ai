/**
 * Testuje rozpoznawanie intencji i wszystkie narzędzia asystenta
 * (allow_long_reply, close_conversation, get_user_profile, get_directions,
 * get_transit, get_fastest_arrival) przez `dry_run=1` — webhook robi
 * wszystko normalnie (Gemini, function calling, assistant-tools), ale
 * zamiast wysłać SMS-a zwraca treść odpowiedzi jako JSON. Zero kosztu SMS.
 *
 * Wymaga prawdziwego kodu użytkownika z Twojej bazy (np. tego z README:
 * insert into users (code, phone_number) values ('1234', '...')).
 * Dla get_directions/get_transit/get_fastest_arrival ten użytkownik musi
 * mieć ustawiony adres domu i pracy w panelu admina.
 *
 * Użycie:
 *   deno run --allow-net scripts/test-endpoints.ts <SUPABASE_URL> <KOD_UZYTKOWNIKA> [NUMER_TESTOWY]
 * np.
 *   deno run --allow-net scripts/test-endpoints.ts https://rjnqpenbjyeiygedjvzk.supabase.co 1234
 *
 * NUMER_TESTOWY musi być numerem, którego NIE ma w tabeli users (inaczej
 * webhook potraktuje go jako znany numer i pominie kod użytkownika w
 * pierwszej linii). Domyślnie używany jest oczywisty numer testowy.
 */

const SB_URL = Deno.args[0];
const USER_CODE = Deno.args[1];
const TEST_PHONE = Deno.args[2] ?? "48500000001";

if (!SB_URL || !USER_CODE) {
  console.error("Użycie: deno run --allow-net scripts/test-endpoints.ts <SUPABASE_URL> <KOD_UZYTKOWNIKA> [NUMER_TESTOWY]");
  Deno.exit(1);
}

const WEBHOOK_URL = `${SB_URL.replace(/\/$/, "")}/functions/v1/zadarma-sms-webhook?dry_run=1`;

type Case = { label: string; msg: string; expectTool?: string };

const cases: Case[] = [
  { label: "zwykłe pytanie (bez narzędzi)", msg: "jaka jest stolica Francji?" },
  { label: "get_user_profile", msg: "jakie mam ustawione imię w tym systemie?", expectTool: "get_user_profile" },
  { label: "allow_long_reply", msg: "mozesz napisac dluzej, uzyj 4 smsow i opisz krotko historie Polski", expectTool: "allow_long_reply" },
  { label: "get_directions (pieszo, dom->praca)", msg: "poprowadz mnie pieszo z domu do pracy", expectTool: "get_directions" },
  { label: "get_transit (dom->praca)", msg: "jak dojade komunikacja miejska z domu do pracy?", expectTool: "get_transit" },
  { label: "get_fastest_arrival", msg: "o ktorej najszybciej bede w pracy jesli wyjde teraz z domu?", expectTool: "get_fastest_arrival" },
  { label: "close_conversation (intencja, nie slowo-klucz)", msg: "dzieki, to na razie wszystko, nie musisz juz odpisywac, konczymy", expectTool: "close_conversation" },
];

async function runCase(c: Case): Promise<void> {
  const body = `${USER_CODE}\n${c.msg}`; // bez kodu rozmowy = nowa, izolowana rozmowa za każdym razem
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "sms",
      sms_from: TEST_PHONE,
      sms_to: "48459569689",
      msg: body,
    }),
  });
  const status = res.status;
  let data: unknown;
  try { data = await res.json(); } catch { data = await res.text(); }

  console.log(`\n=== ${c.label} ===`);
  console.log(`> ${c.msg}`);
  console.log(`HTTP ${status}`);
  console.log(JSON.stringify(data, null, 2));
}

console.log(`Testuję ${cases.length} scenariuszy przez dry_run=1 — żaden SMS nie zostanie wysłany.\n`);
for (const c of cases) {
  await runCase(c);
}
console.log("\nGotowe. Sprawdź w panelu admina → Logi (filtr: Narzędzie / Wynik narzędzia), czy każdy scenariusz faktycznie wywołał oczekiwane narzędzie — sama treść odpowiedzi tego nie gwarantuje, jeśli model źle rozpozna intencję.");
