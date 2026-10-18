// Database adapter for rail-router.js. The router itself is pure and tested with
// synthetic GTFS connections; this module is responsible only for loading active
// service-day connections and resolving display names.
import { scanConnections } from "./rail-router.js";

type RailStationGroup = { name: string; ids: string[] };
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
  reachedStationNames?: string[];
};

const WINDOW_SECONDS = 2 * 3600;
const TOTAL_SCAN_SECONDS = 50 * 3600;
const EXTENDED_DAY_CEILING_SECONDS = 30 * 3600;
const MAX_RPC_REQUESTS = 160;
const MAX_SPLIT_DEPTH = 8;
const POSTGREST_MAX_ROWS = 1000;
const MIN_TRANSFER_SECONDS = 7 * 60;
const MAX_TRANSFER_SECONDS = 4 * 3600;
const MAX_JOURNEYS = 3;
const IN_LIST_LIMIT = 500;

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
  if (!response.ok) throw new Error(`rail_db_rpc_failed ${fn}: HTTP ${response.status}`);
  return response.json();
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
 * Find up to three sensible journeys in one complete connection scan. Each RPC window
 * is reloaded when the reachable-station frontier grows; the accumulated data is always
 * rescanned chronologically so out-of-order pages can never corrupt CSA state.
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

  const allConnections = new Map<string, Connection>();
  const originWindow = { start: originWindowStart, end: originWindowEnd };
  let rpcRequests = 0;

  const fetchWindow = async (
    serviceIds: string[],
    localStart: number,
    localEnd: number,
    frontier: string[],
    splitDepth = 0,
  ): Promise<Connection[]> => {
    if (rpcRequests >= MAX_RPC_REQUESTS) throw new Error("rail_rpc_budget_exhausted");
    rpcRequests++;
    const rows = await sbRpc<Connection>(url, key, "rail_connections_in_window", {
      p_service_ids: serviceIds,
      p_dep_from: localStart,
      p_dep_to: localEnd,
      p_from_stop_ids: frontier,
      p_dest_stop_ids: to.ids,
    });
    if (rows.length < POSTGREST_MAX_ROWS) return rows;
    if (splitDepth >= MAX_SPLIT_DEPTH || localEnd - localStart <= 60) {
      throw new Error(`rail_rpc_page_limit_unresolved ${localStart}-${localEnd}`);
    }
    const midpoint = localStart + Math.floor((localEnd - localStart) / 2);
    const [left, right] = await Promise.all([
      fetchWindow(serviceIds, localStart, midpoint, frontier, splitDepth + 1),
      fetchWindow(serviceIds, midpoint, localEnd, frontier, splitDepth + 1),
    ]);
    return [...left, ...right];
  };

  const scan = (): ScanResult => scanConnections(
    [...allConnections.values()].sort((a, b) => a.dep_seconds - b.dep_seconds || a.arr_seconds - b.arr_seconds),
    from.ids,
    to.ids,
    originWindow,
    { minTransferSeconds: MIN_TRANSFER_SECONDS, maxTransferSeconds: MAX_TRANSFER_SECONDS, maxJourneys: MAX_JOURNEYS },
  ) as ScanResult;

  const maxDayOffset = Math.floor((originWindowStart + TOTAL_SCAN_SECONDS) / 86400);
  dayLoop:
  for (let dayOffset = 0; dayOffset <= maxDayOffset; dayOffset++) {
    let serviceIds: Set<string>;
    try {
      serviceIds = dayOffset === 0 ? dayZeroServices : await activeServiceIds(url, key, addDays(date, dayOffset));
    } catch (error) {
      diagnostics.connectionsFetchError = `active_service_lookup_failed_day_${dayOffset}: ${String(error)}`;
      break;
    }
    if (!serviceIds.size) continue;

    const dayBase = dayOffset * 86400;
    for (let localStart = dayOffset === 0 ? originWindowStart : 0; localStart < EXTENDED_DAY_CEILING_SECONDS; localStart += WINDOW_SECONDS) {
      const absoluteStart = dayBase + localStart;
      if (absoluteStart >= originWindowStart + TOTAL_SCAN_SECONDS) break dayLoop;
      const current = scan();
      const thirdArrival = current.journeys.at(-1)?.arrival;
      if (current.journeys.length >= MAX_JOURNEYS && thirdArrival !== undefined && absoluteStart > thirdArrival) break dayLoop;

      diagnostics.windowsScanned++;
      const localEnd = Math.min(localStart + WINDOW_SECONDS, EXTENDED_DAY_CEILING_SECONDS);
      let frontier = current.reachableStopIds;
      let previousFrontier = new Set<string>();

      // Re-query as newly discovered stations expand the reachable frontier. The round
      // limit is a safety cap for pathological timetables; normal one/two-transfer routes
      // settle in a small number of passes.
      for (let settle = 0; settle < 8; settle++) {
        const unseenFrontier = frontier.filter((id) => !previousFrontier.has(id));
        if (!unseenFrontier.length) break;
        for (const id of unseenFrontier) previousFrontier.add(id);

        let rows: Connection[];
        try {
          rows = await fetchWindow([...serviceIds], localStart, localEnd, frontier);
        } catch (error) {
          diagnostics.connectionsFetchError = String(error);
          break dayLoop;
        }

        let added = 0;
        for (const row of rows) {
          const absolute = {
            ...row,
            dep_seconds: row.dep_seconds + dayBase,
            arr_seconds: row.arr_seconds + dayBase,
            service_day_offset: dayOffset,
            trip_instance_id: `${row.trip_id}@${dayOffset}`,
          };
          const signature = `${absolute.trip_id}|${absolute.from_stop_id}|${absolute.to_stop_id}|${absolute.dep_seconds}`;
          if (allConnections.has(signature)) continue;
          allConnections.set(signature, absolute);
          added++;
        }
        if (!added) break;
        const expanded = scan();
        frontier = expanded.reachableStopIds;
        if (frontier.every((id) => previousFrontier.has(id))) break;
      }
    }
  }

  const finalScan = scan();
  diagnostics.connectionsScannedTotal = allConnections.size;
  diagnostics.stationsReached = Math.max(0, finalScan.reachableStopIds.length - from.ids.length);
  if (diagnostics.connectionsFetchError) return { result: null, diagnostics };
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
