import { hasFreshLocalData } from "../supabase/functions/assistant-tools/rail-stations.ts";

Deno.test("uznaje codzienną kontrolę niezmienionego feedu za świeżą weryfikację danych", async () => {
  const originalFetch = globalThis.fetch;
  const now = new Date();
  const recentCheck = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const oldImport = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  globalThis.fetch = (() => Promise.resolve(Response.json([
    { finished_at: oldImport, feed_checked_at: recentCheck },
  ]))) as typeof fetch;
  try {
    if (!(await hasFreshLocalData("https://supabase.test", "test-key"))) {
      throw new Error("Niedawna kontrola niezmienionego feedu powinna odświeżyć ważność danych");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("nie uznaje świeżego importu za świeży po zbyt dawnej kontroli feedu", async () => {
  const originalFetch = globalThis.fetch;
  const now = new Date();
  const recentImport = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const oldCheck = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
  globalThis.fetch = (() => Promise.resolve(Response.json([
    { finished_at: recentImport, feed_checked_at: oldCheck },
  ]))) as typeof fetch;
  try {
    if (await hasFreshLocalData("https://supabase.test", "test-key")) {
      throw new Error("Stara kontrola feedu nie powinna uznać danych za świeże");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
