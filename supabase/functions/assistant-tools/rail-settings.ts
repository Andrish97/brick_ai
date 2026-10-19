export const RAIL_SEARCH_DEFAULTS = {
  minTransferMinutes: 30,
  maxTransferMinutes: 150,
  originWindowHours: 4,
} as const;

export const RAIL_SEARCH_OPTIONS = {
  minTransferMinutes: [30, 45, 60],
  maxTransferMinutes: [90, 120, 150, 180],
  originWindowHours: [1, 2, 3, 4],
} as const;

export type RailSearchSettings = {
  minTransferMinutes: number;
  maxTransferMinutes: number;
  originWindowHours: number;
};

type SettingRow = { key: string; value: string };

function allowedValue<T extends readonly number[]>(value: string | undefined, options: T): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && options.includes(parsed) ? parsed : undefined;
}

export function normalizeRailSearchSettings(rows: SettingRow[]): RailSearchSettings {
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const minTransferMinutes = allowedValue(values.get("rail_min_transfer_minutes"), RAIL_SEARCH_OPTIONS.minTransferMinutes)
    ?? RAIL_SEARCH_DEFAULTS.minTransferMinutes;
  const proposedMax = allowedValue(values.get("rail_max_transfer_minutes"), RAIL_SEARCH_OPTIONS.maxTransferMinutes);
  const maxTransferMinutes = proposedMax !== undefined && proposedMax > minTransferMinutes
    ? proposedMax
    : RAIL_SEARCH_DEFAULTS.maxTransferMinutes;
  const originWindowHours = allowedValue(values.get("rail_origin_window_hours"), RAIL_SEARCH_OPTIONS.originWindowHours)
    ?? RAIL_SEARCH_DEFAULTS.originWindowHours;
  return { minTransferMinutes, maxTransferMinutes, originWindowHours };
}

export async function loadRailSearchSettings(url: string, key: string): Promise<RailSearchSettings> {
  try {
    const response = await fetch(
      `${url}/rest/v1/settings?key=in.(rail_min_transfer_minutes,rail_max_transfer_minutes,rail_origin_window_hours)&select=key,value`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } },
    );
    if (!response.ok) return { ...RAIL_SEARCH_DEFAULTS };
    return normalizeRailSearchSettings(await response.json() as SettingRow[]);
  } catch {
    return { ...RAIL_SEARCH_DEFAULTS };
  }
}
