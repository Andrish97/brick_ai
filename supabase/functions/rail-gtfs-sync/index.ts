import postgres from "npm:postgres@3.4.5";
import { ZipReader, Uint8ArrayReader, TextWriter } from "npm:@zip.js/zip.js@2.8.59";

// Synchronizacja lokalnej kopii rozkładu kolejowego z darmowego feedu GTFS
// (https://mkuran.pl/gtfs/polish_trains.zip, zbudowanego z tego samego źródła co
// nasze API PKP PLK — zob. supabase/migrations/20240118000000_rail_gtfs.sql).
//
// Dwie akcje, wywoływane przez pg_cron (nie GitHub Actions — Actions w tym repo jest
// wyłącznie do deployu) albo ręcznie z panelu admina:
//   "start" (raz dziennie) — sprawdza Last-Modified feedu, jeśli zmieniony: pobiera cały
//     zip (skompresowany, bez rozpakowywania) i odkłada go w całości do tabeli
//     rail_sync_blobs, zakłada nowy wiersz rail_sync_runs.
//   "tick" — wznawia pracę od miejsca zapisanego w rail_sync_runs (current_file/
//     current_offset). Dla każdego pliku GTFS pierwszy tick go rozpakowuje z _source.zip
//     (jeden plik na jedno wywołanie — zob. extractOneFile), kolejne go parsują: małe
//     pliki (stops/routes/calendar/calendar_dates/trips) w całości w jednym ticku,
//     stop_times.txt (jedyny spodziewany duży plik) w ograniczonych kawałkach bajtowych
//     czytanych z rail_sync_blobs, kilka kawałków na tick (zob. MAX_CHUNKS_PER_TICK). Po
//     ostatnim kawałku ostatniego pliku: wywołuje Etap B (czysty SQL, funkcja
//     rail_gtfs_transform w bazie — patrz migracja) i "mark and sweep" starych wierszy.
//
// Plik między krokami trzymany jest wprost w Postgresie (tabela rail_sync_blobs), nie w
// Supabase Storage — Storage okazało się mieć realną, powtarzalną niespójność odczytu-
// -tuż-po-zapisie; zwykłe zapytanie SQL do tej samej bazy, z którą ta funkcja i tak już
// rozmawia do wszystkich innych operacji, tej klasy problemów strukturalnie nie ma.
//
// Powód dzielenia pracy na małe kroki w ogóle: twardy limit 2s czasu CPU na jedno
// wywołanie Supabase Edge Function — nie da się tego obejść, tylko obejść PRACĄ, robiąc
// mało na raz. Rozpakowanie WSZYSTKICH plików naraz albo sparsowanie całego stop_times.txt
// (kilkadziesiąt MB) w jednym wywołaniu przekracza ten limit.
//
// Kto woła: pg_cron (nagłówek Authorization z INTERNAL_SECRET z Vault) albo zalogowany
// admin z panelu (JWT Supabase). Rozróżnienie tego (isAutomatic w Deno.serve niżej) steruje
// WYŁĄCZNIE tym, czy przebieg zostawia ślad w ogólnej tabeli `logs` (zakładka "Logi" w
// panelu) — cron nie ma nikogo "przed ekranem", więc to jedyny sposób sprawdzenia po
// fakcie, czy się odbył i jak poszedł. Kliknięcia z panelu mają już własny, żywy podgląd
// postępu w tej samej karcie (percent + checklist plików), więc dublowanie ich w Logi
// byłoby czystym szumem.

