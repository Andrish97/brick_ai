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
    if (result.journeys.length !== 3) throw new Error(`Oczekiwano 3 tras, otrzymano ${result.journeys.length}`);
    if (result.journeys[0].legs[0].departure !== "09:00") throw new Error("Najlepszy wariant nie ma najwcześniejszego przyjazdu");
    if (result.journeys[0].legs[0].train !== "IC 2") throw new Error("Nie uzupełniono etykiety pociągu");
    if (diagnostics.windowsScanned < 2 || rpcCalls < 2) throw new Error("Skan nie objął kilku okien rozkładu");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
