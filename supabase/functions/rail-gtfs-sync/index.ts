import postgres from "npm:postgres@3.4.5";
import { ZipReader, Uint8ArrayReader, TextWriter } from "npm:@zip.js/zip.js@2.8.59";

// Synchronizacja lokalnej kopii rozkładu kolejowego z darmowego feedu GTFS
// (https://mkuran.pl/gtfs/polish_trains.zip, zbudowanego z tego samego źródła co
// nasze API PKP PLK — zob. supabase/migrations/20240118000000_rail_gtfs.sql).
//
// Dwie akcje, wywoływane przez pg_cron (nie GitHub Actions — Actions w tym repo jest
// wyłącznie do deployu):
//   "start" (raz dziennie) — sprawdza Last-Modified feedu, jeśli zmieniony: pobiera cały
//     zip (skompresowany, bez rozpakowywania) i odkłada go w całości do Supabase Storage
//     jako _source.zip, zakłada nowy wiersz rail_sync_runs.
//   "tick" (co 2 minuty) — wznawia pracę od miejsca zapisanego w rail_sync_runs
//     (current_file/current_offset). Dla każdego pliku GTFS pierwszy tick go rozpakowuje
//     z _source.zip (jeden plik na jedno wywołanie — zob. extractOneFile), kolejne go
//     parsują: małe pliki (stops/routes/calendar/calendar_dates/trips) w całości w jednym
//     ticku, stop_times.txt (jedyny spodziewany duży plik) w ograniczonych kawałkach
//     bajtowych czytanych z Storage przez Range request, kilka kawałków na tick (zob.
//     MAX_CHUNKS_PER_TICK). Po ostatnim kawałku ostatniego pliku: wywołuje Etap B (czysty
//     SQL, funkcja rail_gtfs_transform w bazie — patrz migracja) i "mark and sweep"
//     starych wierszy.
//
// UWAGA: kod przechodził już realną, częściową weryfikację (pierwsza wersja doszła do
// >100k wierszy stop_times.txt zanim WAF Cloudflare przed Supabase zablokował serię
// szybkich zapytań Range, a osobno "start" trafił w WORKER_RESOURCE_LIMIT przy
// rozpakowywaniu wszystkich plików naraz) — oba te problemy zaadresowane w obecnej
// wersji (rozpakowywanie plik-po-pliku, kilka kawałków na tick z odstępem czasowym),
// ale wciąż nie ma pełnego przebiegu end-to-end od "start" do "success" potwierdzonego
// na żywo. Diagnozować z rail_sync_runs.error i logów funkcji.

const FEED_URL = "https://mkuran.pl/gtfs/polish_trains.zip";
const BUCKET = "rail-gtfs-raw";
const SMALL_FILES = ["stops.txt", "routes.txt", "calendar.txt", "calendar_dates.txt", "trips.txt"];
const BIG_FILE = "stop_times.txt";
const ALL_FILES = [...SMALL_FILES, BIG_FILE];
// 8MB na tick — realny test pokazał, że 4MB (~53k wierszy) mieści się w limicie 2s CPU
// z zapasem; 8MB to mniej zapytań Range do Storage (patrz MAX_CONSECUTIVE_ERRORS niżej —
// Cloudflare przed Supabase potrafi zablokować serię szybkich zapytań do tego samego
// obiektu, więc mniej zapytań = mniejsze ryzyko trafienia w ten limit).
const STOP_TIMES_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CONSECUTIVE_ERRORS = 5; // po tylu kolejnych nieudanych tickach pod rząd dopiero uznajemy sync za faktycznie zepsuty
// Kilka kawałków w JEDNYM ticku zamiast jednego — realnie przyspiesza cały sync (mniej
// czekania na cron co 2 min). Ostrożnie: 3 kawałki x 8MB to bezpieczny margines pod
// limit 2s CPU (ekstrapolacja z realnego testu: 4MB/~53k wierszy działało bez problemu,
// więc 3x8MB powinno się zmieścić, ale to nadal szacunek, nie zmierzony fakt), a mały
// odstęp między zapytaniami ma nie wyglądać dla Cloudflare jak seria ataku.
const MAX_CHUNKS_PER_TICK = 3;
const CHUNK_DELAY_MS = 500;
const INSERT_BATCH = 2000; // wierszy na jedno zapytanie bulk-insert

