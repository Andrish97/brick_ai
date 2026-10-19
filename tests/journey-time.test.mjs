import test from "node:test";
import assert from "node:assert/strict";
import { parseJourneyDateTime, rankJourneyRoutes } from "../supabase/functions/assistant-tools/journey-time.js";

test("journey datetime requires an explicit offset and preserves it", () => {
  assert.equal(parseJourneyDateTime("2026-10-26T19:45:00+01:00"), Date.parse("2026-10-26T18:45:00Z") / 1000);
  assert.equal(parseJourneyDateTime("2026-10-26T19:45"), null);
  assert.equal(parseJourneyDateTime("not-a-date"), null);
});

test("depart-at searches rank by earliest arrival", () => {
  const routes = [
    { mode: "driving", durationSeconds: 3600, departEpoch: null, arriveEpoch: null },
    { mode: "transit", durationSeconds: 5400, departEpoch: 1000, arriveEpoch: 6400 },
  ];
  assert.equal(rankJourneyRoutes(routes, "depart_at", 1000)[0].mode, "driving");
});

test("arrive-by searches rank by latest feasible departure", () => {
  const routes = [
    { mode: "transit", durationSeconds: 3600, departEpoch: 1000, arriveEpoch: 4600 },
    { mode: "driving", durationSeconds: 1800, departEpoch: 2800, arriveEpoch: 4600 },
  ];
  assert.equal(rankJourneyRoutes(routes, "arrive_by", 4_600_000)[0].mode, "driving");
});

test("long-distance mode can prioritize transit when comparing all modes", () => {
  const routes = [
    { mode: "driving", durationSeconds: 3600, hasTrain: false, departEpoch: null, arriveEpoch: null },
    { mode: "transit", durationSeconds: 7200, hasTrain: true, departEpoch: 1000, arriveEpoch: 8200 },
  ];
  assert.equal(rankJourneyRoutes(routes, "depart_at", 1000, true)[0].mode, "transit");
});
