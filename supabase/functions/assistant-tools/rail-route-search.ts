// Database adapter for rail-router.js. The router itself is pure and tested with
// synthetic GTFS connections; this module is responsible only for loading active
// service-day connections and resolving display names.
import { createConnectionScanner } from "./rail-router.js";

type RailStationGroup = { name: string; ids: string[]; lat: number | null; lon: number | null };
type Connection = {
  trip_id: string;
  service_id: string;
  from_stop_id: string;
  to_stop_id: string;
  dep_seconds: number;
  arr_seconds: number;
  service_day_offset?: number;
  trip_instance_id?: string;
};
type JourneyLeg = { from: string; to: string; departure: string; arrival: string; train: string };
type JourneyOption = { direct: boolean; legs: JourneyLeg[] };
export type JourneySearchResult = JourneyOption & { journeys: JourneyOption[] };
type RawLeg = { trip_id: string; from_stop_id: string; to_stop_id: string; departure: number; arrival: number; train: string };
type RawJourney = { departure: number; arrival: number; direct: boolean; legs: RawLeg[] };
type ScanResult = { journeys: RawJourney[]; reachableStopIds: string[] };

export type RouteSearchDiagnostics = {
  activeServiceCount: number;
  windowsScanned: number;
  connectionsScannedTotal: number;
  stationsReached: number;
  connectionsFetchError?: string;
  fromGroupSize?: number;
  toGroupSize?: number;
  originHasCoordinates?: boolean;
  destinationHasCoordinates?: boolean;
  reachedStationNames?: string[];
};

// Skanuj po maks. 30 minutach naraz. Ponieważ minimalna przesiadka też trwa
// 30 minut, każda poprawna przesiadka zaczyna się w kolejnym oknie, którego
// frontier zawiera już stację osiągniętą poprzednim pociągiem.
const WINDOW_SECONDS = 30 * 60;
// The four-hour limit applies to the first departure from the origin. Keep
// looking at later connections long enough for cross-country trips and up to
// three transfers to reach their destination.
const WINDOW_STEP_SECONDS = WINDOW_SECONDS;
const TOTAL_SCAN_SECONDS = 20 * 3600;
const EXTENDED_DAY_CEILING_SECONDS = 30 * 3600;
const MAX_RPC_REQUESTS = 80;
const MIN_TRANSFER_SECONDS = 30 * 60;
const MAX_TRANSFER_SECONDS = 2.5 * 3600;
const MAX_JOURNEYS = 4;
const IN_LIST_LIMIT = 500;

function maxDetourKm(from: RailStationGroup, to: RailStationGroup): number | null {
  if (from.lat === null || from.lon === null || to.lat === null || to.lon === null) return null;
  const meanLat = (from.lat + to.lat) / 2;
  const dx = (to.lon - from.lon) * 111.0 * Math.cos(meanLat * Math.PI / 180);
  const dy = (to.lat - from.lat) * 111.0;
  // Jest to wyłącznie bezpiecznik rozmiaru skanu, nie kryterium jakości trasy.
  // Przy ciasnym limicie 1.3x odrzucaliśmy prawidłowe korytarze przesiadkowe,
  // m.in. Tomaszów Mazowiecki–Wrocław–Legnica–Żary.
  return Math.max(150, Math.hypot(dx, dy) * 1.6 + 30);
}

async function sbGet<T>(url: string, key: string, path: string): Promise<T[]> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error(`rail_db_get_failed ${path}: HTTP ${response.status}`);
  return response.json();
}

async function sbRpc<T>(url: string, key: string, fn: string, args: Record<string, unknown>): Promise<T[]> {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`rail_db_rpc_failed ${fn}: HTTP ${response.status}: ${body.slice(0, 1200)}`);
  try { return JSON.parse(body) as T[]; }
  catch { throw new Error(`rail_db_rpc_invalid_json ${fn}: ${body.slice(0, 1200)}`); }
}

function inList(ids: string[]): string {
  return ids.slice(0, IN_LIST_LIMIT).map((id) => `"${id}"`).join(",");
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

async function activeServiceIds(url: string, key: string, date: string): Promise<Set<string>> {
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date(`${date}T00:00:00Z`).getUTCDay()];
  const [calendar, exceptions] = await Promise.all([
    sbGet<{ id: string }>(url, key, `rail_calendar?start_date=lte.${date}&end_date=gte.${date}&${weekday}=eq.true&select=id`),
    sbGet<{ service_id: string; exception_type: number }>(url, key, `rail_calendar_dates?date=eq.${date}&select=service_id,exception_type`),
  ]);
  const ids = new Set(calendar.map((row) => row.id));
  for (const item of exceptions) {
    if (item.exception_type === 1) ids.add(item.service_id);
    if (item.exception_type === 2) ids.delete(item.service_id);
  }
  return ids;
}

