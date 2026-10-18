import test from "node:test";
import assert from "node:assert/strict";
import { findJourneyCandidates } from "../supabase/functions/assistant-tools/rail-router.js";

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

test("ciąg dalszy tego samego pociągu nie wymaga 30-minutowej przesiadki", () => {
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

test("akceptuje przesiadkę od 30 minut do 4 godzin", () => {
  const result = findJourneyCandidates([
    c("IC1", "A", "B", t(8), t(9)),
    c("REG1", "B", "C", t(9, 30), t(10)),
  ], ["A"], ["C"], window);
  assert.equal(result.length, 1);
  assert.equal(result[0].direct, false);
  assert.equal(result[0].legs.length, 2);
});

test("odrzuca oczekiwanie dłuższe niż 4 godziny", () => {
  const result = findJourneyCandidates([
    c("IC1", "A", "B", t(8), t(9)),
    c("REG1", "B", "C", t(13, 1), t(14)),
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
