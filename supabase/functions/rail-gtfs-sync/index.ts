import postgres from "npm:postgres@3.4.5";
import { ZipReader, Uint8ArrayReader, TextWriter } from "npm:@zip.js/zip.js@2.8.59";

// Synchronizacja lokalnej kopii rozkładu kolejowego z darmowego feedu GTFS
// (https://mkuran.pl/gtfs/polish_trains.zip, zbudowanego z tego samego źródła co
// nasze API PKP PLK — zob. supabase/migrations/20240118000000_rail_gtfs.sql).
//
// Dwie akcje, wywoływane przez pg_cron (nie GitHub Actions — Actions w tym repo jest
// wyłącznie do deployu):
//   "start" (raz dziennie) — sprawdza Last-Modified feedu, jeśli zmieniony: pobiera cały
//     zip, rozpakowuje potrzebne pliki GTFS do zwykłego tekstu i wgrywa do Supabase
//     Storage (bucket rail-gtfs-raw), zakłada nowy wiersz rail_sync_runs.
//   "tick" (co 2 minuty) — wznawia parsowanie+wstawianie od miejsca zapisanego w
//     rail_sync_runs (current_file/current_offset). Małe pliki (stops/routes/calendar/
//     calendar_dates/trips) przetwarzane w całości w jednym ticku; stop_times.txt
//     (jedyny spodziewany duży plik) w ograniczonych kawałkach bajtowych czytanych z
//     Storage przez Range request, żeby nigdy nie trzymać całego pliku w pamięci na raz.
//     Po ostatnim kawałku ostatniego pliku: wywołuje Etap B (czysty SQL, funkcja
//     rail_gtfs_transform w bazie — patrz migracja) i "mark and sweep" starych wierszy.
//
// UWAGA: kod nigdy nie był uruchomiony na żywo — sandbox, w którym powstał, nie ma
// dostępu ani do mkuran.pl, ani do samego Supabase. Napisany maksymalnie defensywnie
// (try/catch na każdym kroku, jasne komunikaty błędu w rail_sync_runs.error), ale
// pierwsze realne uruchomienie prawdopodobnie ujawni coś do poprawki — to oczekiwane,
// nie oznaka złej roboty. Diagnozować z rail_sync_runs.error i logów funkcji.

const FEED_URL = "https://mkuran.pl/gtfs/polish_trains.zip";
const BUCKET = "rail-gtfs-raw";
const SMALL_FILES = ["stops.txt", "routes.txt", "calendar.txt", "calendar_dates.txt", "trips.txt"];
const BIG_FILE = "stop_times.txt";
const ALL_FILES = [...SMALL_FILES, BIG_FILE];
const STOP_TIMES_CHUNK_BYTES = 4 * 1024 * 1024; // 4MB na tick — bezpieczny margines pod limit CPU 2s Edge Function
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
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

async function storagePutText(SB: string, KEY: string, path: string, content: string): Promise<void> {
  const res = await fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: sbHeaders(KEY, { "Content-Type": "text/plain", "x-upsert": "true" }),
    body: content,
  });
  if (!res.ok) throw new Error(`storage_put_failed ${path}: HTTP ${res.status} ${await res.text()}`);
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

// --- Etap A: "start" — pobierz zip, rozpakuj potrzebne pliki, wgraj do Storage ---

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

    const [alreadyRunning] = await sql<{ id: string }[]>`select id from rail_sync_runs where status = 'running' limit 1`;
    if (alreadyRunning) {
      await sql.end();
      return json({ ok: true, skipped: "already_running" });
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
      values ('running', ${SMALL_FILES[0]}, 0, ${feedLastModified ? feedLastModified.toISOString() : null})
      returning id
    `;

    const reader = new ZipReader(new Uint8ArrayReader(zipBytes));
    const entries = await reader.getEntries();
    for (const fileName of ALL_FILES) {
      const entry = entries.find((e) => e.filename === fileName || e.filename.endsWith(`/${fileName}`));
      if (!entry || entry.directory) throw new Error(`gtfs_file_missing_in_zip: ${fileName}`);
      const text = await entry.getData(new TextWriter());
      await storagePutText(SB, KEY, `${run.id}/${fileName}`, text);
    }
    await reader.close();

    await sql.end();
    return json({ ok: true, runId: run.id, feedLastModified: feedLastModified?.toISOString() ?? null });
  } catch (e) {
    await sql`update rail_sync_runs set status = 'failed', finished_at = now(), error = ${String(e)} where status = 'running'`.catch(() => {});
    await sql.end();
    return json({ ok: false, error: String(e) }, 500);
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

    if (SMALL_FILES.includes(fileName)) {
      const { text } = await storageGetRange(SB, KEY, `${run.id}/${fileName}`, 0, 200 * 1024 * 1024);
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
      await sql`update rail_sync_runs set current_file = ${nextFile}, current_offset = 0, current_header = null, rows_processed = rows_processed + ${rowsInserted} where id = ${run.id}`;
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

    const { text: chunk, totalSize } = await storageGetRange(SB, KEY, `${run.id}/${fileName}`, offset, STOP_TIMES_CHUNK_BYTES);
    const lastNewline = chunk.lastIndexOf("\n");
    const reachedEnd = offset + chunk.length >= totalSize;
    const usableChunk = reachedEnd ? chunk : (lastNewline === -1 ? "" : chunk.slice(0, lastNewline));
    const consumedBytes = usableChunk.length + (reachedEnd ? 0 : 1); // +1 dla samego \n odciętego z usableChunk

    const lines = usableChunk.split("\n");
    const objects = rowsToObjects(fileName, lines, headerMap);
    const cfg = FILE_CONFIG[fileName];
    const targetCols = Object.values(cfg.cols);
    for (let i = 0; i < objects.length; i += INSERT_BATCH) {
      const batch = objects.slice(i, i + INSERT_BATCH);
      if (batch.length) {
        await sql`insert into ${sql(cfg.table)} ${sql(batch, ...targetCols)}`;
        rowsInserted += batch.length;
      }
    }

    const newOffset = offset + consumedBytes;
    if (reachedEnd) {
      await sql`update rail_sync_runs set current_file = null, current_offset = 0, current_header = null, rows_processed = rows_processed + ${rowsInserted} where id = ${run.id}`;
      await finishRun(sql, run.id);
      await sql.end();
      return json({ ok: true, file: fileName, rowsInserted, done: true });
    }

    await sql`update rail_sync_runs set current_offset = ${newOffset}, current_header = ${JSON.stringify(headerMap)}::jsonb, rows_processed = rows_processed + ${rowsInserted} where id = ${run.id}`;
    await sql.end();
    return json({ ok: true, file: fileName, rowsInserted, offset: newOffset, totalSize });
  } catch (e) {
    await sql`update rail_sync_runs set status = 'failed', finished_at = now(), error = ${String(e)} where status = 'running'`.catch(() => {});
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

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("INTERNAL_SECRET");
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
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
