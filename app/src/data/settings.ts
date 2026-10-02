// User settings. The prototype keeps them in the browser (localStorage) with export/import
// to a JSON file; the full build saves them as dashboard-data/state.json in the shared folder.

import { DEFAULT_HOLIDAYS } from "../calc/dates";

export type CarrierClass = "ground" | "freight" | "pickup" | "local" | "unknown";
export type VelocityClass = "fast" | "medium" | "slow" | "dormant";

export interface LocationSettings {
  countingActive: boolean;
  capacityPerDay: number;
  portalCity: string; // how the freight portal names this site's city
}

export interface Settings {
  version: 1;
  carrierOverrides: Record<string, CarrierClass>; // lower-cased inFlow value → class
  locations: Record<string, LocationSettings>;
  unassignedSalesLocation: string; // where sales lines with no location count for velocity
  mfgLocation: string; // the manufacturing report has no location column
  holidays: string[];
  counts: {
    fastCutoff: number; // cumulative share of transactions, %
    mediumCutoff: number;
    cadenceWeeks: Record<VelocityClass, number>;
    windowDays: Record<VelocityClass, number>; // ± working days a count may move
    workingDays: number[]; // 0=Sun … 6=Sat
    horizonWeeks: number;
    lookbackDays: number;
    blackouts: string[];
  };
  velocityOverrides: Record<string, VelocityClass>; // `${location}|${sku}`
  transferMatchDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  carrierOverrides: {},
  locations: {
    Aurora: { countingActive: true, capacityPerDay: 60, portalCity: "Aurora, IL" },
    DFW: { countingActive: false, capacityPerDay: 50, portalCity: "Carrollton, TX" },
    Houston: { countingActive: false, capacityPerDay: 50, portalCity: "Cypress, TX" },
  },
  unassignedSalesLocation: "Aurora",
  mfgLocation: "Aurora",
  holidays: DEFAULT_HOLIDAYS,
  counts: {
    fastCutoff: 80,
    mediumCutoff: 95,
    cadenceWeeks: { fast: 1, medium: 2, slow: 4, dormant: 52 },
    windowDays: { fast: 2, medium: 3, slow: 5, dormant: 10 },
    workingDays: [2, 3, 4, 5],
    horizonWeeks: 13,
    lookbackDays: 90,
    blackouts: [],
  },
  velocityOverrides: {},
  transferMatchDays: 3,
};

const GROUND = ["ups", "fedex ground", "fedex home", "fedex 2-day", "fedex 2 day", "fedex priority overnight", "fedex overnight", "fedex standard overnight", "fedex express saver"];
const FREIGHT = ["fedex", "fedex freight", "xpo", "dayton freight", "tforce", "saia", "sefl", "od", "old dominion", "fort freight", "southeastern freight lines", "estes", "r+l", "abf"];

/** Confirmed rules: every UPS value is ground; FedEx 2-day/overnight are ground; plain FedEx is freight. */
export function defaultCarrierClass(raw: string): CarrierClass | null {
  const v = raw.trim().toLowerCase();
  if (!v) return "unknown";
  if (v === "pickup" || v === "customer pickup" || v === "will call") return "pickup";
  if (v === "local delivery") return "local";
  if (v.startsWith("ups")) return "ground";
  if (GROUND.includes(v)) return "ground";
  if (FREIGHT.includes(v)) return "freight";
  return null; // new value: needs classifying once
}

export function carrierClass(raw: string, s: Settings): CarrierClass {
  const v = raw.trim().toLowerCase();
  return s.carrierOverrides[v] ?? defaultCarrierClass(raw) ?? "unknown";
}

export const CARRIER_CLASS_LABEL: Record<CarrierClass, string> = {
  ground: "Ground (excluded)",
  freight: "Freight",
  pickup: "Pickup",
  local: "Local delivery",
  unknown: "Carrier unknown",
};

const KEY = "execdash.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return mergeSettings(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}

/** Fill in any settings added in newer versions, so older saved files keep working. */
export function mergeSettings(saved: Partial<Settings>): Settings {
  const d = structuredClone(DEFAULT_SETTINGS);
  return {
    ...d,
    ...saved,
    locations: { ...d.locations, ...(saved.locations ?? {}) },
    counts: { ...d.counts, ...(saved.counts ?? {}) },
    carrierOverrides: { ...(saved.carrierOverrides ?? {}) },
    velocityOverrides: { ...(saved.velocityOverrides ?? {}) },
  };
}