const FEED_URL = "https://mkuran.pl/gtfs/polish_trains.zip";
const SOURCE_ZIP = "_source.zip";
// Zip pobierany kawałkami przez Range, tak jak stop_times.txt jest CZYTANY kawałkami —
// zob. komentarz przy downloadOneChunk.
const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const SMALL_FILES = ["stops.txt", "routes.txt", "calendar.txt", "calendar_dates.txt", "trips.txt"];
const BIG_FILE = "stop_times.txt";
const ALL_FILES = [...SMALL_FILES, BIG_FILE];
// 8MB na tick — realny test pokazał, że 4MB (~53k wierszy) mieści się w limicie 2s CPU
// z zapasem.
const STOP_TIMES_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CONSECUTIVE_ERRORS = 5; // po tylu kolejnych nieudanych tickach pod rząd dopiero uznajemy sync za faktycznie zepsuty
// Kilka kawałków w JEDNYM ticku zamiast jednego — realnie przyspiesza cały sync. 3 kawałki
// x 8MB to bezpieczny margines pod limit 2s CPU.
const MAX_CHUNKS_PER_TICK = 3;
const INSERT_BATCH = 2000; // wierszy na jedno zapytanie bulk-insert

// Mapowanie: nazwa pliku GTFS -> {tabela raw, mapowanie kolumna GTFS -> kolumna raw}.
// Tylko pola faktycznie potrzebne CSA i istniejącym formatterom — reszta kolumn GTFS jest
// ignorowana, jeśli w ogóle obecna w danym eksporcie.
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

function indexOfByte(bytes: Uint8Array, byte: number): number {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === byte) return i;
  return -1;
}

function lastIndexOfByte(bytes: Uint8Array, byte: number): number {
  for (let i = bytes.length - 1; i >= 0; i--) if (bytes[i] === byte) return i;
  return -1;
}

const NEWLINE = 0x0a;

// --- Blob-y pomiędzy krokami syncu — w Postgresie (rail_sync_blobs), nie w Storage ---

type SqlClient = ReturnType<typeof getSql>;

async function putBlob(sql: SqlClient, runId: string, fileName: string, content: Uint8Array): Promise<void> {
  await sql`
    insert into rail_sync_blobs (run_id, file_name, content)
    values (${runId}, ${fileName}, ${content})
    on conflict (run_id, file_name) do update set content = excluded.content
  `;
}

const BLOB_WRITE_CHUNK_BYTES = 4 * 1024 * 1024;

// Realny błąd na produkcji: zapis skompresowanego zipa (kilkanaście MB) jako JEDNEGO
// parametru bytea wysadził WORKER_RESOURCE_LIMIT w "start" — sterownik najwyraźniej
// koduje duże wartości bytea po stronie klienta (Edge Function) w sposób, który
// wielokrotnie zwiększa realne zużycie pamięci względem samego rozmiaru pliku. Duże
// wartości (ten zip, i rozpakowane stop_times.txt — jeszcze większe) idą teraz w kilku
// mniejszych zapytaniach do tymczasowych wierszy, sklejanych NA KOŃCU PO STRONIE
// POSTGRESA (string_agg, bez przesyłania danych z powrotem do klienta) w jeden docelowy
// wiersz — dzięki temu getBlobFull/getBlobRange (odczyt) nie muszą wiedzieć, że zapis w
// ogóle był dzielony; zweryfikowane lokalnie, że string_agg na bytea skleja bajt-w-bajt
// poprawnie. Małe pliki (poniżej progu) idą jednym zapytaniem jak dotychczas.
async function putBlobLarge(sql: SqlClient, runId: string, fileName: string, content: Uint8Array): Promise<void> {
  if (content.length <= BLOB_WRITE_CHUNK_BYTES) {
    await putBlob(sql, runId, fileName, content);
    return;
  }
  const tmpPrefix = `~chunk~${fileName}~`; // "~" nie pojawia się w prawdziwych nazwach plików GTFS
  await sql`delete from rail_sync_blobs where run_id = ${runId} and file_name like ${tmpPrefix + "%"}`;
  let i = 0;
  for (let offset = 0; offset < content.length; offset += BLOB_WRITE_CHUNK_BYTES, i++) {
    const piece = content.subarray(offset, offset + BLOB_WRITE_CHUNK_BYTES);
    await putBlob(sql, runId, `${tmpPrefix}${String(i).padStart(5, "0")}`, piece);
  }
  await reassembleChunks(sql, runId, fileName, tmpPrefix);
}

