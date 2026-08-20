import { createHmac, createHash } from "node:crypto";

// Globalny w środowisku Supabase Edge Functions (Deno Deploy) — pozwala kontynuować
// pracę w tle po zwróceniu odpowiedzi HTTP. Brak w standardowych typach Deno.
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;

const ZADARMA_API_URL = "https://api.zadarma.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const COMPACT_THRESHOLD = 20; // wiadomości przed kompaktowaniem
const SUFFIX_LEN = 7; // "\n" + 6-cyfrowy kod rozmowy

// Fizyczna część SMS-a mieści RÓŻNĄ liczbę znaków zależnie od kodowania: GSM-7
// (tylko podstawowy alfabet łaciński, bez polskich znaków) mieści 160/153 (poje-
// dyncza/łączona), UCS-2 (gdy w treści jest choć jeden znak spoza GSM-7) mieści
// tylko 70/67. Polskie znaki diakrytyczne są usuwane z każdej odpowiedzi
// (stripPolishDiacritics, decyzja produktowa: koszt ważniejszy niż ogonki), więc
// realna odpowiedź niemal zawsze mieści się w tańszym GSM-7 — domyślny budżet
// poniżej odzwierciedla tę normę. smsPartCharsFor() i tak liczy to dynamicznie
// z już oczyszczonego tekstu (na wypadek symboli spoza GSM-7, np. °×÷©), więc
// nigdy nie zgadujemy — to tylko liczba podawana modelowi w instrukcji w prompt.
const SMS_PART_CHARS_GSM7 = 160 - SUFFIX_LEN; // 153
const SMS_PART_CHARS_UCS2 = 70 - SUFFIX_LEN;  // 63
const SMS_PART_CHARS = SMS_PART_CHARS_GSM7; // domyślny budżet do instrukcji w prompt
function requiresUcs2(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}
function smsPartCharsFor(text: string): number {
  return requiresUcs2(text) ? SMS_PART_CHARS_UCS2 : SMS_PART_CHARS_GSM7;
}

const CLOSE_KEYWORDS = ["koniec", "stop", "zamknij", "end"]; // szybka ścieżka bez wywoływania modelu

// System prompt nigdzie nie mówił modelowi, jaka jest aktualna data/godzina — bez tego
// "jutro"/"za 20 minut" nie da się poprawnie przeliczyć na konkretną datę/godzinę
// przekazywaną do narzędzi kolejowych (plan_train_journey, get_train_status).
function warsawNowLabel(): string {
  const parts = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} (${get("weekday")}), godzina ${get("hour")}:${get("minute")}`;
}

// Liczba tokenów wyjściowych Gemini w zależności od przyznanego limitu SMS-ów odpowiedzi.
// Celowo Z DUŻYM ZAPASEM ponad realny budżet znaków (np. 250 tokenów na 153-znakowy
// SMS) — z logów produkcyjnych wiadomo, że ciasny limit (dawniej 100) potrafił uciąć
// generowanie w połowie zdania (finishReason: MAX_TOKENS), zanim smartTrim/chunkForSms
// w ogóle dostały szansę grzecznie przyciąć tekst na granicy zdania/słowa. Model i tak
// nigdy nie wyśle więcej niż limit znaków — to i tak egzekwuje chunkForSms — ale dzięki
// zapasowi kończy myśl, zamiast urywać się w środku wyrazu.
const TOKENS_FOR_PARTS: Record<number, number> = { 1: 250, 3: 650, 4: 850 };

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "").replace(/www\.\S+/g, "").replace(/\s{2,}/g, " ").trim();
}

// Gemini z narzędziem google_search potrafi wstawić w tekst znaczniki cytowań
// w nawiasach kwadratowych, np. "[1]", "[2, 3]", "[1.1.1, 1.2]" — w SMS-ie są
// bezużyteczne (nie ma linków źródłowych do pokazania), więc usuwamy je od razu,
// zanim tekst trafi do smartTrim/chunkForSms. Robimy to przed obcinaniem, żeby
// obcięcie do limitu znaków nigdy nie ucięło markera w połowie i nie zostawiło
// śmieciowego "[1.1.1, 1.1." na końcu wiadomości.
function stripCitations(text: string): string {
  return text
    .replace(/\s*\[\d+(?:\.\d+)*(?:\s*,\s*\d+(?:\.\d+)*)*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Bezpiecznik: system prompt każe modelowi nie używać markdownu, ale gdyby mimo
// to coś przeciekło, zdejmujemy znaczniki i zostawiamy samą treść — w SMS-ie
// żaden markdown się nie renderuje, więc to tylko szum, nigdy formatowanie.
function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")       // [tekst](url) → tekst
    .replace(/\*\*(.+?)\*\*/g, "$1")                    // **pogrubienie**
    .replace(/__(.+?)__/g, "$1")                        // __pogrubienie__
    .replace(/~~(.+?)~~/g, "$1")                        // ~~przekreślenie~~
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "$1")     // *kursywa*
    .replace(/(?<!_)_([^_\n]+?)_(?!_)/g, "$1")           // _kursywa_
    .replace(/`([^`]+)`/g, "$1")                        // `kod`
    .replace(/^#{1,6}\s+/gm, "")                        // # nagłówki
    .replace(/^>\s?/gm, "")                              // > cytat
    .replace(/^\s*[-*]\s+/gm, "")                       // - lub * lista
    .replace(/^\s*\d+\.\s+/gm, "")                      // 1. lista numerowana
    .replace(/^\s*[-*_]{3,}\s*$/gm, "");                // --- linia pozioma
}

// Bezpiecznik: gdyby mimo wszystko na końcu tekstu został niedomknięty nawias
// (np. inny, nieprzewidziany format markera ucięty przez model albo przez
// wcześniejsze etapy), utnij go — samo "[1.1.1, 1.1." nie jest sensowną treścią.
function stripTrailingBracketFragment(text: string): string {
  return text.replace(/\s*\[[^\]]*$/, "").trim();
}

function smartTrim(text: string, max: number): string {
  if (text.length <= max) return stripTrailingBracketFragment(text);
  const cut = text.slice(0, max);
  const lastPunct = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"), cut.lastIndexOf("\n"));
  if (lastPunct > max * 0.6) return stripTrailingBracketFragment(cut.slice(0, lastPunct + 1).trim());
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > max * 0.6) return stripTrailingBracketFragment(cut.slice(0, lastSpace).trim());
  return stripTrailingBracketFragment(cut.trim());
}

function sanitizeForSms(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')  // cudzysłowy → "
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")  // apostrofy → '
    .replace(/\u2013/g, '-')                              // półpauza → -
    .replace(/\u2014/g, '--')                             // pauza → --
    .replace(/\u2026/g, '...')                            // wielokropek → ...
    .replace(/\u00A0/g, ' ')                              // spacja niełamliwa → spacja
    .replace(/[\u200B-\u200D\uFEFF]/g, '')               // znaki zerowej szerokości
    .replace(/\r\n|\r/g, '\n')                            // CRLF/CR → LF
    .trim();
}

// Polskie znaki diakrytyczne leżą poza alfabetem GSM-7, więc wymuszają UCS-2
// (patrz smsPartCharsFor) — jedna fizyczna część SMS-a mieści wtedy ~70 znaków
// zamiast 160/153. Usuwamy je zawsze (decyzja produktowa: koszt ważniejszy niż
// ortografia — polski tekst bez ogonków pozostaje w pełni czytelny, tak jak w
// erze telefonów bez pełnego wsparcia Unicode), żeby odpowiedź niemal zawsze
// mieściła się w tańszym GSM-7 i korzystała z 153, nie 63 znaków na część —
// również przy wielu częściach (allow_long_reply), bo smsPartCharsFor liczy to
// dynamicznie z już oczyszczonego tekstu.
// Jawne kody \uXXXX zamiast wklejonych liter — patrz uzasadnienie przy
// restrictToSafeSmsCharset (literalny znak jest podatny na ciche podmiany).
const POLISH_DIACRITICS_MAP: Record<string, string> = {
  "\u0104": "A", "\u0105": "a", // Ą ą
  "\u0106": "C", "\u0107": "c", // Ć ć
  "\u0118": "E", "\u0119": "e", // Ę ę
  "\u0141": "L", "\u0142": "l", // Ł ł
  "\u0143": "N", "\u0144": "n", // Ń ń
  "\u00D3": "O", "\u00F3": "o", // Ó ó
  "\u015A": "S", "\u015B": "s", // Ś ś
  "\u0179": "Z", "\u017A": "z", // Ź ź
  "\u017B": "Z", "\u017C": "z", // Ż ż
};
function stripPolishDiacritics(text: string): string {
  return text.replace(
    /[\u0104\u0105\u0106\u0107\u0118\u0119\u0141\u0142\u0143\u0144\u00D3\u00F3\u015A\u015B\u0179\u017A\u017B\u017C]/g,
    (c) => POLISH_DIACRITICS_MAP[c] ?? c
  );
}

