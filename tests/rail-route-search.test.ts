import { runRailJourneySearch } from "../supabase/functions/assistant-tools/rail-route-search.ts";

const hour = (value: number) => value * 3600;
const connections = [
  { trip_id: "trip-1", service_id: "service-1", from_stop_id: "A", to_stop_id: "Z", dep_seconds: hour(8), arr_seconds: hour(11) },
  { trip_id: "trip-2", service_id: "service-1", from_stop_id: "A", to_stop_id: "Z", dep_seconds: hour(9), arr_seconds: hour(10) },
  { trip_id: "trip-3", service_id: "service-1", from_stop_id: "A", to_stop_id: "Z", dep_seconds: hour(10), arr_seconds: hour(10) + 30 * 60 },
  { trip_id: "trip-4", service_id: "service-1", from_stop_id: "A", to_stop_id: "Z", dep_seconds: hour(11), arr_seconds: hour(12) },
];

Deno.test("ładuje GTFS przez mock PostgREST i zwraca trzy najlepsze warianty bez PKP", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(String(input));
    const table = requestUrl.pathname.split("/").at(-1);
    if (table === "rail_calendar") return Response.json([{ id: "service-1" }]);
    if (table === "rail_calendar_dates") return Response.json([]);
    if (table === "rail_connections_in_window_compact") {
      rpcCalls++;
      const args = JSON.parse(String(init?.body));
      const rows = connections.filter((row) =>
        args.p_service_ids.includes(row.service_id) &&
        row.dep_seconds >= args.p_dep_from && row.dep_seconds < args.p_dep_to &&
        (args.p_from_stop_ids === null || args.p_from_stop_ids.includes(row.from_stop_id))
      );
      return Response.json(rows);
    }
    if (table === "rail_stops") {
      return Response.json([
        { id: "A", name: "Katowice", lat: 50.26, lon: 19.02 },
        { id: "Z", name: "Zamość", lat: 50.72, lon: 23.25 },
      ]);
    }
    if (table === "rail_trips") {
      return Response.json(connections.map((row, i) => ({ id: row.trip_id, short_name: `IC ${i + 1}`, route_id: "route-1" })));
    }
    if (table === "rail_routes") return Response.json([{ id: "route-1", short_name: "IC" }]);
    throw new Error(`Nieoczekiwane żądanie w teście: ${requestUrl}`);
  }) as typeof fetch;

  try {
    const { result, diagnostics } = await runRailJourneySearch(
      "https://supabase.test",
      "test-key",
      { name: "Katowice", ids: ["A"], lat: 50.26, lon: 19.02 },
      { name: "Zamość", ids: ["Z"], lat: 50.72, lon: 23.25 },
      "2026-10-19",
      hour(8),
      hour(12),
    );
    if (!result) throw new Error(`Brak trasy: ${JSON.stringify(diagnostics)}`);
    if (result.journeys.length !== 4) throw new Error(`Oczekiwano 4 tras, otrzymano ${result.journeys.length}`);
    if (result.journeys[0].legs[0].departure !== "09:00") throw new Error("Najlepszy wariant nie ma najwcześniejszego przyjazdu");
    if (result.journeys[0].legs[0].train !== "IC 2") throw new Error("Nie uzupełniono etykiety pociągu");
    if (diagnostics.windowsScanned < 2 || rpcCalls < 2) throw new Error("Skan nie objął kilku okien rozkładu");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("ładuje kolejne pociągi po stacjach osiągniętych w poprzednim oknie", async () => {
  const originalFetch = globalThis.fetch;
  const stops = [
    { id: "A", name: "Tomaszów Mazowiecki", lat: 51.5, lon: 20 },
    { id: "B-in", name: "Koluszki", lat: 51.7434, lon: 19.8184 },
    { id: "B-out", name: "Koluszki", lat: 51.7434, lon: 19.8184 },
    { id: "C", name: "Legnica", lat: 51.2, lon: 16.2 },
    { id: "D", name: "Żary", lat: 51.6, lon: 15.1 },
  ];
  const trips = ["ŁKA 21220", "IC 1644 ŁUŻYCE", "KD 67103 KD SPRINTER KEPLER"];
  const connections = [
    { trip_id: "trip-1", service_id: "service-1", from_stop_id: "A", to_stop_id: "B-in", dep_seconds: hour(15) + 22 * 60, arr_seconds: hour(15) + 46 * 60 },
    { trip_id: "trip-2", service_id: "service-1", from_stop_id: "B-out", to_stop_id: "C", dep_seconds: hour(16) + 17 * 60, arr_seconds: hour(20) + 3 * 60 },
    { trip_id: "trip-3", service_id: "service-1", from_stop_id: "C", to_stop_id: "D", dep_seconds: hour(21) + 10 * 60, arr_seconds: hour(22) + 20 * 60 },
  ];
  let rpcCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(String(input));
    const table = requestUrl.pathname.split("/").at(-1);
    if (table === "rail_calendar") return Response.json([{ id: "service-1" }]);
    if (table === "rail_calendar_dates") return Response.json([]);
    if (table === "rail_connections_in_window_compact") {
      rpcCalls++;
      const args = JSON.parse(String(init?.body));
      const reached = stops.filter((stop) => args.p_from_stop_ids?.includes(stop.id));
      const aliases = new Set(stops.filter((stop) => reached.some((station) => station.name === stop.name &&
        Math.hypot((station.lat - stop.lat) * 111, (station.lon - stop.lon) * 111) <= 0.25
      )).map((stop) => stop.id));
      const candidates = new Set(connections.filter((row) =>
        args.p_service_ids.includes(row.service_id) &&
        row.dep_seconds >= args.p_dep_from && row.dep_seconds < args.p_dep_to &&
        (args.p_from_stop_ids === null || aliases.has(row.from_stop_id))
      ).map((row) => row.trip_id));
      const rows = connections.filter((row) =>
        args.p_service_ids.includes(row.service_id) &&
        row.dep_seconds >= args.p_dep_from && row.dep_seconds < args.p_dep_to &&
        (args.p_from_stop_ids === null || candidates.has(row.trip_id))
      ).map((row) => {
        const fromStop = stops.find((stop) => stop.id === row.from_stop_id)!;
        const toStop = stops.find((stop) => stop.id === row.to_stop_id)!;
        return {
          ...row,
          from_station_name: fromStop.name, from_lat: fromStop.lat, from_lon: fromStop.lon,
          to_station_name: toStop.name, to_lat: toStop.lat, to_lon: toStop.lon,
        };
      });
      return Response.json(rows);
    }
    if (table === "rail_stops") return Response.json(stops);
    if (table === "rail_trips") return Response.json(trips.map((short_name, i) => ({ id: `trip-${i + 1}`, short_name, route_id: `route-${i + 1}` })));
    if (table === "rail_routes") return Response.json(trips.map((_, i) => ({ id: `route-${i + 1}`, short_name: "IC" })));
    throw new Error(`Nieoczekiwane żądanie w teście: ${requestUrl}`);
  }) as typeof fetch;

  try {
    const { result } = await runRailJourneySearch(
      "https://supabase.test",
      "test-key",
      { name: "Tomaszów Mazowiecki", ids: ["A"], lat: 51.5, lon: 20 },
      { name: "Żary", ids: ["D"], lat: 51.6, lon: 15.1 },
      "2026-10-19",
      hour(15) + 22 * 60,
      hour(19) + 22 * 60,
    );
    if (!result) throw new Error("Nie znaleziono trasy z dwiema przesiadkami przez kolejne okna DB");
    if (result.legs.length !== 3) throw new Error(`Oczekiwano 3 odcinków, otrzymano ${result.legs.length}`);
    if (result.legs.map((leg) => leg.train).join("|") !== trips.join("|")) throw new Error("Planer nie zachował trzech właściwych pociągów");
    if (rpcCalls < 8) throw new Error(`Oczekiwano skanu po małych oknach, wykonano ${rpcCalls} zapytań`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