async function reassembleChunks(sql: SqlClient, runId: string, fileName: string, tmpPrefix: string): Promise<void> {
  await sql`
    insert into rail_sync_blobs (run_id, file_name, content)
    select ${runId}, ${fileName}, string_agg(content, ''::bytea order by file_name)
    from rail_sync_blobs where run_id = ${runId} and file_name like ${tmpPrefix + "%"}
    on conflict (run_id, file_name) do update set content = excluded.content
  `;
  await sql`delete from rail_sync_blobs where run_id = ${runId} and file_name like ${tmpPrefix + "%"}`;
}

// Realny dowód na produkcji (Supabase Dashboard, wykres pamięci): pojedyncze wywołanie
// "start" osiągnęło szczytowe zużycie pamięci ~260MB w kilka sekund — MIMO że kod już
// wtedy czytał odpowiedź HTTP przez ReadableStream.getReader() zamiast .arrayBuffer().
// Wniosek: fetch() w tym środowisku najwyraźniej buforuje całą odpowiedź po swojej
// stronie niezależnie od tego, jak strumień jest potem konsumowany — samo API
// ReadableStream nie daje żadnej gwarancji ograniczenia pamięci, jeśli klient HTTP pod
// spodem i tak ściąga całość naraz. Jedyny sposób, żeby NAPRAWDĘ ograniczyć rozmiar
// pojedynczego pobrania, to ograniczyć go PO STRONIE SERWERA przez nagłówek Range —
// dokładnie ten sam mechanizm, którym stop_times.txt jest już CZYTANY kawałkami z
// rail_sync_blobs (getBlobRange). Pobieranie zipa jest więc teraz też rozłożone na ticki:
// jeden Range na jedno wywołanie, offset trzymany w current_offset (current_file =
// SOURCE_ZIP), tak samo jak każdy inny krok tego syncu.
async function downloadOneChunk(sql: SqlClient, runId: string, offset: number, knownTotalBytes: number | null): Promise<{ done: boolean; totalBytes: number | null; newOffset: number }> {
  const rangeEnd = offset + DOWNLOAD_CHUNK_BYTES - 1;
  const res = await fetch(FEED_URL, { headers: { Range: `bytes=${offset}-${rangeEnd}` } });
  if (res.status !== 206) {
    throw new Error(`range_not_supported: serwer feedu zwrócił HTTP ${res.status} zamiast 206 Partial Content dla Range bytes=${offset}-${rangeEnd}`);
  }
  const contentRange = res.headers.get("content-range"); // format: "bytes X-Y/TOTAL"
  const totalFromHeader = contentRange ? parseInt(contentRange.split("/")[1] ?? "", 10) : NaN;
  const totalBytes = Number.isFinite(totalFromHeader) ? totalFromHeader : knownTotalBytes;

  const buf = new Uint8Array(await res.arrayBuffer());
  const tmpPrefix = `~chunk~${SOURCE_ZIP}~`;
  const chunkIndex = Math.floor(offset / DOWNLOAD_CHUNK_BYTES);
  await putBlob(sql, runId, `${tmpPrefix}${String(chunkIndex).padStart(6, "0")}`, buf);

  const newOffset = offset + buf.length;
  const done = totalBytes !== null ? newOffset >= totalBytes : buf.length < DOWNLOAD_CHUNK_BYTES;
  if (done) {
    await reassembleChunks(sql, runId, SOURCE_ZIP, tmpPrefix);
    await sql`update rail_sync_runs set current_file = ${SMALL_FILES[0]}, current_offset = -1, current_total_bytes = null, consecutive_errors = 0 where id = ${runId}`;
  } else {
    await sql`update rail_sync_runs set current_offset = ${newOffset}, current_total_bytes = ${totalBytes}, consecutive_errors = 0 where id = ${runId}`;
  }
  return { done, totalBytes, newOffset };
}

