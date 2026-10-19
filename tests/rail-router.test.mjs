import test from "node:test";
import assert from "node:assert/strict";
import { createConnectionScanner, findJourneyCandidates } from "../supabase/functions/assistant-tools/rail-router.js";

const t = (h, m = 0) => h * 3600 + m * 60;
const c = (trip, from, to, dep, arr, train = trip) => ({
  trip_id: trip,
  service_id: "day-1",
  from_stop_id: from,
  to_stop_id: to,
  dep_seconds: dep,
  arr_seconds: arr,
  train,
});
const window = { start: t(8), end: t(12) };

test("ciąg dalszy tego samego pociągu nie wymaga bufora przesiadkowego", () => {
  const result = findJourneyCandidates([
    c("IC1", "A", "B", t(8), t(8, 20)),
    c("IC1", "B", "C", t(8, 22), t(9)),
    c("IC1", "C", "D", t(9, 2), t(10)),
  ], ["A"], ["D"], window);
  assert.equal(result.length, 1);
  assert.equal(result[0].direct, true);
  assert.equal(result[0].legs.length, 1);
  assert.equal(result[0].legs[0].to_stop_id, "D");
});

test("odrzuca przesiadkę krótszą niż 30 minut", () => {
  const result = findJourneyCandidates([
    c("IC1", "A", "B", t(8), t(9)),
    c("REG1", "B", "C", t(9, 29), t(10)),
  ], ["A"], ["C"], window);
  assert.deepEqual(result, []);
});

test("akceptuje przesiadkę od 30 minut do 2,5 godziny", () => {
  const result = findJourneyCandidates([
    c("IC1", "A", "B", t(8), t(9)),
    c("REG1", "B", "C", t(9, 30), t(10)),
  ], ["A"], ["C"], window);
  assert.equal(result.length, 1);
  assert.equal(result[0].direct, false);
  assert.equal(result[0].legs.length, 2);
});

test("łączy identyfikatory peronów tej samej stacji przy przesiadce", () => {
  const result = findJourneyCandidates([
    { ...c("ŁKA 21220", "T", "K-ŁKA", t(15, 22), t(15, 46)), to_station_name: "Koluszki", to_lat: 51.7434, to_lon: 19.8184 },
    { ...c("IC 1644", "K-IC", "L", t(16, 17), t(20, 3)), from_station_name: "Koluszki", from_lat: 51.7434, from_lon: 19.8184 },
    c("KD 67103", "L", "Z", t(21, 10), t(22, 20)),
  ], ["T"], ["Z"], { start: t(15, 22), end: t(19, 22) });
  assert.equal(result.length, 1);
  assert.equal(result[0].legs.length, 3);
  assert.equal(result[0].legs[0].to_stop_id, "K-ŁKA");
  assert.equal(result[0].legs[1].from_stop_id, "K-IC");
});

test("ten sam szablon GTFS następnego dnia nie jest kontynuacją wczorajszego pociągu", () => {
  const result = findJourneyCandidates([
    { ...c("DAILY", "A", "B", t(8), t(9)), service_day_offset: 0 },
    { ...c("DAILY", "B", "C", 86400 + t(8), 86400 + t(9)), service_day_offset: 1 },
  ], ["A"], ["C"], window);
  assert.deepEqual(result, []);
});

test("znajduje trasę z trzema przesiadkami", () => {
  const result = findJourneyCandidates([
    c("T1", "A", "B", t(8), t(8, 30)),
    c("T2", "B", "C", t(9), t(9, 30)),
    c("T3", "C", "D", t(10), t(10, 30)),
    c("T4", "D", "E", t(11), t(11, 30)),
  ], ["A"], ["E"], window);
  assert.equal(result.length, 1);
  assert.equal(result[0].legs.length, 4);
});

test("skan przyrostowy łączy okna bez ponownego liczenia wcześniejszych połączeń", () => {
  const scanner = createConnectionScanner(["A"], ["D"], window);
  scanner.addConnections([
    c("IC1", "A", "B", t(8), t(9)),
  ]);
  assert.deepEqual(scanner.result().journeys, []);
  scanner.addConnections([
    c("REG1", "B", "C", t(9, 30), t(10)),
    c("IC2", "C", "D", t(10, 30), t(11)),
  ]);
  assert.equal(scanner.result().journeys[0].legs.length, 3);
});

