import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizeRailSearchSettings,
  RAIL_SEARCH_DEFAULTS,
} from "../supabase/functions/assistant-tools/rail-settings.ts";

Deno.test("akceptuje tylko dozwolone ustawienia wyszukiwania kolei", () => {
  assertEquals(normalizeRailSearchSettings([
    { key: "rail_min_transfer_minutes", value: "45" },
    { key: "rail_max_transfer_minutes", value: "120" },
    { key: "rail_origin_window_hours", value: "2" },
  ]), {
    minTransferMinutes: 45,
    maxTransferMinutes: 120,
    originWindowHours: 2,
  });
});

Deno.test("nieprawidłowe i niespójne wartości wracają do bezpiecznych domyślnych", () => {
  assertEquals(normalizeRailSearchSettings([
    { key: "rail_min_transfer_minutes", value: "5" },
    { key: "rail_max_transfer_minutes", value: "90.5" },
    { key: "rail_origin_window_hours", value: "8" },
  ]), RAIL_SEARCH_DEFAULTS);
  assertEquals(normalizeRailSearchSettings([
    { key: "rail_min_transfer_minutes", value: "60" },
    { key: "rail_max_transfer_minutes", value: "60" },
    { key: "rail_origin_window_hours", value: "3" },
  ]), { ...RAIL_SEARCH_DEFAULTS, minTransferMinutes: 60, originWindowHours: 3 });
});