async function getBlobFull(sql: SqlClient, runId: string, fileName: string): Promise<Uint8Array | null> {
  const [row] = await sql<{ content: Uint8Array }[]>`
    select content from rail_sync_blobs where run_id = ${runId} and file_name = ${fileName}
  `;
  return row ? row.content : null;
}

// Fragment [start, start+len) w bajtach oraz całkowity rozmiar obiektu — substring na
// bytea jest 1-indeksowane i tnie po BAJTACH (nie znakach), zweryfikowane lokalnie na
// prawdziwym Postgresie razem z przecięciem wielobajtowego znaku UTF-8 w środku zakresu.
async function getBlobRange(sql: SqlClient, runId: string, fileName: string, start: number, len: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
  const [row] = await sql<{ chunk: Uint8Array; total: number }[]>`
    select substring(content from ${start + 1} for ${len}) as chunk, octet_length(content) as total
    from rail_sync_blobs where run_id = ${runId} and file_name = ${fileName}
  `;
  return row ? { bytes: row.chunk, totalSize: row.total } : null;
}

// Realny dowód z logów Supabase: kilka nakładających się wywołań tej funkcji potrafi
// zacząć jednocześnie pisać do tych samych wierszy rail_sync_blobs, wpadając w kolejkę
// na blokadzie wiersza — każde czeka na poprzednie, a kolejne wywołania klienta (co
// 500ms) dokładają się do rosnącej kolejki, aż suma zasobów przekroczy limit pamięci.
// Zwykła tabela zamiast pg_try_advisory_lock — RAIL_DB_URL idzie przez Transaction
// Pooler, gdzie blokady sesyjne nie są bezpieczne.
const WORKER_LOCK_HOLD_SECONDS = 60;

async function tryAcquireWorkerLock(sql: SqlClient): Promise<boolean> {
  const [row] = await sql<{ id: boolean }[]>`
    update rail_sync_worker_lock
    set locked_until = now() + (${WORKER_LOCK_HOLD_SECONDS} || ' seconds')::interval
    where id = true and (locked_until is null or locked_until < now())
    returning id
  `;
  return !!row;
}

async function releaseWorkerLock(sql: SqlClient): Promise<void> {
  await sql`update rail_sync_worker_lock set locked_until = null where id = true`.catch(() => {});
}

// Jedyny log tego mechanizmu, i tylko dla przebiegów automatycznych — zob. komentarz na
// górze pliku. Jeden typ w tabeli `logs` ("rail_sync"), rozróżniany polem data.event.
async function logRailSync(sql: SqlClient, event: "started" | "finished" | "failed", data: Record<string, unknown>): Promise<void> {
  try {
    // sql.json(...), NIE ręczny JSON.stringify(...)::jsonb — ten drugi podwójnie koduje
    // wynik (jsonb string opakowujący cały tekst JSON zamiast właściwego obiektu),
    // złapane lokalnym testem przed wdrożeniem.
    await sql`insert into logs (type, data) values ('rail_sync', ${sql.json({ event, ...data })})`;
  } catch { /* logowanie nie może wywrócić samego syncu */ }
}