// Mapowanie: nazwa pliku GTFS -> {tabela raw, mapowanie kolumna GTFS -> kolumna raw}.
// Tylko pola faktycznie potrzebne CSA i istniejącym formatterom (zob. plan) — reszta
// kolumn GTFS jest ignorowana, jeśli w ogóle obecna w danym eksporcie.
const FILE_CONFIG: Record<string, { table: string; cols: Record<string, string> }> = {
  "stops.txt": { table: "rail_raw_stops", cols: { stop_id: "stop_id", stop_name: "name", stop_lat: "lat", stop_lon: "lon" } },
  "routes.txt": { table: "rail_raw_routes", cols: { route_id: "route_id", route_short_name: "short_name", route_long_name: "long_name", route_type: "route_type" } },
  "calendar.txt": {
    table: "rail_raw_calendar",
    cols: {
      service_id: "service_id", monday: "monday", tuesday: "tuesday", wednesday: "wednesday",
      thursday: "thursday", friday: "friday", saturday: "saturday", sunday: "sunday",
      start_date: "start_date", end_date: "end_date",
    },
  },
  "calendar_dates.txt": { table: "rail_raw_calendar_dates", cols: { service_id: "service_id", date: "date", exception_type: "exception_type" } },
  "trips.txt": { table: "rail_raw_trips", cols: { trip_id: "trip_id", route_id: "route_id", service_id: "service_id", trip_short_name: "short_name", trip_headsign: "headsign" } },
  "stop_times.txt": { table: "rail_raw_stop_times", cols: { trip_id: "trip_id", stop_id: "stop_id", stop_sequence: "stop_sequence", arrival_time: "arrival_time", departure_time: "departure_time" } },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function sbHeaders(key: string, extra: Record<string, string> = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

// --- Parsowanie CSV (RFC4180-owe pola w cudzysłowie z przecinkami/escaped "") ---
// Świadome ograniczenie: NIE obsługuje pól z osadzonym znakiem nowej linii wewnątrz
// cudzysłowu — dane tutaj to id/nazwy/godziny/liczby, nie wolny tekst, więc to
// akceptowalne uproszczenie, nie przeoczenie.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(cur);
      cur = "";
    } else if (c === "\r") {
      // ignoruj — CRLF obsłużone przez podział po \n wyżej
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function buildHeaderMap(headerLine: string): Record<string, number> {
  const fields = parseCsvLine(headerLine).map((f) => f.trim());
  const map: Record<string, number> = {};
  fields.forEach((name, i) => { map[name] = i; });
  return map;
}

function rowsToObjects(fileName: string, lines: string[], headerMap: Record<string, number>): Record<string, string>[] {
  const cfg = FILE_CONFIG[fileName];
  const gtfsCols = Object.keys(cfg.cols);
  const out: Record<string, string>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const obj: Record<string, string> = {};
    for (const gtfsCol of gtfsCols) {
      const idx = headerMap[gtfsCol];
      obj[cfg.cols[gtfsCol]] = idx !== undefined ? (fields[idx] ?? "").trim() : "";
    }
    out.push(obj);
  }
  return out;
}

// --- Supabase Storage (bucket prywatny — service role key na każde wywołanie) ---

async function storagePutText(SB: string, KEY: string, path: string, content: string | Uint8Array): Promise<void> {
  const res = await fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: sbHeaders(KEY, { "Content-Type": "application/octet-stream", "x-upsert": "true" }),
    body: content,
  });
  if (!res.ok) throw new Error(`storage_put_failed ${path}: HTTP ${res.status} ${await res.text()}`);
}

