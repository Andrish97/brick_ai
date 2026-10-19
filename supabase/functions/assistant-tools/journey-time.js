/** Time parsing and ranking shared with unit tests. Dates must carry an explicit zone. */
export function parseJourneyDateTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function rankJourneyRoutes(routes, direction, targetMs, preferTransit = false) {
  return routes.map((route) => {
    const durationMs = route.durationSeconds * 1000;
    const departAt = route.departEpoch !== null ? route.departEpoch * 1000 : (direction === "arrive_by" ? targetMs - durationMs : targetMs);
    const arriveAt = route.arriveEpoch !== null ? route.arriveEpoch * 1000 : departAt + durationMs;
    return { ...route, departAt, arriveAt };
  }).filter((route) => direction !== "arrive_by" || route.arriveAt <= targetMs)
    .sort((a, b) => {
      if (preferTransit) {
        const aRank = a.mode === "transit" ? (a.hasTrain ? 0 : 1) : 2;
        const bRank = b.mode === "transit" ? (b.hasTrain ? 0 : 1) : 2;
        if (aRank !== bRank) return aRank - bRank;
      }
      return direction === "arrive_by" ? b.departAt - a.departAt : a.arriveAt - b.arriveAt;
    });
}
