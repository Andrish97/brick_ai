import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveStationGroupSmart } from "../supabase/functions/assistant-tools/rail-stations.ts";

Deno.test("rozwiązuje błędną odmianę sufiksu stacji przez nazwę miasta", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    if (url.pathname.endsWith("/rail_stops")) {
      const filter = url.searchParams.get("name") || "";
      if (filter === "ilike.*Kłodzko Główny*") return Response.json([]);
      if (filter === "ilike.*Kłodzko*") {
        return Response.json([
          { id: "main", name: "Kłodzko Główne", lat: 50.44, lon: 16.65 },
          { id: "city", name: "Kłodzko Miasto", lat: 50.44, lon: 16.65 },
        ]);
      }
    }
    if (url.pathname.endsWith("/rail_station_candidate_stats")) {
      return Response.json([
        { stop_id: "main", departure_count: 100 },
        { stop_id: "city", departure_count: 10 },
      ]);
    }
    throw new Error(`Nieoczekiwane żądanie: ${url}`);
  }) as typeof fetch;

  try {
    const result = await resolveStationGroupSmart("https://supabase.test", "key", undefined, "Kłodzko Główny");
    if (!result.ok) throw new Error(`Stacja nie została rozpoznana: ${JSON.stringify(result.body)}`);
    assertEquals(result.station.name, "Kłodzko Główne");
    assertEquals(requests.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
