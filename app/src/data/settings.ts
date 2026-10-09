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

export interface Target {
  value: number;
  /** Overrides the KPI's usual direction: atLeast = value ≥ target is good, atMost = value ≤ target. */
  rule?: "atLeast" | "atMost";
  /** How far off target (in % of the target) still counts as amber. */
  tolerancePct: number;
}

export interface Settings {
  version: 4;
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
  /** Product-name fragments for items shipped from another location (e.g. per-lb flake from Torginol). */
  dropShipPatterns: string[];
  /** Sales-order locations that are not your own sites. */
  dropShipLocations: string[];
  /** KPI id → target. KPIs without a target show no status. */
  targets: Record<string, Target>;
  /** Business days after which an unfulfilled order counts as late. */
  lateOrderDays: number;
  /** No movement for this many days = dormant inventory. */
  dormantDays: number;
  /** From this pickup date, freight from your site to another of your sites is a transfer, not a customer order. */
  transferStartDate: string;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 4,
  carrierOverrides: {},
  locations: {
    Aurora: { countingActive: true, capacityPerDay: 65, portalCity: "Aurora, IL" },
    DFW: { countingActive: false, capacityPerDay: 65, portalCity: "Carrollton, TX" },
    Houston: { countingActive: false, capacityPerDay: 65, portalCity: "Cypress, TX" },
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
  dropShipPatterns: ["per lb", "by lb", "ships from torginol"],
  dropShipLocations: ["Torginol"],
  // Targets agreed 9 Oct 2026. Unit targets are per week. KPIs without a target are tracked only.
  targets: {
    inventory_accuracy: { value: 98, rule: "atLeast", tolerancePct: 1 },
    units_blended: { value: 5500, tolerancePct: 5 },
    units_filled: { value: 8250, tolerancePct: 5 },
    units_kitted: { value: 1000, tolerancePct: 5 },
    fulfillment_speed: { value: 2, rule: "atMost", tolerancePct: 10 },
  },
  lateOrderDays: 3,
  dormantDays: 120,
  transferStartDate: "2026-08-01",
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
  const savedVersion = saved.version as number | undefined;
  // v1 → v2: counting capacity raised to 65 SKUs/day at every site
  if (savedVersion === 1 && saved.locations) {
    for (const ls of Object.values(saved.locations)) ls.capacityPerDay = Math.max(ls.capacityPerDay, 65);
  }
  return {
    ...d,
    ...saved,
    version: 4,
    // Before v3 there were no agreed targets: start from the defaults, keeping any the user set
    targets: (savedVersion ?? 0) < 3 ? { ...d.targets, ...(saved.targets ?? {}) } : { ...(saved.targets ?? {}) },
    locations: { ...d.locations, ...(saved.locations ?? {}) },
    counts: { ...d.counts, ...(saved.counts ?? {}) },
    carrierOverrides: { ...(saved.carrierOverrides ?? {}) },
    velocityOverrides: { ...(saved.velocityOverrides ?? {}) },
  };
}