// --- Etap A: "start" — pobierz surowy zip (bez rozpakowywania!) i odłóż do bazy ---
async function handleStart(isAutomatic: boolean): Promise<Response> {
  const sql = getSql();
  // Blokada zaraz na wstępie, przed jakąkolwiek prawdziwą pracą — ścieżka "busy" ma
  // zostać tania (jedno zapytanie), żeby nakładające się wywołania NIE dokładały się do
  // kolejki na blokadach wierszy w rail_sync_blobs (zob. komentarz przy tryAcquireWorkerLock).
  if (!(await tryAcquireWorkerLock(sql))) {
    await sql.end();
    return json({ ok: true, skipped: "busy" });
  }
  try {
    const headRes = await fetch(FEED_URL, { method: "HEAD" });
    const lastModifiedHeader = headRes.headers.get("last-modified");
    const feedLastModified = lastModifiedHeader ? new Date(lastModifiedHeader) : null;
    const contentLengthHeader = headRes.headers.get("content-length");
    const feedTotalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;

    const [lastSuccess] = await sql<{ feed_last_modified: string | null }[]>`
      select feed_last_modified from rail_sync_runs
      where status = 'success'
      order by finished_at desc nulls last limit 1
    `;
    if (feedLastModified && lastSuccess?.feed_last_modified && new Date(lastSuccess.feed_last_modified).getTime() === feedLastModified.getTime()) {
      return json({ ok: true, skipped: "unchanged" });
    }

    // WORKER_RESOURCE_LIMIT potrafi ubić wywołanie tak brutalnie, że nie zdąży nawet
    // wykonać własnego catch-bloku (status zostaje 'running' na zawsze) — bez tego
    // sprawdzenia taki porzucony bieg blokowałby każdy kolejny "start" w nieskończoność.
    // Sprawdzamy WSZYSTKIE wiersze 'running' (mogło ich się uzbierać kilka z kolejnych
    // nieudanych prób), nie tylko pierwszy z brzegu.
    const runningRows = await sql<{ id: string; started_at: string }[]>`select id, started_at from rail_sync_runs where status = 'running' order by started_at desc`;
    if (runningRows.length) {
      const freshest = runningRows[0];
      const ageMs = Date.now() - new Date(freshest.started_at).getTime();
      // Normalny pełny przebieg mieści się dużo poniżej godziny, więc jeśli nawet
      // najświeższy 'running' jest starszy — wszystkie są porzucone.
      if (ageMs < 60 * 60 * 1000) {
        return json({ ok: true, skipped: "already_running" });
      }
      await sql`update rail_sync_runs set status = 'failed', finished_at = now(), error = 'stale_abandoned_run' where status = 'running'`;
    }

    // Czyste raw tabele przed nowym syncem — na wypadek, gdyby poprzedni sync zawiódł
    // w trakcie i zostawił częściowe wiersze (rail_gtfs_transform też to robi na końcu,
    // ale tylko przy pełnym sukcesie).
    await sql`truncate rail_raw_stops, rail_raw_routes, rail_raw_calendar, rail_raw_calendar_dates, rail_raw_trips, rail_raw_stop_times`;

    // "start" już NIE pobiera zipa samo — tylko zakłada wiersz biegu z current_file =
    // SOURCE_ZIP. Samo pobieranie jest teraz krok-po-kroku przez "tick" (zob.
    // downloadOneChunk) dokładnie tym samym mechanizmem co reszta syncu.
    const [run] = await sql<{ id: string }[]>`
      insert into rail_sync_runs (status, current_file, current_offset, current_total_bytes, feed_last_modified)
      values ('running', ${SOURCE_ZIP}, 0, ${feedTotalBytes}, ${feedLastModified ? feedLastModified.toISOString() : null})
      returning id
    `;
    // Blob-y po starych/nieudanych biegach nie są już potrzebne.
    await sql`delete from rail_sync_blobs where run_id <> ${run.id}`;

    if (isAutomatic) await logRailSync(sql, "started", { runId: run.id, feedTotalBytes });
    return json({ ok: true, runId: run.id, feedLastModified: feedLastModified?.toISOString() ?? null, feedTotalBytes });
  } catch (e) {
    if (isAutomatic) await logRailSync(sql, "failed", { stage: "start", error: String(e) });
    await sql`update rail_sync_runs set status = 'failed', finished_at = now(), error = ${String(e)} where status = 'running'`.catch(() => {});
    return json({ ok: false, error: String(e) }, 500);
  } finally {
    await releaseWorkerLock(sql);
    await sql.end();
  }
}

