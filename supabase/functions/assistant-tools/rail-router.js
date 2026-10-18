// Pure connection-scan journey search. Database access and presentation live outside
// this module so the routing rules can be tested without Supabase or PKP services.

const DEFAULTS = {
  minTransferSeconds: 30 * 60,
  maxTransferSeconds: 4 * 60 * 60,
  maxLabelsPerStop: 24,
  maxJourneys: 3,
};

/**
 * Search a chronologically ordered GTFS connection set and return distinct journey
 * options sorted by arrival time. `time` values must use one absolute timeline across
 * service days (for example, day offset * 86400 + GTFS seconds).
 */
export function scanConnections(connections, originStopIds, destinationStopIds, originWindow, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const origins = new Set(originStopIds);
  const destinations = new Set(destinationStopIds);
  const byStop = new Map();
  const aboard = new Map();
  const results = new Map();
  for (const origin of origins) byStop.set(origin, []);

  const keyFor = (label) => `${label.firstDeparture}|${label.tripIds.join(",")}`;
  const sortLabels = (labels) => labels.sort((a, b) =>
    a.arrival - b.arrival || a.legs.length - b.legs.length || a.firstDeparture - b.firstDeparture
  );

  function keepLabel(map, key, label) {
    const labels = map.get(key) ?? [];
    const stableKey = keyFor(label);
    const existingAt = labels.findIndex((x) => keyFor(x) === stableKey);
    if (existingAt >= 0) {
      if (labels[existingAt].arrival <= label.arrival) return false;
      labels.splice(existingAt, 1);
    }
    labels.push(label);
    sortLabels(labels);
    if (labels.length > cfg.maxLabelsPerStop) labels.length = cfg.maxLabelsPerStop;
    map.set(key, labels);
    return labels.includes(label);
  }

  function saveResult(label) {
    const key = keyFor(label);
    const old = results.get(key);
    if (!old || label.arrival < old.arrival) results.set(key, label);
  }

  for (const connection of connections) {
    const from = connection.from_stop_id;
    const to = connection.to_stop_id;
    const trip = connection.trip_id;
    const boardings = [];

    if (origins.has(from) && connection.dep_seconds >= originWindow.start && connection.dep_seconds < originWindow.end) {
      boardings.push({
        arrival: connection.dep_seconds,
        firstDeparture: connection.dep_seconds,
        tripIds: [],
        legs: [],
      });
    }

    const throughAtStop = aboard.get(trip)?.get(from) ?? [];
    boardings.push(...throughAtStop);

    const transfersAtStop = byStop.get(from) ?? [];
    for (const label of transfersAtStop) {
      if (label.tripIds.at(-1) === trip) continue;
      const wait = connection.dep_seconds - label.arrival;
      if (wait >= cfg.minTransferSeconds && wait <= cfg.maxTransferSeconds) boardings.push(label);
    }

    for (const previous of boardings) {
      const continuing = previous.tripIds.at(-1) === trip;
      const legs = previous.legs.map((leg) => ({ ...leg }));
      const currentLeg = legs.at(-1);
      if (continuing && currentLeg?.to_stop_id === from) {
        currentLeg.to_stop_id = to;
        currentLeg.arrival = connection.arr_seconds;
      } else {
        legs.push({
          trip_id: trip,
          from_stop_id: from,
          to_stop_id: to,
          departure: connection.dep_seconds,
          arrival: connection.arr_seconds,
          train: connection.train ?? connection.short_name ?? "?",
        });
      }

      const tripIds = continuing ? previous.tripIds : [...previous.tripIds, trip];
      const next = {
        arrival: connection.arr_seconds,
        firstDeparture: previous.firstDeparture,
        tripIds,
        legs,
      };
      const byTrip = aboard.get(trip) ?? new Map();
      keepLabel(byTrip, to, next);
      aboard.set(trip, byTrip);
      keepLabel(byStop, to, next);
      if (destinations.has(to)) saveResult(next);
    }
  }

  const journeys = [...results.values()]
    .sort((a, b) => a.arrival - b.arrival || a.legs.length - b.legs.length || a.firstDeparture - b.firstDeparture)
    .slice(0, cfg.maxJourneys)
    .map((journey) => ({
      departure: journey.firstDeparture,
      arrival: journey.arrival,
      direct: journey.legs.length === 1,
      legs: journey.legs,
    }));
  return { journeys, reachableStopIds: [...byStop.keys()] };
}

export function findJourneyCandidates(connections, originStopIds, destinationStopIds, originWindow, options = {}) {
  return scanConnections(connections, originStopIds, destinationStopIds, originWindow, options).journeys;
}