// Biała lista CAŁYCH ZAKRESÓW Unicode zamiast pojedynczych znaków: telefon
// użytkownika nie ma w foncie SMS-ów glifów dla strzałek/gwiazdek-symboli/
// ptaszków/emoji (potwierdzone testem) — pokazują się jako puste kwadraciki.
// Zamiast wymieniać zakazane znaki jeden po drugim (zawsze będzie jakiś nowy,
// nieprzetestowany emoji — czysta gra w kotka i myszkę), dopuszczamy trzy
// dobrze znane bloki Unicode obejmujące cały alfabet łaciński: Basic Latin
// (ASCII), Latin-1 Supplement i Latin Extended-A. Razem pokrywają KOMPLETNIE
// wszystkie polskie znaki diakrytyczne (jako reguła, nie lista) oraz typową
// łacińską typografię (° © × ÷ ± itp.), a strukturalnie wykluczają bloki
// Strzałki/Symbole/Dingbaty/Emoji, bo leżą poza tym zakresem — bez potrzeby
// testowania i dopisywania kolejnych pojedynczych wyjątków.
//
// Celowo \uXXXX, nie wklejone znaki — literalny znak w kodzie źródłowym jest
// podatny na ciche podmiany przy kopiowaniu/kodowaniu (np. "ą" U+0105 na
// wyglądające podobnie "á" U+00E1, co realnie się zdarzyło przy pierwszej
// wersji tej funkcji); jawny kod Unicode to zwykłe ASCII, nie da się go
// przypadkiem podmienić. Zakres zaczyna się od U+00A1 (nie U+0080), żeby
// pominąć niedrukowalne znaki sterujące C1 (U+0080-U+009F) oraz surowy NBSP
// (U+00A0, i tak już zamieniany na spację w sanitizeForSms).
function restrictToSafeSmsCharset(text: string): string {
  return text.replace(/[^\x20-\x7E\n\u00A1-\u00FF\u0100-\u017F]/g, "");
}

// Dzieli tekst na maks. `maxParts` części, po `smsPartCharsFor(text)` znaków każda —
// 153 dla czystego GSM-7, 63 gdy tekst wymaga UCS-2 (patrz komentarz przy stałych
// wyżej). Jeśli tekst jest dłuższy niż budżet, obcina go najpierw na granicy
// zdania/słowa (smartTrim), więc nigdy nie wysyłamy więcej niż `maxParts` SMS-ów.
function chunkForSms(text: string, maxParts: number): string[] {
  const partChars = smsPartCharsFor(text);
  const budget = partChars * maxParts;
  const fitted = text.length > budget ? smartTrim(text, budget - 3) + "..." : text;
  const parts: string[] = [];
  for (let i = 0; i < fitted.length; i += partChars) {
    parts.push(fitted.slice(i, i + partChars));
  }
  return parts.length ? parts : [""];
}

// --- Zadarma auth ---

function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