// Rozpakowuje JEDEN plik GTFS z odłożonego _source.zip i wgrywa go do rail_sync_blobs —
// wywoływane raz na tick, zanim ten plik może zostać sparsowany. extracted=false, jeśli
// pliku nie ma w zipie (dozwolone przez spec dla wszystkich poza stop_times.txt).
// totalSize pozwala panelowi admina policzyć procent postępu bieżącego pliku
// (current_offset / totalSize) — najważniejsze dla stop_times.txt, jedynego pliku na
// tyle dużego, żeby to miało sens wizualnie.
async function extractOneFile(sql: SqlClient, runId: string, fileName: string): Promise<{ extracted: boolean; totalSize: number }> {
  const zipBytes = await getBlobFull(sql, runId, SOURCE_ZIP);
  if (!zipBytes) throw new Error(`source_zip_missing run=${runId}`);
  const reader = new ZipReader(new Uint8ArrayReader(zipBytes));
  try {
    const entries = await reader.getEntries();
    const entry = entries.find((e) => e.filename === fileName || e.filename.endsWith(`/${fileName}`));
    if (!entry || entry.directory) {
      if (fileName === BIG_FILE) throw new Error(`gtfs_file_missing_in_zip: ${fileName}`);
      return { extracted: false, totalSize: 0 };
    }
    const text = await entry.getData(new TextWriter());
    const bytes = new TextEncoder().encode(text);
    await putBlobLarge(sql, runId, fileName, bytes);
    return { extracted: true, totalSize: bytes.length };
  } finally {
    await reader.close();
  }
}

// --- Etap A (ciąg dalszy) + Etap B: "tick" — jeden krok postępu, zawsze bezpieczny do przerwania ---