async function storageGetFull(SB: string, KEY: string, path: string): Promise<Uint8Array> {
  const res = await fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, { headers: sbHeaders(KEY) });
  if (!res.ok) throw new Error(`storage_get_failed ${path}: HTTP ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Zwraca fragment obiektu [start, start+len) oraz całkowity rozmiar pliku (z nagłówka
// Content-Range odpowiedzi). Jeśli plik jest krótszy niż żądany zakres, zwrócony tekst
// będzie krótszy — to sygnał końca pliku.
async function storageGetRange(SB: string, KEY: string, path: string, start: number, len: number): Promise<{ text: string; totalSize: number }> {
  const res = await fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, {
    headers: sbHeaders(KEY, { Range: `bytes=${start}-${start + len - 1}` }),
  });
  if (!res.ok && res.status !== 206) throw new Error(`storage_range_failed ${path}: HTTP ${res.status} ${await res.text()}`);
  const contentRange = res.headers.get("content-range"); // format: "bytes start-end/total"
  const totalSize = contentRange ? parseInt(contentRange.split("/")[1] ?? "0", 10) : start + len;
  const text = await res.text();
  return { text, totalSize };
}

// --- Etap A: "start" — pobierz surowy zip (bez rozpakowywania!) i odłóż do Storage ---
//
// WAŻNE (poprawione po realnym WORKER_RESOURCE_LIMIT): rozpakowywanie WSZYSTKICH 6
// plików GTFS w jednym wywołaniu — a zwłaszcza stop_times.txt, ~52MB tekstu po
// dekompresji — potrafi przekroczyć limit zasobów pojedynczego Edge Function. "start"
// więc TYLKO przenosi bajty (pobiera skompresowany zip, odkłada go w całości do Storage
// jako _source.zip) — żadnej dekompresji tutaj. Samo rozpakowanie, PLIK PO PLIKU, jedno
// wywołanie na jeden plik, dzieje się dopiero w handleTick (zob. extractOneFile)
// — dokładnie ta sama logika "jeden krok na raz" co przy parsowaniu.
async function handleStart(SB: string, KEY: string): Promise<Response> {
  const sql = getSql();
  try {
    const headRes = await fetch(FEED_URL, { method: "HEAD" });
    const lastModifiedHeader = headRes.headers.get("last-modified");
    const feedLastModified = lastModifiedHeader ? new Date(lastModifiedHeader) : null;

    const [lastSuccess] = await sql<{ feed_last_modified: string | null }[]>`
      select feed_last_modified from rail_sync_runs
      where status = 'success'
      order by finished_at desc nulls last limit 1
    `;
    if (feedLastModified && lastSuccess?.feed_last_modified && new Date(lastSuccess.feed_last_modified).getTime() === feedLastModified.getTime()) {
      await sql.end();
      return json({ ok: true, skipped: "unchanged" });
    }

    // WORKER_RESOURCE_LIMIT potrafi ubić wywołanie tak brutalnie, że nie zdąży nawet
    // wykonać własnego catch-bloku (status zostaje 'running' na zawsze) — bez tego
    // sprawdzenia taki porzucony bieg blokowałby każdy kolejny "start" w nieskończoność.
    // Sprawdzamy WSZYSTKIE wiersze 'running' (mogło ich się uzbierać kilka z kolejnych
    // nieudanych prób), nie tylko pierwszy z brzegu — bez ORDER BY jeden zapytanie
    // `limit 1` mogło trafić akurat na świeży wiersz, mijając starszy, naprawdę
    // porzucony, i błędnie zgłosić "already_running".
    const runningRows = await sql<{ id: string; started_at: string }[]>`select id, started_at from rail_sync_runs where status = 'running' order by started_at desc`;
    if (runningRows.length) {
      const freshest = runningRows[0];
      const ageMs = Date.now() - new Date(freshest.started_at).getTime();
      // Normalny pełny przebieg (nawet czystym cronem co 2 min) mieści się dużo poniżej
      // godziny, więc jeśli nawet najświeższy 'running' jest starszy — wszystkie są porzucone.
      if (ageMs < 60 * 60 * 1000) {
        await sql.end();
        return json({ ok: true, skipped: "already_running" });
      }
      await sql`update rail_sync_runs set status = 'failed', finished_at = now(), error = 'stale_abandoned_run' where status = 'running'`;
    }

    // Czyste raw tabele przed nowym syncem — na wypadek, gdyby poprzedni sync zawiódł
    // w trakcie i zostawił częściowe wiersze (rail_gtfs_transform też to robi na końcu,
    // ale tylko przy pełnym sukcesie).
    await sql`truncate rail_raw_stops, rail_raw_routes, rail_raw_calendar, rail_raw_calendar_dates, rail_raw_trips, rail_raw_stop_times`;

    const zipRes = await fetch(FEED_URL);
    if (!zipRes.ok) throw new Error(`feed_fetch_failed: HTTP ${zipRes.status}`);
    const zipBytes = new Uint8Array(await zipRes.arrayBuffer());

    const [run] = await sql<{ id: string }[]>`
      insert into rail_sync_runs (status, current_file, current_offset, feed_last_modified)
      values ('running', ${SMALL_FILES[0]}, -1, ${feedLastModified ? feedLastModified.toISOString() : null})
      returning id
    `;
    // current_offset = -1 to sentinel: "current_file jeszcze nie rozpakowany z zipa" —
    // pierwszy tick dla każdego pliku musi go najpierw wydobyć, zanim zacznie parsować.
    await storagePutText(SB, KEY, `${run.id}/_source.zip`, zipBytes);
    // Ta sama weryfikacja co w extractOneFile — zaobserwowany realnie przypadek, gdzie
    // POST upload zwraca 200 OK, ale obiekt nie zostaje poprawnie zapisany w Storage.
    const verify = await storageGetRange(SB, KEY, `${run.id}/_source.zip`, 0, 64);
    if (verify.totalSize < zipBytes.length) {
      throw new Error(`start_upload_verify_failed _source.zip: uploaded ${zipBytes.length} bytes, storage reports only ${verify.totalSize}`);
    }

    await sql.end();
    return json({ ok: true, runId: run.id, feedLastModified: feedLastModified?.toISOString() ?? null });
  } catch (e) {
    await sql`update rail_sync_runs set status = 'failed', finished_at = now(), error = ${String(e)} where status = 'running'`.catch(() => {});
    await sql.end();
    return json({ ok: false, error: String(e) }, 500);
  }
}

// Rozpakowuje JEDEN plik GTFS z odłożonego _source.zip i wgrywa go do Storage —
// wywoływane raz na tick, zanim ten plik może zostać sparsowany. Zwraca false, jeśli
// pliku nie ma w zipie (dozwolone przez spec dla wszystkich poza stop_times.txt).
async function extractOneFile(SB: string, KEY: string, runId: string, fileName: string): Promise<boolean> {
  const zipBytes = await storageGetFull(SB, KEY, `${runId}/_source.zip`);
  const reader = new ZipReader(new Uint8ArrayReader(zipBytes));
  try {
    const entries = await reader.getEntries();
    const entry = entries.find((e) => e.filename === fileName || e.filename.endsWith(`/${fileName}`));
    if (!entry || entry.directory) {
      if (fileName === BIG_FILE) throw new Error(`gtfs_file_missing_in_zip: ${fileName}`);
      return false;
    }
    const text = await entry.getData(new TextWriter());
    await storagePutText(SB, KEY, `${runId}/${fileName}`, text);
    // Weryfikacja UPLOAD-u — realnie zaobserwowane: POST dla dużego (~52MB) ciała
    // potrafi zwrócić 200 OK, a obiekt mimo to nie zostaje poprawnie zapisany (kolejny
    // odczyt daje 404 NoSuchKey). Bez tego current_offset przechodzi na 0 (uznane za
    // "wyodrębnione"), a błąd wychodzi dopiero przy parsowaniu, z mylącym komunikatem.
    // Rzucenie tutaj zamiast tego zostawia current_offset na -1, więc następny tick
    // po prostu spróbuje wgrać ten plik jeszcze raz.
    // Rozmiar w bajtach (Storage) jest zawsze >= długości stringa w jednostkach UTF-16
    // (text.length) — znaki spoza ASCII tylko DODAJĄ bajty, nigdy nie ubywa — więc to
    // bezpieczny, zawsze-prawdziwy dla poprawnego uploadu warunek.
    const verify = await storageGetRange(SB, KEY, `${runId}/${fileName}`, 0, 64);
    if (verify.totalSize < text.length) {
      throw new Error(`extract_upload_verify_failed ${fileName}: uploaded ${text.length} JS chars, storage reports only ${verify.totalSize} bytes`);
    }
    return true;
  } finally {
    await reader.close();
  }
}

// --- Etap A (ciąg dalszy) + Etap B: "tick" — jeden krok postępu, zawsze bezpieczny do przerwania ---

async function handleTick(SB: string, KEY: string): Promise<Response> {
  const sql = getSql();
  try {
    const [run] = await sql<{
      id: string; current_file: string | null; current_offset: number; current_header: unknown;
    }[]>`select id, current_file, current_offset, current_header from rail_sync_runs where status = 'running' order by started_at asc limit 1`;
    if (!run) { await sql.end(); return json({ ok: true, skipped: "nothing_running" }); }
    if (!run.current_file) { await sql.end(); return json({ ok: true, skipped: "no_current_file" }); }

    const fileName = run.current_file;
    let rowsInserted = 0;

    // current_offset === -1: ten plik jeszcze nie został rozpakowany z _source.zip —
    // zrób to teraz, jako CAŁE to wywołanie (parsowanie zaczyna się dopiero od
    // następnego ticku) — trzyma dekompresję jednego pliku w osobnym, lekkim wywołaniu,
    // zamiast robić to dla wszystkich 6 plików naraz (to właśnie powodowało
    // WORKER_RESOURCE_LIMIT w poprzedniej wersji handleStart).
    if (run.current_offset === -1) {
      const extracted = await extractOneFile(SB, KEY, run.id, fileName);
      await sql`update rail_sync_runs set current_offset = 0, consecutive_errors = 0 where id = ${run.id}`;
      await sql.end();
      return json({ ok: true, extracted: extracted ? fileName : null, skipped: extracted ? undefined : "not_in_feed" });
    }

    if (SMALL_FILES.includes(fileName)) {
      // Plik mógł nie istnieć w zipie (dozwolone przez spec GTFS — zob. handleStart) —
      // brak obiektu w Storage traktujemy jako pusty plik, nie błąd.
      let text = "";
      try {
        text = (await storageGetRange(SB, KEY, `${run.id}/${fileName}`, 0, 200 * 1024 * 1024)).text;
      } catch { /* plik nieobecny w tym syncu — zero wierszy, kontynuuj */ }
      const lines = text.split("\n");
      const headerMap = buildHeaderMap(lines[0] ?? "");
      const dataLines = lines.slice(1);
      const objects = rowsToObjects(fileName, dataLines, headerMap);
      const cfg = FILE_CONFIG[fileName];
      const targetCols = Object.values(cfg.cols);
      for (let i = 0; i < objects.length; i += INSERT_BATCH) {
        const batch = objects.slice(i, i + INSERT_BATCH);
        if (batch.length) {
          await sql`insert into ${sql(cfg.table)} ${sql(batch, ...targetCols)}`;
          rowsInserted += batch.length;
        }
      }
      const nextIdx = ALL_FILES.indexOf(fileName) + 1;
      const nextFile = ALL_FILES[nextIdx] ?? null;
      // -1: następny plik jeszcze nie rozpakowany z zipa (zob. blok current_offset === -1 wyżej).
      await sql`update rail_sync_runs set current_file = ${nextFile}, current_offset = ${nextFile ? -1 : 0}, current_header = null, consecutive_errors = 0, rows_processed = rows_processed + ${rowsInserted} where id = ${run.id}`;
      if (!nextFile) await finishRun(sql, run.id);
      await sql.end();
      return json({ ok: true, file: fileName, rowsInserted, nextFile });
    }

    // fileName === BIG_FILE (stop_times.txt) — kawałkami po STOP_TIMES_CHUNK_BYTES bajtów.
    let headerMap = run.current_header as Record<string, number> | null;
    let offset = run.current_offset;
    if (!headerMap) {
      // Pierwszy tick tego pliku — dociągnij nagłówek z samego początku.
      const first = await storageGetRange(SB, KEY, `${run.id}/${fileName}`, 0, 8192);
      const headerLine = first.text.split("\n")[0] ?? "";
      headerMap = buildHeaderMap(headerLine);
      offset = headerLine.length + 1; // pomiń nagłówek + jego \n
    }

    // Kilka kawałków w tym samym wywołaniu (patrz MAX_CHUNKS_PER_TICK) — postęp zapisywany
    // do bazy PO KAŻDYM kawałku, więc jeśli któryś kolejny w tej samej pętli zawiedzie
    // (wyjątek łapany przez zewnętrzny catch), wcześniejsze kawałki z tego wywołania i tak
    // zostają policzone, nie trzeba ich powtarzać.
    for (let chunkNum = 0; chunkNum < MAX_CHUNKS_PER_TICK; chunkNum++) {
      if (chunkNum > 0) await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));

      const { text: chunk, totalSize } = await storageGetRange(SB, KEY, `${run.id}/${fileName}`, offset, STOP_TIMES_CHUNK_BYTES);
      const lastNewline = chunk.lastIndexOf("\n");
      const reachedEnd = offset + chunk.length >= totalSize;
      const usableChunk = reachedEnd ? chunk : (lastNewline === -1 ? "" : chunk.slice(0, lastNewline));
      const consumedBytes = usableChunk.length + (reachedEnd ? 0 : 1); // +1 dla samego \n odciętego z usableChunk

      const lines = usableChunk.split("\n");
      const objects = rowsToObjects(fileName, lines, headerMap);
      const cfg = FILE_CONFIG[fileName];
      const targetCols = Object.values(cfg.cols);
      let chunkRows = 0;
      for (let i = 0; i < objects.length; i += INSERT_BATCH) {
        const batch = objects.slice(i, i + INSERT_BATCH);
        if (batch.length) {
          await sql`insert into ${sql(cfg.table)} ${sql(batch, ...targetCols)}`;
          chunkRows += batch.length;
        }
      }
      rowsInserted += chunkRows;
      offset += consumedBytes;

      if (reachedEnd) {
        await sql`update rail_sync_runs set current_file = null, current_offset = 0, current_header = null, consecutive_errors = 0, rows_processed = rows_processed + ${chunkRows} where id = ${run.id}`;
        await finishRun(sql, run.id);
        await sql.end();
        return json({ ok: true, file: fileName, rowsInserted, done: true, chunksThisTick: chunkNum + 1 });
      }

      await sql`update rail_sync_runs set current_offset = ${offset}, current_header = ${JSON.stringify(headerMap)}::jsonb, consecutive_errors = 0, rows_processed = rows_processed + ${chunkRows} where id = ${run.id}`;
    }

    await sql.end();
    return json({ ok: true, file: fileName, rowsInserted, offset, chunksThisTick: MAX_CHUNKS_PER_TICK });
  } catch (e) {
    // Błąd (np. przejściowa blokada Cloudflare/WAF na serię szybkich zapytań Range do
    // Storage) NIE kończy od razu całego syncu — offset/current_file nie są tu ruszane,
    // więc kolejny tick po prostu spróbuje ten sam kawałek jeszcze raz. Dopiero po
    // MAX_CONSECUTIVE_ERRORS pod rząd uznajemy to za faktycznie zepsute, nie przejściowe.
    try {
      await sql`
        update rail_sync_runs
        set consecutive_errors = consecutive_errors + 1,
            error = ${String(e)},
            status = case when consecutive_errors + 1 >= ${MAX_CONSECUTIVE_ERRORS} then 'failed' else status end,
            finished_at = case when consecutive_errors + 1 >= ${MAX_CONSECUTIVE_ERRORS} then now() else finished_at end
        where status = 'running'
      `;
    } catch { /* baza sama niedostępna — nic więcej nie da się tu zrobić */ }
    await sql.end();
    return json({ ok: false, error: String(e) }, 500);
  }
}

// Etap B: transformacja raw -> docelowe + rail_connections + mark-and-sweep, w całości
// jako jedna funkcja Postgres (zob. migracja) — wywołana raz, po ostatnim kawałku
// ostatniego pliku. Zero pracy JS/CPU po stronie Edge Function dla tego kroku.
async function finishRun(sql: ReturnType<typeof getSql>, runId: string): Promise<void> {
  await sql`select rail_gtfs_transform(${runId}::uuid)`;
  await sql`update rail_sync_runs set status = 'success', finished_at = now() where id = ${runId}`;
}

function getSql() {
  const dbUrl = Deno.env.get("RAIL_DB_URL");
  if (!dbUrl) throw new Error("RAIL_DB_URL not set — potrzebny connection string do Transaction poolera Supabase Postgres");
  return postgres(dbUrl, { prepare: false });
}

// Zalogowany admin z panelu (JWT Supabase) sprawdzany tym samym sposobem co
// admin-send-sms — pozwala odpalić sync ręcznie z przycisku w panelu, bez trzymania
// INTERNAL_SECRET po stronie przeglądarki.
async function verifyAdminJwt(token: string): Promise<boolean> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const secret = Deno.env.get("INTERNAL_SECRET");
  const isInternal = !!token && !!secret && token === secret;
  const isAdmin = !!token && !isInternal && (await verifyAdminJwt(token));
  if (!isInternal && !isAdmin) {
    return json({ error: "Unauthorized" }, 401);
  }

  const SB = Deno.env.get("SUPABASE_URL")!;
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* brak body — traktuj jak brak akcji */ }

  if (body.action === "start") return await handleStart(SB, KEY);
  if (body.action === "tick") return await handleTick(SB, KEY);
  return json({ error: "unknown action, expected 'start' or 'tick'" }, 400);
});
