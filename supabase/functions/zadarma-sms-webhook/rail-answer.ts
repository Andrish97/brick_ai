type RailLeg = { from?: unknown; departure?: unknown };

/** Normalize broad time-of-day requests before the journey tool applies its search window. */
export function broadRailTimeOverride(question: string): string | null {
  // Keep a clock time or a phrase such as "od 9" supplied by the user authoritative.
  if (/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(question) || /\b(?:od|około|ok\.)\s+[01]?\d\b/i.test(question)) return null;
  const normalized = question.toLocaleLowerCase("pl-PL");
  if (/\b(?:rano|rankiem|porank(?:iem|u))\b/.test(normalized)) return "08:00";
  if (/\bpo\s+południu\b/.test(normalized)) return "12:00";
  if (/\bwieczor(?:em|e)\b/.test(normalized)) return "18:00";
  return null;
}

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
