type RailLeg = { from?: unknown; departure?: unknown };

/** A deterministic compact format for an explicit request for only the first departure. */
export function departureOnlyReply(question: string, result: Record<string, unknown>): string | null {
  const normalized = question.toLocaleLowerCase("pl-PL");
  const asksOnlyDeparture = /\b(?:tylko|wyłącznie|samą?)\b/.test(normalized) &&
    /\b(?:godzin(?:ę|a|y)?\s+odjazdu|odjazd(?:u)?\s+(?:pociągu|godzinę)|kiedy\s+odjeżdża)\b/.test(normalized);
  if (!asksOnlyDeparture) return null;

  const journey = Array.isArray(result.journeys) ? result.journeys[0] : result;
  if (!journey || typeof journey !== "object") return null;
  const legs = (journey as { legs?: unknown }).legs;
  if (!Array.isArray(legs) || !legs.length) return null;
  const first = legs[0] as RailLeg;
  if (typeof first.from !== "string" || typeof first.departure !== "string") return null;
  return `${first.from} ${first.departure}`;
}