// Zadarma (backend PHP) podpisuje żądanie stringiem zbudowanym jak PHP-owe
// urlencode()/http_build_query z PHP_QUERY_RFC1738: procentowo kodowane jest
// WSZYSTKO poza literami, cyframi i "-_.", a spacja to "+". To NIE jest to samo,
// co JS-owy encodeURIComponent ani URLSearchParams — oba zostawiają część znaków
// (!~*'()) niekodowanych, RFC1738 koduje je wszystkie. Jeśli treść SMS-a zawiera
// wykrzyknik/apostrof, źle zakodowany parametr psuje podpis → 401 mimo poprawnego
// klucza/sekretu. phpUrlEncode() naprawia to dokładnie do zachowania PHP.
function phpUrlEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/%20/g, "+")
    .replace(/[!~*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// Kolejność parametrów w podpisie i w treści żądania musi być identyczna (Zadarma
// podpisuje posortowane alfabetycznie parametry) — dlatego sortedParamString() jest
// jedynym miejscem budującym ten string, używane identycznie do podpisu i do treści
// żądania (patrz sendSms), żeby nigdy się nie rozjechały.
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

// Sukces wysyłki liczymy jako podstawę do zapisu w sms_sends (a więc i do licznika
// kosztów), więc samo `res.ok` to za mało — Zadarma potrafi zwrócić HTTP 200 z
// treścią sygnalizującą błąd. Sprawdzamy oba: status HTTP i pole "status" w treści
// odpowiedzi (jeśli jest obecne i jawnie mówi "error", traktujemy jako porażkę
// mimo HTTP 200).
async function sendSms(to: string, text: string, from: string): Promise<void> {
  const path = "/v1/sms/send/";
  // Aktualna dokumentacja Zadarmy nazywa ten parametr "sender", nie "caller_id" —
  // stare pole przestało być akceptowane i powodowało 401 Not authorized.
  const params = { number: to, message: text, sender: from };
  const apiKey = Deno.env.get("ZADARMA_API_KEY") ?? "";
  const apiSecret = Deno.env.get("ZADARMA_API_SECRET") ?? "";
  log("sms_debug", { to, from, msgLen: text.length, keyPresent: !!apiKey, secretPresent: !!apiSecret, keyPrefix: apiKey.slice(0, 4) });
  const res = await fetch(`${ZADARMA_API_URL}${path}`, {
    method: "POST",
    headers: { Authorization: buildAuth(path, params), "Content-Type": "application/x-www-form-urlencoded" },
    body: sortedParamString(params),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`SMS send failed: ${res.status} ${bodyText}`);
  try {
    const body = JSON.parse(bodyText);
    if (body?.status === "error") throw new Error(`SMS send failed: HTTP 200 ale status=error: ${bodyText}`);
  } catch (e) {
    if (e instanceof SyntaxError) return; // treść nie jest JSON-em — ufamy samemu HTTP 200
    throw e;
  }
}

// Best-effort: błąd odczytu salda nie może zablokować wysyłki SMS-a. Logujemy
// niepowodzenie (zamiast cicho połykać), żeby było widać w Logach, czy to ta
// sama przyczyna co ewentualny błąd samej wysyłki.
async function getZadarmaBalance(): Promise<number | null> {
  try {
    const path = "/v1/info/balance/";
    const res = await fetch(`${ZADARMA_API_URL}${path}`, { headers: { Authorization: buildAuth(path, {}) } });
    const bodyText = await res.text();
    if (!res.ok) {
      log("balance_check_failed", { status: res.status, body: bodyText });
      return null;
    }
    const body = JSON.parse(bodyText);
    if (body?.balance === undefined) return null;
    return parseFloat(body.balance);
  } catch {
    return null;
  }
}

// --- Supabase helpers ---

function sbHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function sbGet(url: string, key: string, path: string): Promise<unknown[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: sbHeaders(key) });
  return res.ok ? res.json() : [];
}

async function sbPost(url: string, key: string, table: string, body: object): Promise<void> {
  await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

async function sbPatch(url: string, key: string, table: string, filter: string, body: object): Promise<void> {
  await fetch(`${url}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...sbHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

async function sbDelete(url: string, key: string, table: string, filter: string): Promise<void> {
  await fetch(`${url}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: sbHeaders(key) });
}

let _sbLog: { url: string; key: string } | null = null;
function initLog(url: string, key: string) { _sbLog = { url, key }; }
function log(type: string, data: object) {
  if (!_sbLog) return;
  sbPost(_sbLog.url, _sbLog.key, "logs", { type, data }).catch(() => {});
}

// --- Parsowanie SMS ---

// Znany numer: opcjonalny kod rozmowy (6 cyfr) w pierwszej linii, reszta to treść
function parseSmsKnownPhone(body: string): { convCode: string | null; content: string } {
  const lines = body.trim().split("\n").map((l) => l.trim());
  const first = lines[0] ?? "";
  if (/^\d{6}$/.test(first)) {
    return { convCode: first, content: lines.slice(1).join("\n").trim() };
  }
  return { convCode: null, content: body.trim() };
}

// Nieznany numer: pierwsza linia = kod użytkownika, opcjonalna druga = kod rozmowy
function parseSmsUnknownPhone(body: string): { userCode: string; convCode: string | null; content: string } {
  const lines = body.trim().split("\n").map((l) => l.trim());
  const userCode = lines[0] ?? "";
  const second = lines[1] ?? "";
  const isConvCode = /^\d{6}$/.test(second);
  if (isConvCode) {
    return { userCode, convCode: second, content: lines.slice(2).join("\n").trim() };
  }
  return { userCode, convCode: null, content: lines.slice(1).join("\n").trim() };
}

function generateCode(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

// --- Gemini function calling ---

type GeminiContent = { role: string; parts: Array<Record<string, unknown>> };

const TOOLS = [
  { google_search: {} },
  {
    functionDeclarations: [
      {
        name: "allow_long_reply",
        description:
          "Pozwala AI odpowiedzieć dłużej niż jednym SMS-em w BIEŻĄCEJ rozmowie. Wywołaj WYŁĄCZNIE gdy użytkownik wyraźnie zgadza się na dłuższą odpowiedź (np. 'możesz odpisać szerzej', 'pisz w czterech SMS-ach', 'możesz kontynuować' w kontekście zgody na dłuższą odpowiedź). Nie wywołuj tylko dlatego, że Twoja odpowiedź mogłaby być długa.",
        parameters: {
          type: "OBJECT",
          properties: {
            parts: { type: "INTEGER", description: "Liczba SMS-ów, na jaką zgodził się użytkownik: 3 lub 4." },
          },
          required: ["parts"],
        },
      },
      {
        name: "close_conversation",
        description:
          "Definitywnie zamyka bieżącą rozmowę. Wywołaj WYŁĄCZNIE gdy użytkownik naprawdę chce zakończyć rozmowę (np. 'to koniec', 'żegnam się', 'nie kontynuuj'). Nie wywołuj tylko dlatego, że w tekście pojawiło się słowo podobne do 'koniec' bez takiej intencji.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "get_user_profile",
        description:
          "Pobiera wybrane pola profilu bieżącego użytkownika (imię, dom, praca, transport). Wywołaj tylko gdy odpowiedź faktycznie tego wymaga — np. użytkownik pyta o swoje imię albo ustawiony transport. Nie wywołuj, aby uzyskać adres domu/pracy do nawigacji — get_directions/get_transit/get_fastest_arrival rozwiązują to samodzielnie.",
        parameters: {
          type: "OBJECT",
          properties: {
            fields: {
              type: "ARRAY",
              items: { type: "STRING", enum: ["name", "home", "work", "transport"] },
              description: "Lista pól do pobrania. Domyślnie wszystkie.",
            },
          },
        },
      },
      {
        name: "get_directions",
        description:
          "Pobiera i formatuje trasę krok po kroku między dwoma punktami (bez samochodu — tylko pieszo, rower, hulajnoga lub komunikacja miejska). Słowa 'dom' i 'praca' zostaną automatycznie rozwinięte z profilu użytkownika po stronie serwera — przekaż je dosłownie, nie pytaj o adres.",
        parameters: {
          type: "OBJECT",
          properties: {
            origin: { type: "STRING", description: "Punkt startowy: adres albo 'dom'/'praca'." },
            destination: { type: "STRING", description: "Cel podróży: adres albo 'dom'/'praca'." },
            mode: {
              type: "STRING",
              enum: ["pieszo", "rower", "hulajnoga", "komunikacja miejska"],
              description: "Środek transportu. Jeśli pominięty, użyty zostanie transport z profilu użytkownika.",
            },
          },
          required: ["origin", "destination"],
        },
      },
      {
        name: "get_transit",
        description:
          "Pobiera szczegółową trasę komunikacją miejską (autobus/tramwaj/metro) między dwoma punktami, z przesiadkami i godzinami odjazdu/przyjazdu, wyliczoną od teraz.",
        parameters: {
          type: "OBJECT",
          properties: {
            origin: { type: "STRING", description: "Punkt startowy: adres albo 'dom'/'praca'." },
            destination: { type: "STRING", description: "Cel podróży: adres albo 'dom'/'praca'." },
          },
          required: ["origin", "destination"],
        },
      },
      {
        name: "get_fastest_arrival",
        description:
          "Porównuje dostępne środki transportu (pieszo, rower, komunikacja miejska — bez samochodu) i zwraca najszybszy sposób dotarcia do celu wraz z przewidywaną godziną przyjazdu, licząc od teraz.",
        parameters: {
          type: "OBJECT",
          properties: {
            origin: { type: "STRING", description: "Punkt startowy: adres albo 'dom'/'praca'." },
            destination: { type: "STRING", description: "Cel podróży: adres albo 'dom'/'praca'." },
          },
          required: ["origin", "destination"],
        },
      },
      {
        name: "resolve_rail_station",
        description:
          "Ustala jednoznaczną stację kolejową PKP PLK dla 'dom'/'praca' albo nazwy miejscowości/stacji podanej przez użytkownika. Wywołaj przed pytaniem o rozkład lub pociąg, jeśli punkt nie jest już jednoznaczną nazwą stacji.",
        parameters: {
          type: "OBJECT",
          properties: {
            point: { type: "STRING", description: "'dom', 'praca' albo nazwa stacji/miejscowości podana wprost przez użytkownika." },
          },
          required: ["point"],
        },
      },
      {
        name: "get_train_station_board",
        description: "Pobiera planowe odjazdy/przyjazdy pociągów dla podanej stacji kolejowej PKP PLK.",
        parameters: {
          type: "OBJECT",
          properties: {
            station: { type: "STRING", description: "Nazwa stacji kolejowej, albo 'dom'/'praca' (stacja zostanie wyprowadzona z adresu w profilu)." },
            date: { type: "STRING", description: "Data w formacie YYYY-MM-DD. Domyślnie dziś, jeśli pominięta." },
          },
          required: ["station"],
        },
      },
      {
        name: "get_train_status",
        description:
          "Sprawdza rzeczywiste opóźnienie/status konkretnego pociągu PKP PLK. Identyfikuje pociąg po stacji odjazdu i przybliżonej godzinie (opcjonalnie kierunku) — NIGDY nie pytaj użytkownika o numer pociągu, ludzie go nie znają. Numer w wyniku to tylko informacja zwrotna.",
        parameters: {
          type: "OBJECT",
          properties: {
            station: { type: "STRING", description: "Stacja odjazdu, albo 'dom'/'praca'. Domyślnie 'dom', jeśli użytkownik nie podał." },
            time: { type: "STRING", description: "Przybliżona godzina odjazdu, format HH:MM. Domyślnie bieżąca godzina, jeśli pominięta." },
            destination: { type: "STRING", description: "Opcjonalny kierunek/stacja docelowa — pomaga wybrać właściwy pociąg, jeśli kilka odjeżdża o podobnej porze." },
          },
        },
      },
      {
        name: "plan_train_journey",
        description:
          "Planuje połączenie kolejowe PKP PLK między dwoma punktami, z bezpośrednim połączeniem lub jedną przesiadką znalezioną automatycznie. Endpoint sam formatuje wynik — nie twórz własnego opisu trasy.",
        parameters: {
          type: "OBJECT",
          properties: {
            from: { type: "STRING", description: "Stacja/miejscowość startowa, albo 'dom'/'praca'." },
            to: { type: "STRING", description: "Stacja/miejscowość docelowa, albo 'dom'/'praca'." },
            date: { type: "STRING", description: "Data podróży YYYY-MM-DD. Domyślnie dziś." },
          },
          required: ["from", "to"],
        },
      },
      {
        name: "get_train_disruptions",
        description: "Pobiera bieżące utrudnienia ruchu kolejowego PKP PLK, opcjonalnie dla wskazanych stacji.",
        parameters: {
          type: "OBJECT",
          properties: {
            stations: { type: "STRING", description: "Opcjonalna nazwa stacji lub odcinka, do którego ograniczyć wynik." },
          },
        },
      },
    ],
  },
];

const DETERMINISTIC_ACTIONS = new Set([
  "get_directions", "get_transit", "get_fastest_arrival",
  "get_train_station_board", "get_train_status", "plan_train_journey", "get_train_disruptions",
]);

type GeminiTurn = {
  functionCall: { name: string; args: Record<string, unknown> } | null;
  functionCallPart: Record<string, unknown> | null;
  text: string | null;
};

async function generateContent(contents: GeminiContent[], system: string, maxOutputTokens: number, includeTools = true): Promise<GeminiTurn> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${Deno.env.get("GEMINI_API_KEY")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: system }] },
          tools: includeTools ? TOOLS : undefined,
          // Wymagane przez API, gdy w tools łączymy wbudowane narzędzie (google_search)
          // z własnymi functionDeclarations — bez tego 400 INVALID_ARGUMENT.
          tool_config: includeTools ? { include_server_side_tool_invocations: true } : undefined,
          generationConfig: { maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const resText = await res.text();
    if (!res.ok) {
      log("gemini_error", { status: res.status, body: resText.slice(0, 500) });
      return { functionCall: null, functionCallPart: null, text: null };
    }
    const data = JSON.parse(resText);
    const candidate = data.candidates?.[0];
    const parts: Array<Record<string, unknown>> = candidate?.content?.parts ?? [];
    const functionCallPart = parts.find((p) => p.functionCall) as { functionCall?: { name: string; args?: Record<string, unknown> } } | undefined;
    const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text as string).join("").trim();
    log("gemini_raw", {
      model: "gemini-3.5-flash",
      finishReason: candidate?.finishReason,
      partsCount: parts.length,
      functionCall: functionCallPart?.functionCall?.name ?? null,
      chars: text.length,
    });
    return {
      functionCall: functionCallPart?.functionCall ? { name: functionCallPart.functionCall.name, args: functionCallPart.functionCall.args ?? {} } : null,
      // Zwracamy CAŁĄ oryginalną część odpowiedzi (może zawierać thoughtSignature),
      // żeby odesłać ją do Gemini bez zmian w drugiej turze — API odrzuca odtworzone
      // od zera { functionCall: {name, args} } błędem "missing a thought_signature".
      functionCallPart: functionCallPart ?? null,
      text: text || null,
    };
  } catch (e) {
    log("gemini_error", { exception: String(e) });
    return { functionCall: null, functionCallPart: null, text: null };
  }
}

