const projectRef = process.env.SUPABASE_PROJECT_REF;
const internalSecret = process.env.INTERNAL_SECRET;
if (!projectRef || !internalSecret) throw new Error("Brak SUPABASE_PROJECT_REF lub INTERNAL_SECRET.");

const endpoint = `https://${projectRef}.supabase.co/functions/v1/rail-gtfs-sync`;
const start = await call("start");
console.log(`GTFS start: ${start.skipped || start.runId || JSON.stringify(start)}`);
if (start.skipped === "unchanged") {
  console.log("Feed GTFS jest bez zmian; zakończono kontrolę świeżości.");
  process.exit(0);
}
if (!start.ok) throw new Error(`Nie udało się uruchomić syncu GTFS: ${JSON.stringify(start)}`);

for (let tick = 1; tick <= 600; tick++) {
  await new Promise((resolve) => setTimeout(resolve, 750));
  const result = await call("tick");
  if (tick % 10 === 0 || result.done || result.skipped) {
    const stage = result.transformStep === "connections" && result.nextTrip
      ? `connections through ${result.nextTrip}`
      : result.skipped || result.transformStep || result.file || "postęp";
    console.log(`GTFS tick ${tick}: ${result.done ? "done" : stage}`);
  }
  if (result.done || result.skipped === "nothing_running") {
    console.log("Sync GTFS zakończył pracę; test odpowiedzi sprawdzi świeżość wyniku.");
    process.exit(0);
  }
  // Pojedynczy błąd może być przejściowy; funkcja sama ponawia krok do pięciu razy.
  if (!result.ok && result.error) console.error(`Przejściowy błąd ticka: ${result.error}`);
}
throw new Error("Sync GTFS nie zakończył się po 180 krokach.");

async function call(action) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${internalSecret}` },
    body: JSON.stringify({ action }),
    // A single stop_times/transform step can legitimately run longer than a minute.
    // The Edge Function's DB statement timeout is 5 minutes, so let the request finish.
    signal: AbortSignal.timeout(330_000),
  });
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error(`Sync HTTP ${response.status}: ${raw}`); }
  if (!response.ok && result.ok !== false) throw new Error(`Sync HTTP ${response.status}: ${raw}`);
  return result;
}
