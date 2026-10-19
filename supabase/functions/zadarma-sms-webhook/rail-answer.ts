type RailLeg = { from?: unknown; departure?: unknown };

/** Normalize broad time-of-day requests before the journey tool applies its search window. */
export function broadRailTimeOverride(question: string): string | null {
  // Keep a clock time or a phrase such as "od 9" supplied by the user authoritative.
  if (/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(question) || /\b(?:od|około|ok\.)\s+[01]?\d\b/i.test(question)) return null;
  const normalized = normalizePolish(question);
  if (/\b(?:rano|rankiem|porank(?:iem|u))\b/.test(normalized)) return "08:00";
  if (/\bpo\s+poludniu\b/.test(normalized)) return "12:00";
  if (/\bwieczor(?:em|e)\b/.test(normalized)) return "18:00";
  return null;
}

/** A deterministic compact format for an explicit request for only the first departure. */
export function departureOnlyReply(question: string, result: Record<string, unknown>): string | null {
  const normalized = normalizePolish(question);
  const asksOnlyDeparture = /\b(?:tylko|wylacznie|sama?)\b/.test(normalized) &&
    /\b(?:godzin(?:e|a|y)?\s+odjazdu|odjazd(?:u)?\s+(?:pociagu|godzine)|kiedy\s+odjezdza)\b/.test(normalized);
  if (!asksOnlyDeparture) return null;

  const journey = Array.isArray(result.journeys) ? result.journeys[0] : result;
  if (!journey || typeof journey !== "object") return null;
  const legs = (journey as { legs?: unknown }).legs;
  if (!Array.isArray(legs) || !legs.length) return null;
  const first = legs[0] as RailLeg;
  if (typeof first.from !== "string" || typeof first.departure !== "string") return null;
  return `${first.from} ${first.departure}`;
}

/** Answer a transfer-time question with only the arrival/departure pair(s). */
export function transferTimesReply(question: string, result: Record<string, unknown>): string | null {
  const normalized = normalizePolish(question);
  const asksForTransferTimes = /\bprzesiad\w*\b/.test(normalized) &&
    /\b(?:o\s+ktorej|kiedy|jak\s+dlugo|ile\s+(?:czasu|minut)|przyjazd|godzin)\b/.test(normalized);
  if (!asksForTransferTimes) return null;

  const journey = Array.isArray(result.journeys) ? result.journeys[0] : result;
  if (!journey || typeof journey !== "object") return null;
  const legs = (journey as { legs?: unknown }).legs;
  if (!Array.isArray(legs) || legs.length < 2) return null;
  const transfers = legs.slice(0, -1).map((leg, index) => {
    const current = leg as { to?: unknown; arrival?: unknown };
    const next = legs[index + 1] as { departure?: unknown };
    if (typeof current.to !== "string" || typeof current.arrival !== "string" || typeof next.departure !== "string") return "";
    return `${current.arrival} ${current.to} ${next.departure}`;
  });
  if (transfers.some((transfer) => !transfer)) return null;
  return `${transferCountLabel(legs.length - 1)}: ${transfers.join("-")}`;
}

/** Return one concise journey answer and state how many train changes it contains. */
export function journeyReply(question: string, result: Record<string, unknown>): string | null {
  const normalized = normalizePolish(question);
  if (!/\b(?:chce\s+jechac|jak\s+dojade|jak\s+dojechac|pokaz\s+(?:cale\s+)?polaczenie|znajdz\s+polaczenie)\b/.test(normalized)) return null;

  const journey = Array.isArray(result.journeys) ? result.journeys[0] : result;
  if (!journey || typeof journey !== "object") return null;
  const legs = (journey as { legs?: unknown }).legs;
  if (!Array.isArray(legs) || !legs.length) return null;
  const first = legs[0] as { from?: unknown; departure?: unknown };
  const last = legs.at(-1) as { to?: unknown; arrival?: unknown };
  if (typeof first.from !== "string" || typeof first.departure !== "string" ||
    typeof last.to !== "string" || typeof last.arrival !== "string") return null;
  const route = [`${first.from} ${first.departure}`];
  for (let index = 0; index < legs.length - 1; index++) {
    const current = legs[index] as { to?: unknown; arrival?: unknown };
    const next = legs[index + 1] as { departure?: unknown };
    if (typeof current.to !== "string" || typeof current.arrival !== "string" || typeof next.departure !== "string") return null;
    route.push(`${current.arrival} ${current.to} ${next.departure}`);
  }
  route.push(`${last.arrival} ${last.to}`);
  return `${transferCountLabel(legs.length - 1)}: ${route.join("-")}`;
}

function transferCountLabel(count: number): string {
  if (count === 1) return "1 przesiadka";
  if (count >= 2 && count <= 4) return `${count} przesiadki`;
  return `${count} przesiadek`;
}

function normalizePolish(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/ł/g, "l").toLocaleLowerCase("pl");
}