async function handleTick(isAutomatic: boolean): Promise<Response> {
  const sql = getSql();
  if (!(await tryAcquireWorkerLock(sql))) {
    await sql.end();
    return json({ ok: true, skipped: "busy" });
  }
  try {
    const [run] = await sql<{
      id: string; current_file: string | null; current_offset: number; current_header: unknown; current_total_bytes: number | null;
    }[]>`select id, current_file, current_offset, current_header, current_total_bytes from rail_sync_runs where status = 'running' order by started_at asc limit 1`;
    if (!run) { return json({ ok: true, skipped: "nothing_running" }); }
    if (!run.current_file) { return json({ ok: true, skipped: "no_current_file" }); }

    // current_file === SOURCE_ZIP: sam zip jeszcze się pobiera, kawałek po kawałku przez
    // Range (zob. downloadOneChunk) — dopiero po zakończeniu current_file przechodzi na
    // pierwszy plik GTFS i reszta tej funkcji (rozpakowywanie/parsowanie) rusza normalnie.
    if (run.current_file === SOURCE_ZIP) {
      const { done, totalBytes, newOffset } = await downloadOneChunk(sql, run.id, run.current_offset, run.current_total_bytes);
      // UWAGA: "done" tutaj oznacza tylko "ten kawałek pobierania zipa skończony", NIE
      // "cały sync skończony" — celowo NIE nazwane "done" w odpowiedzi, bo panel
      // (syncNow() w admin/index.html) przerywa pętlę ticków, gdy lastTick?.done jest
      // prawdziwe, licząc na to, że to oznacza koniec CAŁEGO syncu (tak jak przy ostatnim
      // kawałku stop_times.txt).
      return json({ ok: true, downloading: true, offset: newOffset, totalBytes, downloadDone: done });
    }

    const fileName = run.current_file;
    let rowsInserted = 0;

    // current_offset === -1: ten plik jeszcze nie został rozpakowany z _source.zip —
    // zrób to teraz, jako CAŁE to wywołanie (parsowanie zaczyna się dopiero od
    // następnego ticku) — trzyma dekompresję jednego pliku w osobnym, lekkim wywołaniu,
    // zamiast robić to dla wszystkich 6 plików naraz.
    if (run.current_offset === -1) {
      const { extracted, totalSize } = await extractOneFile(sql, run.id, fileName);
      // -2: potwierdzone PRZY EKSTRAKCJI, że pliku nie było w zipie (dozwolone przez spec
      // GTFS dla wszystkiego poza stop_times.txt). Odróżnione od 0 ("wyodrębniony,
      // gotowy do parsowania").
      const nextOffset = extracted ? 0 : -2;
      await sql`update rail_sync_runs set current_offset = ${nextOffset}, current_total_bytes = ${extracted ? totalSize : null}, consecutive_errors = 0 where id = ${run.id}`;
      return json({ ok: true, extracted: extracted ? fileName : null, skipped: extracted ? undefined : "not_in_feed" });
    }

    if (SMALL_FILES.includes(fileName)) {
      let text = "";
      if (run.current_offset !== -2) {
        const blob = await getBlobFull(sql, run.id, fileName);
        text = blob ? new TextDecoder().decode(blob) : "";
      }
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
      if (!nextFile) await finishRun(sql, run.id, isAutomatic);
      return json({ ok: true, file: fileName, rowsInserted, nextFile });
    }

    // fileName === BIG_FILE (stop_times.txt) — kawałkami po STOP_TIMES_CHUNK_BYTES bajtów.
    let headerMap = run.current_header as Record<string, number> | null;
    let offset = run.current_offset;
    if (!headerMap) {
      // Pierwszy tick tego pliku — dociągnij nagłówek z samego początku.
      const first = await getBlobRange(sql, run.id, fileName, 0, 8192);
      if (!first) throw new Error(`blob_missing ${fileName} run=${run.id}`);
      const nlIdx = indexOfByte(first.bytes, NEWLINE);
      const headerLineBytes = nlIdx === -1 ? first.bytes : first.bytes.slice(0, nlIdx);
      headerMap = buildHeaderMap(new TextDecoder().decode(headerLineBytes));
      offset = nlIdx === -1 ? first.bytes.length : nlIdx + 1; // bajt tuż po nagłówku + jego \n
    }

    // Kilka kawałków w tym samym wywołaniu (patrz MAX_CHUNKS_PER_TICK) — postęp zapisywany
    // do bazy PO KAŻDYM kawałku, więc jeśli któryś kolejny w tej samej pętli zawiedzie
    // (wyjątek łapany przez zewnętrzny catch), wcześniejsze kawałki z tego wywołania i tak
    // zostają policzone, nie trzeba ich powtarzać.
    for (let chunkNum = 0; chunkNum < MAX_CHUNKS_PER_TICK; chunkNum++) {
      const range = await getBlobRange(sql, run.id, fileName, offset, STOP_TIMES_CHUNK_BYTES);
      if (!range) throw new Error(`blob_missing ${fileName} run=${run.id}`);
      const { bytes: chunkBytes, totalSize } = range;
      const reachedEnd = offset + chunkBytes.length >= totalSize;
      const lastNl = lastIndexOfByte(chunkBytes, NEWLINE);
      const usableBytes = reachedEnd ? chunkBytes : (lastNl === -1 ? new Uint8Array(0) : chunkBytes.slice(0, lastNl));
      const consumedBytes = usableBytes.length + (reachedEnd ? 0 : 1); // +1 dla samego \n odciętego z usableBytes
      const usableChunk = new TextDecoder().decode(usableBytes);

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
        await finishRun(sql, run.id, isAutomatic);
        return json({ ok: true, file: fileName, rowsInserted, done: true, chunksThisTick: chunkNum + 1 });
      }

      // sql.json(...), NIE ręczny JSON.stringify(...)::jsonb — ten drugi podwójnie koduje
      // (zob. logRailSync powyżej); z ręcznym rzutowaniem headerMap wracał z bazy jako
      // string zamiast obiektu na każdym kolejnym ticku tego pliku po pierwszym.
      await sql`update rail_sync_runs set current_offset = ${offset}, current_header = ${sql.json(headerMap)}, consecutive_errors = 0, rows_processed = rows_processed + ${chunkRows} where id = ${run.id}`;
    }

    return json({ ok: true, file: fileName, rowsInserted, offset, chunksThisTick: MAX_CHUNKS_PER_TICK });
  } catch (e) {
    // Błąd NIE kończy od razu całego syncu — offset/current_file nie są tu ruszane, więc
    // kolejny tick po prostu spróbuje ten sam kawałek jeszcze raz. Dopiero po
    // MAX_CONSECUTIVE_ERRORS pod rząd uznajemy to za faktycznie zepsute, nie przejściowe.
    // RETURNING mówi od razu, czy TA aktualizacja przekroczyła próg — bez osobnego
    // zapytania sprawdzającego z góry.
    try {
      const [updated] = await sql<{ status: string }[]>`
        update rail_sync_runs
        set consecutive_errors = consecutive_errors + 1,
            error = ${String(e)},
            status = case when consecutive_errors + 1 >= ${MAX_CONSECUTIVE_ERRORS} then 'failed' else status end,
            finished_at = case when consecutive_errors + 1 >= ${MAX_CONSECUTIVE_ERRORS} then now() else finished_at end
        where status = 'running'
        returning status
      `;
      if (isAutomatic && updated?.status === "failed") await logRailSync(sql, "failed", { stage: "tick", error: String(e) });
    } catch { /* baza sama niedostępna — nic więcej nie da się tu zrobić */ }
    return json({ ok: false, error: String(e) }, 500);
  } finally {
    await releaseWorkerLock(sql);
    await sql.end();
  }
}

