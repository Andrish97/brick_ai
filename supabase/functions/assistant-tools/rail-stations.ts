// Rozpoznawanie stacji z lokalnego GTFS i sprawdzanie świeżości synchronizacji.
// Właściwy planer znajduje się w rail-route-search.ts / rail-router.js.

type RailStation = { id: string; name: string; lat: number | string | null; lon: number | string | null };
// Jedna stacja może obejmować kilka peronów / stop_id z tą samą nazwą.
type RailStationGroup = { name: string; ids: string[]; lat: number | null; lon: number | null };

async function sbGet<T>(url: string, key: string, path: string): Promise<T[]> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`rail_db_get_failed ${path}: HTTP ${res.status}`);
  return res.json();
}

// RPC (POST) zamiast GET z filtrem w URL — realny błąd na produkcji: lista aktywnych
// service_id danego dnia (setki UUID-ów) w URL-owym filtrze "in.(...)" tworzyła zapytanie
// rzędu ~20KB, co zawodziło (potwierdzone diagnostyką: pierwsze zapytanie o rail_connections
// zawsze rzucało wyjątek, zero okien kiedykolwiek zeskanowanych). Ciało zapytania POST nie
// ma tego ograniczenia.
async function sbRpc<T>(url: string, key: string, fn: string, args: Record<string, unknown>): Promise<T[]> {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rail_db_rpc_failed ${fn}: HTTP ${res.status}`);
  return res.json();
}

// Ta sama odpowiedź co dawne StationLookup, plus informacja diagnostyczna JAK stacja została
// rozstrzygnięta — pomocne w logach (zob. rail_local_entry/skip w index.ts) przy
// weryfikacji, czy AI faktycznie trafia w "Katowice Główny", czy ląduje w bezpieczniku.
export type SmartStationLookup =
  | { ok: true; station: RailStationGroup; resolvedVia: "single_candidate" | "ai" | "ai_fallback_connectivity"; aiRawPick?: string | null }
  | { ok: false; body: Record<string, unknown> };

// Jedno, lekkie wywołanie Gemini (bez narzędzi, sam tekst) do wyboru "sensownej" stacji
// spośród kilku kandydatek o TEJ SAMEJ nazwie-podciągu — celowo osobne od głównej pętli
// rozmowy w zadarma-sms-webhook (ten plik jest samodzielny, zob. komentarz na górze).
async function askGeminiForStationPick(geminiKey: string, query: string, candidateNames: string[]): Promise<string | null> {
  const prompt = `Użytkownik szuka stacji kolejowej w Polsce: "${query}".
Kandydaci (dokładne nazwy stacji istniejące w bazie rozkładu PKP): ${candidateNames.map((n) => `"${n}"`).join(", ")}.

Zasada wyboru:
- Jeśli zapytanie użytkownika już wprost wskazuje KONKRETNĄ stację (np. dzielnicę/część
  miasta, jak "Wrocław Kuźniki"), wybierz DOKŁADNIE TĘ, literalnie.
- W przeciwnym razie (zapytanie to ogólna nazwa miasta) wybierz NAJWIĘKSZĄ/GŁÓWNĄ stację
  tego miasta — zwykle tę z dopiskiem "Główny"/"Główna"/"Dworzec Główny", obsługującą
  najwięcej połączeń dalekobieżnych, NIE małe przystanki lokalne/podmiejskie.

Odpowiedz WYŁĄCZNIE dokładną nazwą jednego kandydata z powyższej listy, bez cudzysłowów,
bez żadnego dodatkowego tekstu ani wyjaśnienia.`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const parts: Array<{ text?: string }> = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("").trim();
    return text || null;
  } catch {
    return null;
  }
}

// Bezpiecznik: kandydat z NAJWIĘKSZĄ liczbą zapisanych odjazdów w rail_connections —
// tanie, czysto danowe przybliżenie "największej/głównej stacji", używane gdy AI
// zawiedzie (błąd sieci/klucza) albo jego odpowiedź nie zgadza się z żadnym kandydatem
// (halucynacja) — zob. migracja rail_station_candidate_stats.
async function pickCandidateByConnectivity(
  url: string, key: string, uniqueNames: string[], rows: RailStation[],
): Promise<string> {
  const groupIds = (name: string) => rows.filter((r) => r.name === name).map((r) => r.id);
  try {
    const allIds = rows.map((r) => r.id);
    const stats = await sbRpc<{ stop_id: string; departure_count: number }>(
      url, key, "rail_station_candidate_stats", { p_stop_ids: allIds },
    );
    const countByStopId = new Map(stats.map((s) => [s.stop_id, s.departure_count]));
    let bestName = uniqueNames[0];
    let bestCount = -1;
    for (const name of uniqueNames) {
      const total = groupIds(name).reduce((sum, id) => sum + (countByStopId.get(id) ?? 0), 0);
      if (total > bestCount) { bestCount = total; bestName = name; }
    }
    return bestName;
  } catch {
    return uniqueNames[0]; // ostateczny bezpiecznik — zapytanie o statystyki też zawiodło
  }
}

// Wybór stacji, gdy zapytanie to NAZWA MIASTA obejmująca kilka realnych stacji (np.
// "Katowice" -> "Katowice", "Katowice Główny", "Katowice Ligota", ...): zamiast
// heurystyki string-matchingu (dawne resolveSingleStationLocal — patrz komentarz przy
// exactRows wyżej, realny błąd: dokładne dopasowanie "Katowice" krótkie spięcie zwracało
// małą, podrzędną stację, zanim w ogóle sprawdzono istnienie "Katowice Główny"), pytamy
// AI o wybór "sensownej" (największej) stacji — z deterministycznym bezpiecznikiem po
// liczbie połączeń, gdyby AI zawiodło albo zhalucynowało nazwę spoza kandydatów.
export async function resolveStationGroupSmart(
  url: string, key: string, geminiKey: string | undefined, query: string,
): Promise<SmartStationLookup> {
  const q = query.trim();
  if (!q) return { ok: false, body: { error: "station_not_found", query: q } };
  let rows: RailStation[];
  try {
    rows = await sbGet<RailStation>(url, key, `rail_stops?name=ilike.*${encodeURIComponent(q)}*&select=id,name,lat,lon&limit=200`);
  } catch {
    return { ok: false, body: { error: "local_lookup_failed", query: q } };
  }
  // Gemini can produce the wrong grammatical form of a station suffix (for example,
  // "Kłodzko Główny" while GTFS stores "Kłodzko Główne"). Retry that city against
  // its base name so the normal main-station selection can resolve a real GTFS name.
  if (!rows.length) {
    const cityName = q.replace(/\s+(?:główny|główna|główne|glowny|glowna|glowne)$/i, "").trim();
    if (cityName && cityName !== q) {
      try {
        rows = await sbGet<RailStation>(url, key, `rail_stops?name=ilike.*${encodeURIComponent(cityName)}*&select=id,name,lat,lon&limit=200`);
      } catch {
        return { ok: false, body: { error: "local_lookup_failed", query: q } };
      }
    }
  }
  if (!rows.length) return { ok: false, body: { error: "station_not_found", query: q } };

  const uniqueNames = [...new Set(rows.map((r) => r.name))];
  const groupIds = (name: string) => rows.filter((r) => r.name === name).map((r) => r.id);
  const buildGroup = (name: string): RailStationGroup => {
    const points = rows.filter((row) => row.name === name && row.lat !== null && row.lon !== null);
    const lat = points.length ? points.reduce((sum, row) => sum + Number(row.lat), 0) / points.length : null;
    const lon = points.length ? points.reduce((sum, row) => sum + Number(row.lon), 0) / points.length : null;
    return { name, ids: groupIds(name), lat, lon };
  };

  // Szybka ścieżka: jedna odrębna nazwa wśród kandydatów -> użyj jej wprost, bez
  // wywołania AI (pokrywa np. "Wrocław Kuźniki": jedno trafienie, koniec).
  if (uniqueNames.length === 1) {
    return { ok: true, station: buildGroup(uniqueNames[0]), resolvedVia: "single_candidate" };
  }

  if (geminiKey) {
    const aiPick = await askGeminiForStationPick(geminiKey, q, uniqueNames);
    const normalizedPick = aiPick?.trim();
    const matched = normalizedPick ? uniqueNames.find((n) => n.trim().toLowerCase() === normalizedPick.toLowerCase()) : undefined;
    if (matched) {
      return { ok: true, station: buildGroup(matched), resolvedVia: "ai", aiRawPick: aiPick };
    }
    const fallbackName = await pickCandidateByConnectivity(url, key, uniqueNames, rows);
    return { ok: true, station: buildGroup(fallbackName), resolvedVia: "ai_fallback_connectivity", aiRawPick: aiPick };
  }

  // Brak klucza Gemini w środowisku assistant-tools -- ten sam bezpiecznik po liczbie
  // połączeń, bez próby wywołania AI.
  const fallbackName = await pickCandidateByConnectivity(url, key, uniqueNames, rows);
  return { ok: true, station: buildGroup(fallbackName), resolvedVia: "ai_fallback_connectivity" };
}

// Fallback #1 z planu: brak udanego syncu, albo ostatni sukces starszy niż maxAgeHours
// (domyślnie 2x dzienny cykl syncu — toleruje jeden nieudany dzień zanim dane uznamy
// za nieaktualne) — w obu przypadkach nie ufamy lokalnym danym.
export async function hasFreshLocalData(url: string, key: string, maxAgeHours = 48): Promise<boolean> {
  try {
    const rows = await sbGet<{ finished_at: string | null; feed_checked_at: string | null }>(
      url, key,
      `rail_sync_runs?status=eq.success&order=finished_at.desc&limit=1&select=finished_at,feed_checked_at`,
    );
    const lastVerifiedAt = rows[0]?.feed_checked_at ?? rows[0]?.finished_at;
    if (!lastVerifiedAt) return false;
    return Date.now() - new Date(lastVerifiedAt).getTime() < maxAgeHours * 3600 * 1000;
  } catch {
    return false;
  }
}
