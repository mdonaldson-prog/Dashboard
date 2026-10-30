// Planner settings and the edits made on the schedule (locks, manual adds, renamed MOs).
// Saved in this browser's localStorage; Settings → Export/Import moves them between computers.

export type Lane = "BLEND" | "FILL" | "KIT";
export const LANES: Lane[] = ["BLEND", "FILL", "KIT"];
export const LANE_LABEL: Record<Lane, string> = { BLEND: "Blend", FILL: "Fill", KIT: "Kit" };

export interface Capacity {
  /** Standard blend batches per day. */
  blendStd: number;
  /** Big-tank batches per day (batches at or above bigThreshold gallons). */
  blendBig: number;
  bigThreshold: number;
  /** Gallons filled per day. */
  fillGal: number;
  /** Kits assembled per day. */
  kits: number;
}

export interface Settings {
  demandWeeks: number;
  coverDays: number;
  safetyDays: number;
  horizonDays: number;
  /** Blank = the next workday after today. */
  startDate: string;
  useReorderFloor: boolean;
  /** What-if: treat raw materials on open POs as already on hand. */
  countOnOrder: boolean;
  capacity: Capacity;
  holidayRules: Record<string, boolean>;
  extraClosures: { date: string; name: string }[];
  /** SKU ending → label suffix on MO names. Anything else gets defaultLabel. */
  labels: { ending: string; label: string }[];
  defaultLabel: string;
}

/** A schedule edit that survives recalculation. */
export interface Pin {
  id: string;
  sku: string;
  qty: number;
  /** Fixed day; blank = let the planner pick (manual adds only). */
  date: string;
  manual: boolean;
}

export interface Edits {
  pins: Pin[];
  /** MO name overrides keyed "SKU|date|n" (n = 1 unless the SKU runs twice that day). */
  names: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  demandWeeks: 8,
  coverDays: 10,
  safetyDays: 5,
  horizonDays: 10,
  startDate: "",
  useReorderFloor: true,
  countOnOrder: false,
  capacity: { blendStd: 3, blendBig: 1, bigThreshold: 1000, fillGal: 1835, kits: 275 },
  holidayRules: {},
  extraClosures: [],
  labels: [
    { ending: "-I", label: "INTEGRITY" },
    { ending: "-CS", label: "CORESOURCE" },
    { ending: "-EW", label: "EPOXYWORX" },
    { ending: "-GFC", label: "THEGARAGEFLOORCOMPANY" },
    { ending: "-FCUSA", label: "FCUSA" },
    { ending: "-RAD", label: "RAD" },
  ],
  defaultLabel: "FGP",
};

export const EMPTY_EDITS: Edits = { pins: [], names: {} };

const SKEY = "mps.settings";
const EKEY = "mps.edits";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return structuredClone(fallback);
    const v = JSON.parse(raw);
    return Array.isArray(fallback) ? v : { ...structuredClone(fallback), ...v };
  } catch {
    return structuredClone(fallback);
  }
}
function write(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked: works for this session only */ }
}

export const loadSettings = (): Settings => {
  const s = read(SKEY, DEFAULT_SETTINGS);
  s.capacity = { ...DEFAULT_SETTINGS.capacity, ...s.capacity };
  return s;
};
export const saveSettings = (s: Settings) => write(SKEY, s);
export const loadEdits = (): Edits => read(EKEY, EMPTY_EDITS);
export const saveEdits = (e: Edits) => write(EKEY, e);

export const newId = () => Math.random().toString(36).slice(2, 10);