function secondsToHHMM(seconds: number): string {
  const value = ((seconds % 86400) + 86400) % 86400;
  return `${String(Math.floor(value / 3600)).padStart(2, "0")}:${String(Math.floor((value % 3600) / 60)).padStart(2, "0")}`;
}

/**
 * Fetch and process each four-hour connection window once. The router retains its CSA
 * state between windows, so adding a longer search horizon does not repeatedly rescan
 * the entire timetable.
 */
export async function runRailJourneySearch(
  url: string,
  key: string,
  from: RailStationGroup,
  to: RailStationGroup,
  date: string,
  originWindowStart: number,
  originWindowEnd: number,
): Promise<{ result: JourneySearchResult | null; diagnostics: RouteSearchDiagnostics }> {
  const diagnostics: RouteSearchDiagnostics = {
    activeServiceCount: 0,
    windowsScanned: 0,
    connectionsScannedTotal: 0,
    stationsReached: 0,
    fromGroupSize: from.ids.length,
    toGroupSize: to.ids.length,
    originHasCoordinates: from.lat !== null && from.lon !== null,
    destinationHasCoordinates: to.lat !== null && to.lon !== null,
  };
  let dayZeroServices: Set<string>;
  try {
    dayZeroServices = await activeServiceIds(url, key, date);
  } catch (error) {
    diagnostics.connectionsFetchError = `active_service_lookup_failed: ${String(error)}`;
    return { result: null, diagnostics };
  }
  diagnostics.activeServiceCount = dayZeroServices.size;
  if (!dayZeroServices.size) return { result: null, diagnostics };

  const originWindow = { start: originWindowStart, end: originWindowEnd };
  const scanner = createConnectionScanner(
    from.ids,
    to.ids,
    originWindow,
    { minTransferSeconds: MIN_TRANSFER_SECONDS, maxTransferSeconds: MAX_TRANSFER_SECONDS, maxTransfers: 3, maxJourneys: MAX_JOURNEYS, maxLabelsPerStop: 48 },
  );
  let rpcRequests = 0;

  const fetchWindow = async (
    serviceIds: string[],
    localStart: number,
    localEnd: number,
    frontier: string[] | null,
  ): Promise<Connection[]> => {
    if (rpcRequests >= MAX_RPC_REQUESTS) throw new Error("rail_rpc_budget_exhausted");
    rpcRequests++;
    const rows = await sbRpc<Connection>(url, key, "rail_connections_in_window_compact", {
      p_service_ids: serviceIds,
      p_dep_from: localStart,
      p_dep_to: localEnd,
      p_from_stop_ids: frontier,
      p_origin_lat: from.lat,
      p_origin_lon: from.lon,
      p_dest_lat: to.lat,
      p_dest_lon: to.lon,
      p_max_detour_km: maxDetourKm(from, to),
    });
    return rows;
  };

  const activeByOffset = new Map<number, Set<string>>([[0, dayZeroServices]]);
  let fetchFailed = false;
  scanLoop:
  for (let absoluteStart = originWindowStart; absoluteStart < originWindowStart + TOTAL_SCAN_SECONDS; absoluteStart += WINDOW_STEP_SECONDS) {
    const absoluteWindowEnd = Math.min(absoluteStart + WINDOW_SECONDS, originWindowStart + TOTAL_SCAN_SECONDS);
    for (let segmentStart = absoluteStart; segmentStart < absoluteWindowEnd;) {
      const segmentEnd = Math.min(absoluteWindowEnd, (Math.floor(segmentStart / 86400) + 1) * 86400);
      const current = scanner.result() as ScanResult;
      const thirdArrival = current.journeys.at(-1)?.arrival;
      const coveredTransferCounts = new Set(current.journeys.map((journey) => journey.legs.length - 1));
      const allTransferCountsFound = [1, 2, 3].every((count) => coveredTransferCounts.has(count));
      if (allTransferCountsFound && thirdArrival !== undefined && segmentStart > thirdArrival) break scanLoop;

      diagnostics.windowsScanned++;
      const firstOffset = Math.max(0, Math.floor(segmentStart / 86400) - 1);
      const lastOffset = Math.floor((segmentEnd - 1) / 86400);
      const batch: Connection[] = [];
      const seen = new Set<string>();
      const frontier = current.reachableStopIds;

      for (let dayOffset = firstOffset; dayOffset <= lastOffset; dayOffset++) {
        const dayBase = dayOffset * 86400;
        const localStart = Math.max(0, segmentStart - dayBase);
        const localEnd = Math.min(EXTENDED_DAY_CEILING_SECONDS, segmentEnd - dayBase);
        if (localStart >= localEnd) continue;

        let serviceIds = activeByOffset.get(dayOffset);
        if (!serviceIds) {
          try {
            serviceIds = await activeServiceIds(url, key, addDays(date, dayOffset));
            activeByOffset.set(dayOffset, serviceIds);
          } catch (error) {
            diagnostics.connectionsFetchError = `active_service_lookup_failed_day_${dayOffset}: ${String(error)}`;
            fetchFailed = true;
            break scanLoop;
          }
        }
        if (!serviceIds.size) continue;

        let rows: Connection[];
        try {
          rows = await fetchWindow([...serviceIds], localStart, localEnd, frontier);
        } catch (error) {
          diagnostics.connectionsFetchError = String(error);
          fetchFailed = true;
          break scanLoop;
        }

        for (const row of rows) {
          const absolute = {
            ...row,
            dep_seconds: row.dep_seconds + dayBase,
            arr_seconds: row.arr_seconds + dayBase,
            service_day_offset: dayOffset,
            trip_instance_id: `${row.trip_id}@${dayOffset}`,
          };
          const signature = `${absolute.trip_id}|${absolute.from_stop_id}|${absolute.to_stop_id}|${absolute.dep_seconds}`;
          if (seen.has(signature)) continue;
          seen.add(signature);
          batch.push(absolute);
        }
      }

      batch.sort((a, b) => a.dep_seconds - b.dep_seconds || a.arr_seconds - b.arr_seconds);
      scanner.addConnections(batch);
      diagnostics.connectionsScannedTotal += batch.length;
      segmentStart = segmentEnd;
    }
  }

  const finalScan = scanner.result() as ScanResult;
  diagnostics.stationsReached = Math.max(0, finalScan.reachableStopIds.length - from.ids.length);
  if (fetchFailed || diagnostics.connectionsFetchError) return { result: null, diagnostics };
  if (!finalScan.journeys.length) {
    const reachedIds = finalScan.reachableStopIds.filter((id) => !from.ids.includes(id)).slice(0, 15);
    if (reachedIds.length) {
      try {
        const rows = await sbGet<{ id: string; name: string }>(url, key, `rail_stops?id=in.(${inList(reachedIds)})&select=id,name`);
        diagnostics.reachedStationNames = rows.map((row) => row.name);
      } catch { /* optional diagnostics */ }
    }
    return { result: null, diagnostics };
  }

  const rawJourneys = finalScan.journeys;
  const stopIds = [...new Set(rawJourneys.flatMap((journey) => journey.legs.flatMap((leg) => [leg.from_stop_id, leg.to_stop_id])))];
  const tripIds = [...new Set(rawJourneys.flatMap((journey) => journey.legs.map((leg) => leg.trip_id)))];
  let stopRows: { id: string; name: string }[];
  let tripRows: { id: string; short_name: string | null; route_id: string }[];
  try {
    [stopRows, tripRows] = await Promise.all([
      sbGet<{ id: string; name: string }>(url, key, `rail_stops?id=in.(${inList(stopIds)})&select=id,name`),
      sbGet<{ id: string; short_name: string | null; route_id: string }>(url, key, `rail_trips?id=in.(${inList(tripIds)})&select=id,short_name,route_id`),
    ]);
  } catch (error) {
    diagnostics.connectionsFetchError = `journey_hydration_failed: ${String(error)}`;
    return { result: null, diagnostics };
  }
  const stopName = new Map(stopRows.map((row) => [row.id, row.name]));
  const tripInfo = new Map(tripRows.map((row) => [row.id, row]));
  const routeIds = [...new Set(tripRows.map((row) => row.route_id))];
  let routeNames = new Map<string, string | null>();
  if (routeIds.length) {
    try {
      const routes = await sbGet<{ id: string; short_name: string | null }>(url, key, `rail_routes?id=in.(${inList(routeIds)})&select=id,short_name`);
      routeNames = new Map(routes.map((row) => [row.id, row.short_name]));
    } catch { /* train labels can fall back to ? */ }
  }

  const journeys: JourneyOption[] = rawJourneys.map((journey) => ({
    direct: journey.direct,
    legs: journey.legs.map((leg) => {
      const trip = tripInfo.get(leg.trip_id);
      return {
        from: stopName.get(leg.from_stop_id) ?? leg.from_stop_id,
        to: stopName.get(leg.to_stop_id) ?? leg.to_stop_id,
        departure: secondsToHHMM(leg.departure),
        arrival: secondsToHHMM(leg.arrival),
        train: trip?.short_name || (trip ? routeNames.get(trip.route_id) : null) || "?",
      };
    }),
  }));
  return { result: { ...journeys[0], journeys }, diagnostics };
}
