// Pure connection-scan journey search. Database access and presentation live outside
// this module so the routing rules can be tested without Supabase or PKP services.

const DEFAULTS = {
  minTransferSeconds: 30 * 60,
  maxTransferSeconds: 2.5 * 60 * 60,
  maxLabelsPerStop: 24,
  maxTransfers: 3,
  maxJourneys: 3,
};

/**
 * Search a chronologically ordered GTFS connection set and return distinct journey
 * options sorted by arrival time. `time` values must use one absolute timeline across
 * service days (for example, day offset * 86400 + GTFS seconds).
 */
export function createConnectionScanner(originStopIds, destinationStopIds, originWindow, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const origins = new Set(originStopIds);
  const destinations = new Set(destinationStopIds);
  const byStop = new Map();
  const aboard = new Map();
  const results = new Map();
  const stopKeyById = new Map();
  const idsByStopKey = new Map();
  const stationGroups = new Map();
  let lastDeparture = -Infinity;
  for (const origin of origins) byStop.set(origin, []);

  function stopKey(stopId, name, lat, lon) {
    let key = stopKeyById.get(stopId);
    if (key) return key;
    const normalizedName = typeof name === "string" ? name.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pl") : "";
    const latitude = lat === null || lat === undefined ? NaN : Number(lat);
    const longitude = lon === null || lon === undefined ? NaN : Number(lon);
    let candidates = stationGroups.get(normalizedName) ?? [];
    if (normalizedName && Number.isFinite(latitude) && Number.isFinite(longitude)) {
      const existing = candidates.find((group) => {
        const meanLat = (latitude + group.lat) / 2;
        return Math.hypot(
          (longitude - group.lon) * 111 * Math.cos(meanLat * Math.PI / 180),
          (latitude - group.lat) * 111,
        ) <= 0.25;
      });
      if (existing) key = existing.key;
      else {
        key = stopId;
        candidates = [...candidates, { key, lat: latitude, lon: longitude }];
        stationGroups.set(normalizedName, candidates);
      }
    } else key = stopId;
    stopKeyById.set(stopId, key);
    const ids = idsByStopKey.get(key) ?? new Set();
    ids.add(stopId);
    idsByStopKey.set(key, ids);
    return key;
  }

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

  function addConnections(connections) {
    for (const connection of connections) {
      if (connection.dep_seconds < lastDeparture) {
        throw new Error("rail_connections_not_chronological");
      }
      lastDeparture = connection.dep_seconds;
      const from = connection.from_stop_id;
      const to = connection.to_stop_id;
      const fromKey = stopKey(from, connection.from_station_name, connection.from_lat, connection.from_lon);
      const toKey = stopKey(to, connection.to_station_name, connection.to_lat, connection.to_lon);
      const trip = connection.trip_id;
      // GTFS trip IDs identify a template and repeat on every active service day.
      // Keep each day's physical train instance separate in scans spanning midnight.
      const tripInstance = connection.trip_instance_id ?? `${trip}@${connection.service_day_offset ?? 0}`;
      const boardings = [];

      if (origins.has(from) && connection.dep_seconds >= originWindow.start && connection.dep_seconds < originWindow.end) {
        boardings.push({
          arrival: connection.dep_seconds,
          firstDeparture: connection.dep_seconds,
          tripIds: [],
          legs: [],
        });
      }

      const throughAtStop = aboard.get(tripInstance)?.get(fromKey) ?? [];
      boardings.push(...throughAtStop);

      const transfersAtStop = byStop.get(fromKey) ?? [];
      for (const label of transfersAtStop) {
        if (label.tripIds.at(-1) === tripInstance) continue;
        // The origin boarding is not a transfer, so N transfers permit N+1 trains.
        if (label.tripIds.length >= cfg.maxTransfers + 1) continue;
        const wait = connection.dep_seconds - label.arrival;
        if (wait >= cfg.minTransferSeconds && wait <= cfg.maxTransferSeconds) boardings.push(label);
      }

      for (const previous of boardings) {
        const continuing = previous.tripIds.at(-1) === tripInstance;
        const legs = previous.legs.map((leg) => ({ ...leg }));
        const currentLeg = legs.at(-1);
        if (continuing && currentLeg?.to_stop_key === fromKey) {
          currentLeg.to_stop_id = to;
          currentLeg.to_stop_key = toKey;
          currentLeg.arrival = connection.arr_seconds;
        } else {
          legs.push({
            trip_id: trip,
            trip_instance_id: tripInstance,
            from_stop_id: from,
            to_stop_id: to,
            from_stop_key: fromKey,
            to_stop_key: toKey,
            departure: connection.dep_seconds,
            arrival: connection.arr_seconds,
            train: connection.train ?? connection.short_name ?? "?",
          });
        }

        const tripIds = continuing ? previous.tripIds : [...previous.tripIds, tripInstance];
        const next = {
          arrival: connection.arr_seconds,
          firstDeparture: previous.firstDeparture,
          tripIds,
          legs,
        };
        const byTrip = aboard.get(tripInstance) ?? new Map();
        keepLabel(byTrip, toKey, next);
        aboard.set(tripInstance, byTrip);
        keepLabel(byStop, toKey, next);
        if (destinations.has(to)) saveResult(next);
      }
    }
  }

  function result() {
    const candidates = [...results.values()]
      .sort((a, b) => a.arrival - b.arrival || a.legs.length - b.legs.length || a.firstDeparture - b.firstDeparture);
    const selected = [];
    const selectedKeys = new Set();
    const journeyKey = (journey) => `${journey.firstDeparture}|${journey.legs.map((leg) => leg.trip_instance_id).join(",")}`;
    // Reserve an option for one, two, and three transfers when those routes exist.
    // Otherwise the three fastest direct/one-change options could hide every route
    // that needs more changes, even though the scan had found it.
    for (const transferCount of [1, 2, 3]) {
      const candidate = candidates.find((journey) => journey.legs.length === transferCount + 1);
      if (candidate) {
        selected.push(candidate);
        selectedKeys.add(journeyKey(candidate));
      }
    }
    for (const candidate of candidates) {
      if (selected.length >= cfg.maxJourneys) break;
      const key = journeyKey(candidate);
      if (!selectedKeys.has(key)) {
        selected.push(candidate);
        selectedKeys.add(key);
      }
    }
    const journeys = selected
      .sort((a, b) => a.arrival - b.arrival || a.legs.length - b.legs.length || a.firstDeparture - b.firstDeparture)
      .map((journey) => ({
        departure: journey.firstDeparture,
        arrival: journey.arrival,
        direct: journey.legs.length === 1,
        legs: journey.legs,
      }));
    const reachableStopIds = new Set(origins);
    for (const stopId of byStop.keys()) {
      for (const rawId of idsByStopKey.get(stopId) ?? [stopId]) reachableStopIds.add(rawId);
    }
    return { journeys, reachableStopIds: [...reachableStopIds] };
  }

  function inspectStops(stopIds) {
    return stopIds.map((stopId) => ({
      stopId,
      labels: (byStop.get(stopKeyById.get(stopId) ?? stopId) ?? []).map((label) => ({
        arrival: label.arrival,
        firstDeparture: label.firstDeparture,
        trainCount: label.tripIds.length,
        lastTrip: label.tripIds.at(-1) ?? null,
      })),
    }));
  }

  return { addConnections, result, inspectStops };
}

export function scanConnections(connections, originStopIds, destinationStopIds, originWindow, options = {}) {
  const scanner = createConnectionScanner(originStopIds, destinationStopIds, originWindow, options);
  const ordered = [...connections].sort((a, b) => a.dep_seconds - b.dep_seconds || a.arr_seconds - b.arr_seconds);
  scanner.addConnections(ordered);
  return scanner.result();
}

export function findJourneyCandidates(connections, originStopIds, destinationStopIds, originWindow, options = {}) {
  return scanConnections(connections, originStopIds, destinationStopIds, originWindow, options).journeys;
}