async function callAssistantTool(action: string, args: Record<string, unknown>, userId: string, conversationId: string): Promise<Record<string, unknown>> {
  const url = Deno.env.get("SUPABASE_URL");
  const secret = Deno.env.get("ASSISTANT_TOOLS_SECRET") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const res = await fetch(`${url}/functions/v1/assistant-tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": secret ?? "" },
      body: JSON.stringify({ action, user_id: userId, conversation_id: conversationId, args }),
    });
    return await res.json();
  } catch (e) {
    return { error: "tool_unreachable", detail: String(e) };
  }
}

function directionsErrorMessage(toolResult: Record<string, unknown>): string {
  const error = String(toolResult.error ?? "");
  if (error === "no_api_key") return "Nawigacja jest chwilowo niedostępna (brak konfiguracji).";
  if (error === "missing_address") return `Brak adresu "${toolResult.missing ?? "?"}" w profilu. Uzupełnij go w panelu admina.`;
  if (error === "unsupported_transport") return String(toolResult.message ?? "Ustaw obsługiwany transport w profilu.");
  if (error === "route_too_long") return `Trasa jest zbyt długa na SMS (limit ${toolResult.max_sms_parts ?? 6} części). Wybierz bliższy cel.`;
  if (error === "no_route") return "Nie udało się znaleźć trasy. Sprawdź adresy i spróbuj ponownie.";
  return "Nie udało się pobrać trasy. Spróbuj ponownie.";
}

function formatFastestArrival(toolResult: Record<string, unknown>): string {
  if (toolResult.error) return directionsErrorMessage(toolResult);
  const mode = String(toolResult.best_mode ?? "?");
  const minutes = toolResult.minutes;
  const arrival = toolResult.arrival_time;
  return `Najszybciej: ${mode}, ${minutes} min (przyjazd ~${arrival}).`;
}

function pkpErrorMessage(toolResult: Record<string, unknown>): string {
  const error = String(toolResult.error ?? "");
  if (error === "no_api_key" || error === "pkp_unauthorized") return "Dane kolejowe są chwilowo niedostępne.";
  if (error === "pkp_rate_limited") return "Za dużo zapytań do systemu kolejowego, spróbuj za chwilę.";
  if (error === "pkp_server_error" || error === "pkp_unreachable" || error === "pkp_invalid_response") return "System kolejowy jest chwilowo niedostępny.";
  if (error === "station_not_found") return `Nie znaleziono stacji "${toolResult.query ?? ""}".`;
  if (error === "ambiguous_station") {
    const candidates = Array.isArray(toolResult.candidates) ? (toolResult.candidates as string[]).join(", ") : "";
    return `Kilka stacji pasuje do "${toolResult.query ?? ""}": ${candidates}. Doprecyzuj, o którą chodzi.`;
  }
  if (error === "no_preferred_station") {
    const hint = String(toolResult.hint ?? "");
    if (hint === "dom" || hint === "praca") return `Nie mam ustawionego adresu ${hint === "dom" ? "domu" : "pracy"} w Twoim profilu — podaj nazwę stacji wprost.`;
    return "Nie udało się ustalić stacji z profilu — podaj jej nazwę wprost.";
  }
  if (error === "no_schedule_data" || error === "no_train_data") return "Brak danych rozkładowych dla tego zapytania.";
  if (error === "no_connection_found") return "Nie znalazłem połączenia (bezpośredniego ani z jedną przesiadką) dla tej trasy.";
  return "Nie udało się pobrać danych kolejowych. Spróbuj ponownie.";
}

function formatTrainStationBoard(toolResult: Record<string, unknown>): string {
  if (toolResult.error) return pkpErrorMessage(toolResult);
  return `${toolResult.station}:\n${toolResult.board}`;
}

function formatTrainStatus(toolResult: Record<string, unknown>): string {
  if (toolResult.error) return pkpErrorMessage(toolResult);
  const delay = toolResult.delay_minutes;
  const status = toolResult.status;
  const plannedTime = typeof toolResult.planned_time === "string" ? toolResult.planned_time.slice(0, 5) : "?";
  const delayText = typeof delay === "number" ? (delay > 0 ? `opóźnienie ${delay} min` : "planowo") : "brak danych real-time";
  return `${toolResult.train} (${plannedTime}, ${toolResult.station}): ${delayText}${status ? ` (${status})` : ""}.`;
}

function formatTrainJourney(toolResult: Record<string, unknown>): string {
  if (toolResult.error) return pkpErrorMessage(toolResult);
  const legs = Array.isArray(toolResult.legs) ? toolResult.legs as Record<string, unknown>[] : [];
  if (!legs.length) return "Nie udało się zbudować trasy.";
  if (legs.length === 1) {
    const l = legs[0];
    return `${l.from} -> ${l.to}: odjazd ${l.departure}, przyjazd ${l.arrival} (${l.train}).`;
  }
  return legs.map((l, i) => i === 0
    ? `${l.from} -> ${l.to}: odjazd ${l.departure}, przyjazd ${l.arrival} (${l.train})`
    : `Przesiadka w ${l.from}\n${l.from} -> ${l.to}: odjazd ${l.departure}, przyjazd ${l.arrival} (${l.train})`
  ).join("\n");
}

function formatTrainDisruptions(toolResult: Record<string, unknown>): string {
  if (toolResult.error) return pkpErrorMessage(toolResult);
  const list = Array.isArray(toolResult.disruptions) ? toolResult.disruptions as string[] : [];
  if (!list.length) return "Brak zgłoszonych utrudnień.";
  return list.map((d) => `- ${d}`).join("\n");
}

type ToolContext = { userId: string; convId: string };

type AssistantOutcome =
  | { kind: "closed" }
  | { kind: "route"; text: string }
  | { kind: "text"; text: string; grantedParts?: 1 | 3 | 4 };

// Limit rund narzędzi w jednej turze — bezpiecznik przeciw nieskończonej pętli/kosztowi,
// nie realne ograniczenie: nawet złożone łańcuchy (np. get_user_profile -> plan_train_journey)
// mieszczą się w 2 rundach, 4 to komfortowy margines.
const MAX_TOOL_ROUNDS = 4;

// Model bywa łańcuchuje wywołania narzędzi w jednej turze — np. najpierw get_user_profile
// (żeby "upewnić się" co do adresu), a dopiero potem plan_train_journey, mimo że to
// drugie narzędzie samo umie rozwiązać 'dom'/'praca'. Wcześniej runAssistant obsługiwał
// tylko JEDNO wywołanie narzędzia na turę: gdy druga odpowiedź modelu (po get_user_profile)
// sama była kolejnym functionCall zamiast tekstu, `second.text` było puste i leciał
// generyczny "Przepraszam, wystąpił błąd" — mimo że plan_train_journey nigdy nie zostało
// wywołane. Pętla poniżej obsługuje dowolną (do MAX_TOOL_ROUNDS) liczbę kolejnych wywołań.
async function runAssistant(contents: GeminiContent[], systemPrompt: string, maxOutputTokens: number, ctx: ToolContext): Promise<AssistantOutcome> {
  let currentContents = contents;
  let currentMax = maxOutputTokens;
  let grantedParts: 1 | 3 | 4 | undefined;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let turn = await generateContent(currentContents, systemPrompt, currentMax);
    if (round === 0 && !turn.functionCall && !turn.text) {
      // Zapytanie z narzędziami (funkcje + wbudowane wyszukiwanie) całkowicie zawiodło
      // (np. błąd API 400 przy łączeniu obu typów tools) — spróbuj bez narzędzi, żeby
      // użytkownik dostał realną odpowiedź zamiast zmarnowanego SMS-a z błędem. Tymczasowy
      // bezpiecznik: dopóki przyczyna nie jest naprawiona, narzędzia w tej turze nie zadziałają.
      log("tools_call_failed_retry", { convId: ctx.convId });
      turn = await generateContent(currentContents, systemPrompt, currentMax, false);
    }
    if (!turn.functionCall) {
      return { kind: "text", text: turn.text ?? "Przepraszam, wystąpił błąd. Spróbuj ponownie.", grantedParts };
    }

    const { name, args } = turn.functionCall;
    log("tool_call", { convId: ctx.convId, name, args, round });

    if (name === "close_conversation") {
      await callAssistantTool("close_conversation", {}, ctx.userId, ctx.convId);
      return { kind: "closed" };
    }

    if (DETERMINISTIC_ACTIONS.has(name)) {
      const toolResult = await callAssistantTool(name, args, ctx.userId, ctx.convId);
      log("tool_result", { convId: ctx.convId, name, result: toolResult });

      if (name === "get_fastest_arrival") return { kind: "text", text: formatFastestArrival(toolResult) };
      if (name === "get_train_station_board") return { kind: "text", text: formatTrainStationBoard(toolResult) };
      if (name === "get_train_status") return { kind: "text", text: formatTrainStatus(toolResult) };
      if (name === "plan_train_journey") return { kind: "text", text: formatTrainJourney(toolResult) };
      if (name === "get_train_disruptions") return { kind: "text", text: formatTrainDisruptions(toolResult) };

      // get_directions / get_transit: pełen, sformatowany tekst trasy, wysyłany bez zmian.
      if (toolResult.error) return { kind: "text", text: directionsErrorMessage(toolResult) };
      return { kind: "route", text: String(toolResult.route ?? "") };
    }

    // get_user_profile / allow_long_reply: wynik wraca do modelu, które podejmuje kolejną
    // decyzję — kolejne narzędzie albo już gotowa odpowiedź tekstowa (sprawdzane w następnej
    // iteracji pętli).
    const toolResult = await callAssistantTool(name, args, ctx.userId, ctx.convId);
    log("tool_result", { convId: ctx.convId, name, result: toolResult });

    if (name === "allow_long_reply" && [1, 3, 4].includes(toolResult.granted_parts as number)) {
      grantedParts = toolResult.granted_parts as 1 | 3 | 4;
      currentMax = TOKENS_FOR_PARTS[grantedParts];
    }

    currentContents = [
      ...currentContents,
      { role: "model", parts: [turn.functionCallPart ?? { functionCall: { name, args } }] },
      { role: "function", parts: [{ functionResponse: { name, response: toolResult } }] },
    ];
  }

  log("tool_round_limit_reached", { convId: ctx.convId });
  return { kind: "text", text: "Przepraszam, nie udało się dokończyć tej prośby. Spróbuj sformułować ją prościej.", grantedParts };
}

// Jedno dodatkowe, lekkie wywołanie Gemini (bez narzędzi, mały kontekst) — prosi model,
// żeby SAM streścił własną, za długą odpowiedź do limitu znaków, zamiast pozwolić
// chunkForSms mechanicznie ją uciąć. Wywoływane tylko wtedy, gdy pierwsza odpowiedź
// faktycznie przekroczyła budżet — nie dokłada kosztu/opóźnienia do normalnych, krótkich
// odpowiedzi. Jeśli i skrócona wersja nie zmieści się (model zawodzi rzadko, ale się zdarza),
// chunkForSms zostaje jako ostateczny bezpiecznik — nigdy nie wyślemy więcej niż limit.
async function shortenToFit(text: string, budget: number): Promise<string | null> {
  const prompt = `Poniższy tekst jest za długi na SMS. Streść go do maksymalnie ${budget} znaków, zachowując wyłącznie najważniejszą myśl — nie próbuj zmieścić wszystkiego, wybierz jedną najważniejszą rzecz i ją streść. Nie dodawaj nowych informacji. Nie używaj markdownu (bez **, _, #, list, linków). Cudzysłowy pisz normalnie jako " lub '. Odpowiedz WYŁĄCZNIE streszczonym tekstem, bez komentarza.\n\nTekst do streszczenia:\n${text}`;
  const result = await generateContent(
    [{ role: "user", parts: [{ text: prompt }] }],
    "Jesteś narzędziem do streszczania tekstu do limitu znaków SMS-a.",
    Math.max(150, Math.ceil(budget / 1.3)),
    false
  );
  return result.text;
}

// Czyści odpowiedź modelu i — jeśli mimo instrukcji w prompcie przekracza budżet znaków —
// prosi model o samodzielne streszczenie zamiast mechanicznego przycięcia. chunkForSms
// (wywoływane przez wołającego, po tej funkcji) zostaje jako ostateczny bezpiecznik.
async function buildCleanReply(outcome: Exclude<AssistantOutcome, { kind: "closed" }>, maxParts: number, convId: string): Promise<string> {
  const clean = (raw: string) =>
    stripPolishDiacritics(restrictToSafeSmsCharset(sanitizeForSms(stripMarkdown(stripCitations(stripUrls(raw))))));

  if (outcome.kind === "route") return stripPolishDiacritics(restrictToSafeSmsCharset(outcome.text));

  let cleanReply = clean(outcome.text);
  const budget = smsPartCharsFor(cleanReply) * maxParts;

  if (cleanReply.length > budget) {
    const shortened = await shortenToFit(cleanReply, budget);
    if (shortened) {
      const reCleaned = clean(shortened);
      log("reply_shortened", { convId, originalLen: cleanReply.length, shortenedLen: reCleaned.length, budget });
      cleanReply = reCleaned;
    }
  }

  return cleanReply;
}

// Stały health-check połączenia z API PKP PLK — bez Gemini, bez bazy. Widoczny w panelu
// admina → Testy → Dodatkowe testy. Przydatny nie tylko przy pierwszej aktywacji klucza,
// ale każdorazowo, gdy trzeba szybko sprawdzić, czy PKP_API_KEY nadal działa.
// TYMCZASOWO rozszerzone o próbne pobranie /schedules/routes/{date} — sprawdzenie, czy
// ten endpoint zwraca CAŁY krajowy rozkład na dany dzień w rozsądnej liczbie zapytań
// (fundament pod lokalną kopię rozkładu + własny algorytm szukania przesiadek, zamiast
// odpytywania PKP na żywo per kandydat). Zwęzić z powrotem do samego stations-search po
// zakończeniu weryfikacji.
async function handlePkpTest(): Promise<Response> {
  const apiKey = Deno.env.get("PKP_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, error: "PKP_API_KEY not set" }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  try {
    const res = await fetch("https://pdp-api.plk-sa.pl/api/v1/dictionaries/stations?search=Katowice", {
      headers: { "X-API-Key": apiKey },
    });
    const body = await res.text();
    log("pkp_test", { status: res.status, bodyPreview: body.slice(0, 500) });

    // en-CA formatuje jako YYYY-MM-DD — dokładnie format wymagany przez PKP.
    const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() + 24 * 60 * 60 * 1000));

    let routesInfo: Record<string, unknown>;
    try {
      const routesRes = await fetch(`https://pdp-api.plk-sa.pl/api/v1/schedules/routes/${tomorrow}`, { headers: { "X-API-Key": apiKey } });
      const routesBody = await routesRes.text();
      let parsed: unknown = null;
      let itemCount: number | null = null;
      let topLevelKeys: string[] | null = null;
      try {
        parsed = JSON.parse(routesBody);
        if (parsed && typeof parsed === "object") {
          topLevelKeys = Object.keys(parsed as object);
          for (const key of topLevelKeys) {
            const v = (parsed as Record<string, unknown>)[key];
            if (Array.isArray(v)) { itemCount = v.length; break; }
          }
        }
      } catch { /* nie JSON — zostaw parsed=null */ }
      routesInfo = {
        status: routesRes.status,
        contentLength: routesRes.headers.get("content-length"),
        bodyBytes: routesBody.length,
        topLevelKeys,
        itemCount,
        bodyPreview: routesBody.slice(0, 1500),
      };
      log("pkp_test_routes", { date: tomorrow, ...routesInfo, bodyPreview: undefined });
    } catch (e) {
      routesInfo = { exception: String(e) };
    }

    return new Response(
      JSON.stringify({ ok: res.ok, status: res.status, body: body.slice(0, 2000), routesForDate: tomorrow, routesInfo }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (e) {
    log("pkp_test", { exception: String(e) });
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }
}

// Sentinel user_id rozpoznawany też przez assistant-tools — musi być identyczny w obu miejscach.
const TEST_MODE_USER_ID = "00000000-0000-0000-0000-000000000000";

type TestTurn = { role: "user" | "model"; text: string };

// Panel admina → Testy → Testowe rozmowy. Prawdziwe wywołania Gemini, assistant-tools
// i Google Maps — ale bez realnego użytkownika i bez zapisu jakiejkolwiek rozmowy/
// wiadomości do bazy. Zero SMS-ów, zero danych, czysta symulacja działania endpointów.
// Wieloturowe: `history` (poprzednie tury tej samej rozmowy testowej) i `grantedParts`
// (limit odpowiedzi wynegocjowany przez allow_long_reply w poprzedniej turze) trzyma
// wyłącznie klient (panel, w pamięci przeglądarki) i przekazuje przy każdym wywołaniu —
// serwer pozostaje bezstanowy, więc "rozmowa" istnieje tylko po stronie testującego,
// nigdy w conversations/messages, i można mieć ich równolegle dowolnie wiele.
async function handleEndpointTest(SB: string, KEY: string, rawMsg: string, history: TestTurn[], grantedParts: 1 | 3 | 4): Promise<Response> {
  const content = rawMsg.trim();
  if (!content) return new Response("Empty content", { status: 200, headers: CORS });

  const convId = crypto.randomUUID();

  const aiContents: GeminiContent[] = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: content }] },
  ];

  const settingsRows = await sbGet(SB, KEY, `settings?key=eq.system_prompt_default&select=value`) as Array<{ value: string }>;
  let systemPrompt = settingsRows[0]?.value ?? `Jesteś asystentem SMS. WAŻNE: ODPOWIADAJ MAKSYMALNIE ${SMS_PART_CHARS} ZNAKÓW. Żadnych linków URL. Tylko fakty, zero wstępów.`;
  systemPrompt += `\n\nAktualna data i godzina: ${warsawNowLabel()}. Używaj tego do przeliczania względnych określeń czasu ("jutro", "pojutrze", "za 20 minut", "dzisiaj wieczorem") na konkretne daty (YYYY-MM-DD) i godziny (HH:MM) przekazywane do narzędzi.\n\nMasz dostęp do narzędzi: allow_long_reply, close_conversation, get_user_profile, get_directions, get_transit, get_fastest_arrival, resolve_rail_station, get_train_station_board, get_train_status, plan_train_journey, get_train_disruptions. Wywołuj je tylko gdy intencja użytkownika jest jednoznaczna — nigdy nie zgaduj. get_directions, get_transit, get_fastest_arrival, resolve_rail_station, get_train_station_board, get_train_status i plan_train_journey same rozwiązują 'dom'/'praca' na podstawie profilu — nie wywołuj przed nimi get_user_profile, to niepotrzebna dodatkowa runda. Wyniki nawigacji i danych kolejowych formatuje sam endpoint; nie twórz własnego formatu trasy ani rozkładu. Bieżący limit długości Twojej odpowiedzi tekstowej to ${grantedParts} SMS (${SMS_PART_CHARS * grantedParts} znaków). To zwykły SMS, nie czat: nigdy, w żadnej odpowiedzi, nie używaj żadnego markdownu ani jego elementów — bez **pogrubienia**, _kursywy_, \`kodu\`, nagłówków #, cytatów >, list (- lub 1.), linków [tekst](url), przekreśleń ~~ ani linii poziomych ---. Sam zwykły tekst, cudzysłowy pisz normalnie jako " lub '. Telefon odbiorcy nie wyświetla emoji ani symboli specjalnych (strzałki, gwiazdki-ozdobniki, ptaszki itp.) — pokazują się jako puste kwadraciki, więc nigdy ich nie używaj.`;

  log("endpoint_test_start", { convId, content, historyLen: history.length, grantedParts });
  const outcome = await runAssistant(aiContents, systemPrompt, TOKENS_FOR_PARTS[grantedParts], { userId: TEST_MODE_USER_ID, convId });

  if (outcome.kind === "closed") {
    return new Response(JSON.stringify({ ok: true, test_mode: true, closed: true, granted_parts: grantedParts }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  let maxParts: 1 | 3 | 4 | 6 = grantedParts;
  if (outcome.kind === "route") maxParts = 6;
  else if (outcome.kind === "text" && outcome.grantedParts) maxParts = outcome.grantedParts;
  const cleanReply = await buildCleanReply(outcome, maxParts, convId);
  const parts = chunkForSms(cleanReply, maxParts);
  const nextGrantedParts = (outcome.kind === "text" && outcome.grantedParts) ? outcome.grantedParts : grantedParts;

  log("endpoint_test_done", { convId, kind: outcome.kind, parts: parts.length });

  return new Response(
    JSON.stringify({ ok: true, test_mode: true, reply: cleanReply, parts: parts.length, granted_parts: nextGrantedParts }),
    { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
  );
}

// --- Handler ---

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET") {
    const echo = new URL(req.url).searchParams.get("zd_echo");
    return new Response(echo ?? "OK", { status: 200, headers: CORS });
  }
  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  const testMode = new URL(req.url).searchParams.get("endpoint_test") === "1";
  const pkpTest = new URL(req.url).searchParams.get("pkp_test") === "1";
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  let raw: Record<string, string>;
  // Tryb testowy (endpoint_test=1) przesyła też `history`/`grantedParts` — pola, które
  // nie mają sensu w typie używanym dla realnego SMS-a (Record<string,string>), więc
  // trzymamy nieprzetworzony JSON osobno, tylko na potrzeby tej ścieżki.
  let rawJson: Record<string, unknown> = {};
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      rawJson = await req.json();
      raw = rawJson as Record<string, string>;
    } else {
      raw = Object.fromEntries(new URLSearchParams(await req.text()));
    }
  } catch {
    return new Response("Bad request", { status: 400, headers: CORS });
  }

  if (raw.zd_echo) return new Response(raw.zd_echo, { status: 200, headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL")!;
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  initLog(SB, KEY);

  if (pkpTest) {
    return await handlePkpTest();
  }

  // Zapisz raw payload do webhook_logs
  await sbPost(SB, KEY, "webhook_logs", { raw_payload: raw });

  const event = (raw.event ?? "").toLowerCase();
  if (event !== "sms" && event !== "incoming_sms") {
    log("ignored", { reason: "wrong_event", event: raw.event });
    return new Response("Ignored", { status: 200, headers: CORS });
  }

  // Zadarma może wysłać dane SMS bezpośrednio lub zagnieżdżone w polu result (JSON string)
  let data: Record<string, string> = raw;
  if (raw.result && typeof raw.result === "string") {
    try { data = { ...raw, ...JSON.parse(raw.result) }; } catch { /* ignore */ }
  }

  const senderPhone = data.sms_from ?? data.caller_id ?? "";
  const recipientDid = data.sms_to ?? data.caller_did ?? data.called_did ?? "";
  const smsBody = data.msg ?? data.text ?? "";

  if (testMode) {
    const historyIn = Array.isArray(rawJson.history)
      ? (rawJson.history as unknown[]).filter(
          (h): h is TestTurn => !!h && typeof h === "object" && ((h as TestTurn).role === "user" || (h as TestTurn).role === "model") && typeof (h as TestTurn).text === "string",
        )
      : [];
    const grantedPartsIn = ([1, 3, 4].includes(rawJson.grantedParts as number) ? rawJson.grantedParts : 1) as 1 | 3 | 4;
    return await handleEndpointTest(SB, KEY, smsBody, historyIn, grantedPartsIn);
  }

  if (!senderPhone || !smsBody) {
    log("error", { reason: "missing_fields", senderPhone: !!senderPhone, smsBody: !!smsBody, raw });
    return new Response("Missing fields", { status: 400, headers: CORS });
  }

  // Identyfikacja użytkownika: najpierw po numerze telefonu, fallback na kod
  type UserRow = { id: string; active: boolean; system_prompt: string | null };
  const usersByPhone = await sbGet(SB, KEY, `users?phone_number=eq.${encodeURIComponent(senderPhone)}&active=eq.true&select=id,active,system_prompt`) as UserRow[];

  let matchedUsers: UserRow[];
  let convCode: string | null;
  let effectiveContent: string;

  if (usersByPhone.length) {
    // Znany numer — kod użytkownika zbędny
    matchedUsers = usersByPhone;
    const parsed = parseSmsKnownPhone(smsBody);
    convCode = parsed.convCode;
    effectiveContent = parsed.content;
    log("sms_parsed", { from: senderPhone, to: recipientDid, knownPhone: true, convCode, content: effectiveContent, smsBody });
  } else {
    // Nieznany numer — wymagany kod użytkownika (pierwsza linia)
    const parsed = parseSmsUnknownPhone(smsBody);
    convCode = parsed.convCode;
    effectiveContent = parsed.content;
    log("sms_parsed", { from: senderPhone, to: recipientDid, knownPhone: false, userCode: parsed.userCode, convCode, content: effectiveContent, smsBody });

    matchedUsers = await sbGet(SB, KEY, `users?code=eq.${parsed.userCode}&active=eq.true&select=id,active,system_prompt`) as UserRow[];
    if (!matchedUsers.length) {
      log("error", { reason: "unknown_user", userCode: parsed.userCode, from: senderPhone });
      return new Response("Unknown user", { status: 200, headers: CORS });
    }
  }

  if (!effectiveContent) {
    log("error", { reason: "empty_content", from: senderPhone, smsBody });
    return new Response("Empty content", { status: 200, headers: CORS });
  }

  const userId = matchedUsers[0].id;
  const userSystemPrompt = matchedUsers[0].system_prompt ?? null;

  log("sms_in", { from: senderPhone, to: recipientDid, convCode, content: effectiveContent });

  // Znalezienie lub utworzenie rozmowy
  type Conv = { id: string; code: string; summary: string | null; reply_sms_parts: number };
  let conv: Conv | null = null;

  if (convCode) {
    const found = await sbGet(SB, KEY, `conversations?code=eq.${convCode}&user_id=eq.${userId}&status=eq.active&select=id,code,summary,reply_sms_parts`) as Conv[];
    conv = found[0] ?? null;
    if (!conv) log("error", { reason: "conv_not_found", convCode, userId });
  }

  if (!conv) {
    let newCode = "";
    for (let i = 0; i < 10; i++) {
      newCode = generateCode(6);
      const existing = await sbGet(SB, KEY, `conversations?code=eq.${newCode}&select=id`);
      if (!existing.length) break;
    }
    await sbPost(SB, KEY, "conversations", { user_id: userId, code: newCode, status: "active" });
    const created = await sbGet(SB, KEY, `conversations?code=eq.${newCode}&select=id,code,summary,reply_sms_parts`) as Conv[];
    conv = created[0] ?? null;
    if (conv) log("conv_new", { convCode: newCode, userId, requestedConvCode: convCode ?? null });
  }

  if (!conv) {
    log("error", { reason: "conv_create_failed", userId });
    return new Response("Failed to create conversation", { status: 500, headers: CORS });
  }

  const convId = conv.id;
  const convCodeFinal = conv.code;
  let summary = conv.summary ?? null;
  let replySmsParts = ([1, 3, 4].includes(conv.reply_sms_parts) ? conv.reply_sms_parts : 1) as 1 | 3 | 4;
  const suffix = `\n${convCodeFinal}`;

  // Zamknięcie rozmowy szybką ścieżką — bez angażowania modelu dla oczywistej intencji
  if (CLOSE_KEYWORDS.includes(effectiveContent.trim().toLowerCase())) {
    await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { status: "closed", pending_reply: null });
    log("conv_closed", { convId, convCode: convCodeFinal, userId, trigger: effectiveContent.trim() });
    return new Response(JSON.stringify({ ok: true, closed: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Historia wiadomości
  type Msg = { direction: string; content: string; created_at: string };
  const msgs = await sbGet(SB, KEY, `messages?conversation_id=eq.${convId}&order=created_at.asc&select=direction,content,created_at`) as Msg[];

  // Sprawdź duplikaty — Zadarma może wielokrotnie wysłać ten sam webhook
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const isDuplicate = msgs.some(
    (m) => m.direction === "in" && m.content === effectiveContent && m.created_at >= twoMinutesAgo
  );
  if (isDuplicate) {
    log("duplicate_skipped", { convId, convCode: convCodeFinal, content: effectiveContent });
    return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Kompaktowanie historii — czysto techniczny krok utrzymania pamięci, osobny
  // od odpowiadania na wiadomość. Dzięki temu narzędzia (nawigacja, dłuższa
  // odpowiedź, zamknięcie rozmowy) działają zawsze, niezależnie od długości
  // rozmowy — nie tylko wtedy, gdy akurat nie trafiamy na próg kompaktowania.
  if (msgs.length >= COMPACT_THRESHOLD) {
    log("compaction", { convId, convCode: convCodeFinal, msgCount: msgs.length });
    const historyText = msgs.map((m) => `${m.direction === "in" ? "User" : "AI"}: ${m.content}`).join("\n");
    const summaryPrompt: GeminiContent[] = [{
      role: "user",
      parts: [{
        text: `Historia rozmowy SMS:\n${historyText}${summary ? `\n\nPoprzednie streszczenie: ${summary}` : ""}\n\nZadanie: zwróć wyłącznie zwięzłe, ale kompletne podsumowanie całej rozmowy — zachowaj wszystkie istotne fakty, ustalenia i kontekst potrzebny do dalszej rozmowy. Nie odpowiadaj na żadną wiadomość, tylko podsumuj.`,
      }],
    }];
    const summaryResult = await generateContent(
      summaryPrompt,
      "Jesteś systemem podsumowującym rozmowy SMS. Zwróć czysty tekst podsumowania, bez wstępów i bez JSON-a.",
      600,
      false, // bez narzędzi — to tylko streszczenie, nie odpowiedź na wiadomość
    );
    if (summaryResult.text) {
      summary = summaryResult.text;
      await sbDelete(SB, KEY, "messages", `conversation_id=eq.${convId}`);
      await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, { summary });
      msgs.length = 0; // historia już w streszczeniu — nie dubluj jej w kontekście odpowiedzi
    } else {
      log("compaction_failed", { convId, convCode: convCodeFinal });
    }
  }

  // Kontekst dla AI — zawsze ta sama ścieżka, z narzędziami, niezależnie od tego,
  // czy chwilę wcześniej doszło do kompaktowania.
  const aiContents: GeminiContent[] = [];
  if (summary) aiContents.push({ role: "user", parts: [{ text: `[Kontekst rozmowy: ${summary}]` }] });
  for (const m of msgs) {
    aiContents.push({ role: m.direction === "in" ? "user" : "model", parts: [{ text: m.content }] });
  }
  aiContents.push({ role: "user", parts: [{ text: effectiveContent }] });

  let systemPrompt = userSystemPrompt ?? null;
  if (!systemPrompt) {
    const settings = await sbGet(SB, KEY, `settings?key=eq.system_prompt_default&select=value`) as Array<{ value: string }>;
    systemPrompt = settings[0]?.value ?? `Jesteś asystentem SMS. WAŻNE: ODPOWIADAJ MAKSYMALNIE ${SMS_PART_CHARS} ZNAKÓW. Żadnych linków URL. Tylko fakty, zero wstępów.`;
  }
  systemPrompt += `\n\nAktualna data i godzina: ${warsawNowLabel()}. Używaj tego do przeliczania względnych określeń czasu ("jutro", "pojutrze", "za 20 minut", "dzisiaj wieczorem") na konkretne daty (YYYY-MM-DD) i godziny (HH:MM) przekazywane do narzędzi.\n\nMasz dostęp do narzędzi: allow_long_reply, close_conversation, get_user_profile, get_directions, get_transit, get_fastest_arrival, resolve_rail_station, get_train_station_board, get_train_status, plan_train_journey, get_train_disruptions. Wywołuj je tylko gdy intencja użytkownika jest jednoznaczna — nigdy nie zgaduj. get_directions, get_transit, get_fastest_arrival, resolve_rail_station, get_train_station_board, get_train_status i plan_train_journey same rozwiązują 'dom'/'praca' na podstawie profilu — nie wywołuj przed nimi get_user_profile, to niepotrzebna dodatkowa runda. Wyniki nawigacji i danych kolejowych formatuje sam endpoint; nie twórz własnego formatu trasy ani rozkładu. Bieżący limit długości Twojej odpowiedzi tekstowej to ${replySmsParts} SMS (${SMS_PART_CHARS * replySmsParts} znaków). To zwykły SMS, nie czat: nigdy, w żadnej odpowiedzi, nie używaj żadnego markdownu ani jego elementów — bez **pogrubienia**, _kursywy_, \`kodu\`, nagłówków #, cytatów >, list (- lub 1.), linków [tekst](url), przekreśleń ~~ ani linii poziomych ---. Sam zwykły tekst, cudzysłowy pisz normalnie jako " lub '. Telefon odbiorcy nie wyświetla emoji ani symboli specjalnych (strzałki, gwiazdki-ozdobniki, ptaszki itp.) — pokazują się jako puste kwadraciki, więc nigdy ich nie używaj.`;

  const outcome: AssistantOutcome = await runAssistant(aiContents, systemPrompt, TOKENS_FOR_PARTS[replySmsParts], { userId, convId });

  // Zamknięcie rozmowy przez narzędzie — bez odpowiedzi SMS, zgodnie z ustaloną decyzją produktową
  if (outcome.kind === "closed") {
    await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "in", content: effectiveContent });
    log("conv_closed", { convId, convCode: convCodeFinal, userId, trigger: "tool" });
    return new Response(JSON.stringify({ ok: true, closed: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  if (outcome.kind === "text" && outcome.grantedParts) {
    replySmsParts = outcome.grantedParts;
    log("reply_sms_parts_granted", { convId, convCode: convCodeFinal, granted: replySmsParts });
  }

  const maxParts = outcome.kind === "route" ? 6 : replySmsParts;
  const cleanReply = await buildCleanReply(outcome, maxParts, convId);
  const parts = chunkForSms(cleanReply, maxParts);

  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "in", content: effectiveContent });
  await sbPost(SB, KEY, "messages", { conversation_id: convId, direction: "out", content: cleanReply });
  await sbPatch(SB, KEY, "conversations", `id=eq.${convId}`, {
    last_activity_at: new Date().toISOString(),
    reply_sms_parts: replySmsParts,
    pending_reply: null,
  });

  log("ai_response", { convId, convCode: convCodeFinal, kind: outcome.kind, chars: cleanReply.length, parts: parts.length });

  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, dry_run: true, reply: parts.map((p) => `${p}${suffix}`).join("\n---\n"), parts: parts.length }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Saldo tuż przed pierwszą częścią — gęstszy strumień obserwacji zmniejsza ryzyko,
  // że doładowanie/opłata trafi w to samo okno co ta wysyłka i zostanie błędnie
  // zinterpretowane (patrz computeBalanceTimeline w panelu). Koszt liczony odroczenie,
  // nie tutaj — to tylko dodatkowy punkt odniesienia dla tamtego dopasowania.
  const balanceBeforeSend = await getZadarmaBalance();
  if (balanceBeforeSend !== null) {
    sbPost(SB, KEY, "balance_observations", { balance: balanceBeforeSend, trigger: "pre_send" }).catch(() => {});
  }

  // Każda część liczona osobno: jeśli część 3 z 6 zawiedzie, części 1-2 mimo to
  // realnie kosztowały i mają trafić do sms_sends — nie odrzucamy całej partii.
  let successfulParts = 0;
  let sendError: unknown = null;
  for (const part of parts) {
    try {
      await sendSms(senderPhone, `${part}${suffix}`, recipientDid);
      successfulParts++;
    } catch (e) {
      sendError = e;
      break;
    }
  }

  if (successfulParts > 0) {
    sbPost(SB, KEY, "sms_sends", { parts_sent: successfulParts, source: "webhook" }).catch(() => {});
    // Krótkie opóźnienie w tle (po odpowiedzi webhooka), żeby dać Zadarmie czas na
    // zaksięgowanie obciążenia zanim sprawdzimy saldo "po" — bez tego pomiar
    // wykonany natychmiast mógłby złapać saldo sprzed zaksięgowania i zaniżyć koszt.
    const afterCheck = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const balanceAfter = await getZadarmaBalance();
      if (balanceAfter !== null) {
        await sbPost(SB, KEY, "balance_observations", { balance: balanceAfter, trigger: "post_send" });
      }
    })();
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(afterCheck);
  }

  if (sendError) {
    log("sms_error", { to: senderPhone, from: recipientDid, error: String(sendError), successfulParts });
    return new Response(JSON.stringify({ ok: false, error: String(sendError), successfulParts }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  log("sms_sent", { to: senderPhone, from: recipientDid, parts: parts.length });
  return new Response(JSON.stringify({ ok: true, parts: parts.length }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
});
