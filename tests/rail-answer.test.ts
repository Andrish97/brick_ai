import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { broadRailTimeOverride, departureOnlyReply } from "../supabase/functions/zadarma-sms-webhook/rail-answer.ts";

const result = { journeys: [{ legs: [
  { from: "Tomaszów Mazowiecki", to: "Koluszki", departure: "15:22", arrival: "15:46" },
  { from: "Koluszki", to: "Żary", departure: "16:17", arrival: "18:30" },
] }] };

Deno.test("prośba o samą godzinę odjazdu zwraca stację i pierwszy odjazd", () => {
  assertEquals(
    departureOnlyReply("Tomaszów Mazowiecki - Żary. Podaj tylko godzinę odjazdu.", result),
    "Tomaszów Mazowiecki 15:22",
  );
});

Deno.test("pytanie o połączenie lub przesiadkę używa pełnego formatu", () => {
  assertEquals(departureOnlyReply("Pokaż połączenie z przesiadką.", result), null);
  assertEquals(departureOnlyReply("O której odjeżdża pociąg z Tomaszowa do Żar?", result), null);
});

Deno.test("pory dnia zaczynają okno o ustalonej godzinie, a konkretna godzina ma pierwszeństwo", () => {
  assertEquals(broadRailTimeOverride("Jutro rano z Kłodzka do Elbląga"), "08:00");
  assertEquals(broadRailTimeOverride("Jutro po południu z Katowic"), "12:00");
  assertEquals(broadRailTimeOverride("Jutro wieczorem z Katowic"), "18:00");
  assertEquals(broadRailTimeOverride("Jutro rano o 09:30"), null);
  assertEquals(broadRailTimeOverride("Jutro rano, od 9"), null);
});