test("frontier pomija stacje z przeterminowaną przesiadką", () => {
  const scanner = createConnectionScanner(["A"], ["Z"], window);
  scanner.addConnections([
    c("OLD", "A", "B", t(8), t(9)),
    c("FRESH", "A", "C", t(10), t(10, 30)),
    c("FUTURE", "A", "D", t(11, 50), t(12, 20)),
  ]);
  const frontier = scanner.result(t(12)).reachableStopIds;
  assert.deepEqual(frontier, ["C", "D"]);
});

test("nie przekracza limitu trzech przesiadek", () => {
  const result = findJourneyCandidates([
    c("T1", "A", "B", t(8), t(8, 20)),
    c("T2", "B", "C", t(8, 50), t(9, 10)),
    c("T3", "C", "D", t(9, 40), t(10)),
    c("T4", "D", "E", t(10, 30), t(10, 50)),
    c("T5", "E", "Z", t(11, 20), t(11, 40)),
  ], ["A"], ["Z"], window);
  assert.deepEqual(result, []);
});

test("odrzuca oczekiwanie dłuższe niż 2,5 godziny", () => {
  const result = findJourneyCandidates([
    c("IC1", "A", "B", t(8), t(9)),
    c("REG1", "B", "C", t(11, 31), t(12)),
  ], ["A"], ["C"], window);
  assert.deepEqual(result, []);
});

test("zwraca najwyżej trzy warianty, posortowane po czasie przyjazdu", () => {
  const result = findJourneyCandidates([
    c("IC1", "A", "Z", t(8), t(12)),
    c("IC2", "A", "Z", t(9), t(11)),
    c("IC3", "A", "Z", t(10), t(10, 30)),
    c("IC4", "A", "Z", t(11), t(10, 45)),
  ], ["A"], ["Z"], window);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((x) => x.arrival), [t(10, 30), t(10, 45), t(11)]);
});

test("zachowuje najlepsze warianty z jedną, dwiema i trzema przesiadkami", () => {
  const result = findJourneyCandidates([
    c("DIRECT", "A", "Z", t(8), t(9)),
    c("ONE1", "A", "B", t(8, 5), t(8, 30)),
    c("ONE2", "B", "Z", t(9), t(10)),
    c("TWO1", "A", "C", t(8, 10), t(8, 30)),
    c("TWO2", "C", "D", t(9), t(9, 30)),
    c("TWO3", "D", "Z", t(10), t(10, 30)),
    c("THREE1", "A", "E", t(8, 20), t(8, 30)),
    c("THREE2", "E", "F", t(9), t(9, 10)),
    c("THREE3", "F", "G", t(9, 40), t(9, 50)),
    c("THREE4", "G", "Z", t(10, 20), t(10, 30)),
  ], ["A"], ["Z"], window);
  assert.deepEqual(result.map((journey) => journey.legs.length), [2, 3, 4]);
  const withDirect = findJourneyCandidates([
    c("DIRECT", "A", "Z", t(8), t(9)),
    c("ONE1", "A", "B", t(8, 5), t(8, 30)),
    c("ONE2", "B", "Z", t(9), t(10)),
    c("TWO1", "A", "C", t(8, 10), t(8, 30)),
    c("TWO2", "C", "D", t(9), t(9, 30)),
    c("TWO3", "D", "Z", t(10), t(10, 30)),
    c("THREE1", "A", "E", t(8, 20), t(8, 30)),
    c("THREE2", "E", "F", t(9), t(9, 10)),
    c("THREE3", "F", "G", t(9, 40), t(9, 50)),
    c("THREE4", "G", "Z", t(10, 20), t(10, 30)),
  ], ["A"], ["Z"], window, { maxJourneys: 4 });
  assert.deepEqual(withDirect.map((journey) => journey.legs.length), [1, 2, 3, 4]);
});

test("nie rozpoczyna podróży poza czterogodzinnym oknem pierwszego odjazdu", () => {
  const result = findJourneyCandidates([
    c("IC1", "A", "Z", t(12), t(13)),
  ], ["A"], ["Z"], window);
  assert.deepEqual(result, []);
});

test("nie składa trasy z niepowiązanych przyjazdów i odjazdów na tej samej stacji", () => {
  const result = findJourneyCandidates([
    c("IC1", "A", "B", t(8), t(9)),
    c("REG1", "X", "B", t(8, 10), t(8, 40)),
    c("IC2", "B", "Z", t(9, 30), t(10)),
  ], ["A"], ["Z"], window);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].legs.map((leg) => leg.trip_id), ["IC1", "IC2"]);
});