// Etap B: transformacja raw -> docelowe + rail_connections + mark-and-sweep, w całości
// jako jedna funkcja Postgres (zob. migracja) — wywołana raz, po ostatnim kawałku
// ostatniego pliku. Zero pracy JS/CPU po stronie Edge Function dla tego kroku.
async function finishRun(sql: SqlClient, runId: string, isAutomatic: boolean): Promise<void> {
  await sql`select rail_gtfs_transform(${runId}::uuid)`;
  await sql`update rail_sync_runs set status = 'success', finished_at = now() where id = ${runId}`;
  if (isAutomatic) {
    const [row] = await sql<{ rows_processed: number }[]>`select rows_processed from rail_sync_runs where id = ${runId}`;
    await logRailSync(sql, "finished", { runId, rowsProcessed: row?.rows_processed ?? null });
  }
}

function getSql() {
  const dbUrl = Deno.env.get("RAIL_DB_URL");
  if (!dbUrl) throw new Error("RAIL_DB_URL not set — potrzebny connection string do Transaction poolera Supabase Postgres");
  // max: 1 — bez tego postgres.js otwiera pulę do 10 połączeń na KAŻDE wywołanie, mimo że
  // ten kod i tak zawsze wykonuje jedno zapytanie na raz, sekwencyjnie (nigdy Promise.all).
  // Każde wywołanie ubite przez WORKER_RESOURCE_LIMIT (a było ich w tej sesji sporo) nigdy
  // nie dochodzi do własnego sql.end() — zostawia otwarte połączenia na Transaction
  // Poolerze aż do ich idle-timeoutu. Przy puli do 10 na crash to realne ryzyko wyczerpania
  // limitu połączeń poolera, co mogłoby tłumaczyć crash nawet na taniej ścieżce ("busy"/
  // "already_running"), zanim doszłoby do jakiejkolwiek cięższej pracy.
  return postgres(dbUrl, { prepare: false, max: 1 });
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

  // isInternal = wywołane przez pg_cron (bez kogoś "przed ekranem") = warte logowania w
  // panelu; isAdmin = kliknięcie w panelu, gdzie postęp jest już widoczny na żywo.
  const isAutomatic = isInternal;

  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* brak body — traktuj jak brak akcji */ }

  if (body.action === "start") return await handleStart(isAutomatic);
  if (body.action === "tick") return await handleTick(isAutomatic);
  return json({ error: "unknown action, expected 'start' or 'tick'" }, 400);
});
