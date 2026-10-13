// Unit demand forecast: finished goods from sales history, BOM components by exploding that forecast.
// Pure functions (no DOM) so the same code runs in the browser and in `npm run verify:forecast`.
//
// Method
//  1. Finished-good (FG) demand = sales-order lines by order date, per selling location and SKU.
//     Fulfilled and open orders both count; quotes, cancelled orders, tax/adjustment/fee lines and
//     drop-ships (Torginol) don't. "- Deactivated" SKUs are merged into the active SKU.
//  2. Baseline = average monthly units over the last N full months (default 3).
//  3. Each forecast month = baseline × seasonality(month) × growth, where growth is 1 for the rest
//     of the current year and (1 + growth %) for the next. The seasonality index is normalized to
//     average 1, so it only moves volume between months: the forecast year still totals
//     baseline × 12 × (1 + growth %). The current, partial month = actual to date + the forecast
//     for its remaining days.
//  4. Components = every month's FG qty (actual and forecast) exploded through all BOM levels.
//     Intermediates (components with their own BOM) and raw materials (no BOM) are both listed.
//     All component demand is planned at the manufacturing site; "driven by" keeps the location
//     whose sales created it.

import type { BomLine, Dataset } from "../data/model";

export const LOCATIONS = ["Aurora", "DFW", "Houston"] as const;
export const MFG_LOCATION = "Aurora";
export const UNASSIGNED_LOCATION = "Aurora";
export const FORECAST_END = "2027-12";

export interface ForecastSettings {
  growthPct: number;
  baselineMonths: number;
  /** Relative volume Jan..Dec (100 = average month). Normalized before use. */
  seasonality: number[];
  /** Divide the baseline by the baseline months' own seasonality, so a peak-season run-rate isn't
   *  carried into slow months. Off = the forecast year totals exactly baseline × 12 × growth. */
  deseasonalizeBaseline: boolean;
}

/** A starting guess (slower winter, peak late spring to early fall). Edit it in the app. */
export const DEFAULT_SEASONALITY = [70, 75, 90, 105, 115, 115, 115, 115, 110, 100, 85, 75];

export const DEFAULT_FORECAST_SETTINGS: ForecastSettings = {
  growthPct: 30,
  baselineMonths: 3,
  seasonality: DEFAULT_SEASONALITY,
  deseasonalizeBaseline: false,
};

const FEE_PATTERNS = [/surcharge/i, /discount/i, /^shipping\b/i, /^freight\b/i, /^handling\b/i];
const DROPSHIP_PATTERNS = [/per lb/i, /by lb/i, /ships from torginol/i];
const DROPSHIP_LOCATIONS = new Set(["torginol"]);

/** "50022 - Deactivated", " - Deactivated 2" → "50022", "" */
export const stripDeactivated = (s: string) => s.replace(/\s*-\s*Deactivated(\s*\d+)?\s*$/i, "").trim();

export type MonthKind = "actual" | "partial" | "forecast";
export interface Month { key: string; kind: MonthKind; label: string }
export interface Series {
  id: string;
  sku: string;
  name: string;
  /** FG: "Manufactured" (has a BOM) or "Resale". Component: "Intermediate" or "Raw". */
  type: "Manufactured" | "Resale" | "Intermediate" | "Raw";
  /** Where the demand is planned: selling location for FG, the manufacturing site for components. */
  location: string;
  /** Location whose sales created the demand (same as location for FG). */
  drivenBy: string;
  /** Units per month, aligned with Forecast.months. */
  m: number[];
  /** Average units per month over the baseline months. */
  baseline: number;
  /** Component only: BOM depth below the sold FG (1 = direct component). */
  level?: number;
}

export interface Forecast {
  months: Month[];
  baselineMonths: string[];
  latest: string; // newest order date in the data, YYYY-MM-DD
  partialFraction: number; // share of the current month still to forecast
  fg: Series[];
  components: Series[];
  /** Sales-order lines left out, by reason. */
  excluded: Record<"tax" | "fees" | "dropship" | "quotes", number>;
  blankLocationLines: number;
  mergedDeactivated: number;
  seasonFactor: number[]; // normalized, Jan..Dec
  baselineSeason: number; // mean normalized seasonality over the baseline months
  notes: string[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (k: string) => `${MONTHS[+k.slice(5, 7) - 1]} ${k.slice(2, 4)}`;
const nextMonth = (k: string) => {
  const y = +k.slice(0, 4);
  const m = +k.slice(5, 7);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
const prevMonth = (k: string) => {
  const y = +k.slice(0, 4);
  const m = +k.slice(5, 7);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const daysIn = (k: string) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)).getUTCDate();

/** Multi-level BOM explosion. Returns, per parent SKU, the gross quantity of every component
 *  (intermediates and raw) needed for one parent, and the shallowest level it appears at. */
export function bomExploder(bom: BomLine[]) {
  const children = new Map<string, BomLine[]>();
  for (const b of bom) {
    if (!b.parent || !b.component || !(b.qty > 0)) continue;
    const arr = children.get(b.parent);
    if (arr) arr.push(b);
    else children.set(b.parent, [b]);
  }
  const memo = new Map<string, Map<string, { qty: number; level: number }>>();
  const cycles = new Set<string>();
  const explode = (sku: string, stack: Set<string> = new Set()): Map<string, { qty: number; level: number }> => {
    const hit = memo.get(sku);
    if (hit) return hit;
    const out = new Map<string, { qty: number; level: number }>();
    const add = (c: string, qty: number, level: number) => {
      const cur = out.get(c);
      if (cur) { cur.qty += qty; cur.level = Math.min(cur.level, level); }
      else out.set(c, { qty, level });
    };
    stack.add(sku);
    for (const b of children.get(sku) ?? []) {
      add(b.component, b.qty, 1);
      if (!children.has(b.component)) continue;
      if (stack.has(b.component)) { cycles.add(`${sku} → ${b.component}`); continue; }
      for (const [c, x] of explode(b.component, stack)) add(c, x.qty * b.qty, x.level + 1);
    }
    stack.delete(sku);
    memo.set(sku, out);
    return out;
  };
  return { explode, hasBom: (sku: string) => children.has(sku), cycles };
}

export function buildForecast(ds: Pick<Dataset, "salesOrders" | "soLines" | "bom">, s: ForecastSettings): Forecast {
  const notes: string[] = [];
  const excluded: Forecast["excluded"] = { tax: 0, fees: 0, dropship: 0, quotes: 0 };
  const orders = new Map(ds.salesOrders.map((o) => [o.order, o]));
  const { explode, hasBom, cycles } = bomExploder(ds.bom);

  // Product names from the BOM (components don't appear on sales orders)
  const pname = new Map<string, string>();
  for (const b of ds.bom) {
    if (b.parentName) pname.set(b.parent, b.parentName);
    if (b.componentName) pname.set(b.component, b.componentName);
  }

  // 1. FG history: location|sku → month → units
  const hist = new Map<string, Map<string, number>>();
  const fgName = new Map<string, string>();
  let latest = "";
  let blankLocationLines = 0;
  let mergedDeactivated = 0;
  for (const l of ds.soLines) {
    const o = orders.get(l.order);
    if (!o || !o.orderDate) continue;
    if (o.isQuote || o.cancelled) { excluded.quotes++; continue; }
    if (l.kind !== "item") { excluded.tax++; continue; }
    const rawName = l.product;
    if (FEE_PATTERNS.some((p) => p.test(rawName)) || /^cartrover/i.test(l.sku)) { excluded.fees++; continue; }
    if (DROPSHIP_LOCATIONS.has(o.location.toLowerCase()) || DROPSHIP_PATTERNS.some((p) => p.test(rawName))) { excluded.dropship++; continue; }
    const sku = stripDeactivated(l.sku) || stripDeactivated(rawName);
    if (sku !== l.sku) mergedDeactivated++;
    const blank = o.location === "Unassigned" || !o.location;
    if (blank) blankLocationLines++;
    const loc = blank ? UNASSIGNED_LOCATION : o.location;
    const key = `${loc}|${sku}`;
    const month = o.orderDate.slice(0, 7);
    if (o.orderDate > latest) latest = o.orderDate;
    const name = stripDeactivated(rawName);
    if (!fgName.has(sku) || sku === l.sku) fgName.set(sku, name);
    let mm = hist.get(key);
    if (!mm) hist.set(key, (mm = new Map()));
    mm.set(month, (mm.get(month) ?? 0) + l.qty);
  }
  if (!latest) throw new Error("No usable sales-order lines found.");

  // 2. Timeline and baseline window
  const latestMonth = latest.slice(0, 7);
  const isMonthEnd = +latest.slice(8, 10) === daysIn(latestMonth);
  const lastFull = isMonthEnd ? latestMonth : prevMonth(latestMonth);
  const baselineMonths: string[] = [];
  for (let k = lastFull, i = 0; i < Math.max(1, Math.round(s.baselineMonths)); i++, k = prevMonth(k)) baselineMonths.unshift(k);
  let first = latestMonth;
  for (const mm of hist.values()) for (const k of mm.keys()) if (k < first) first = k;
  const months: Month[] = [];
  for (let k = first; k <= FORECAST_END; k = nextMonth(k)) {
    const kind: MonthKind = k < latestMonth || (k === latestMonth && isMonthEnd) ? "actual" : k === latestMonth ? "partial" : "forecast";
    months.push({ key: k, kind, label: monthLabel(k) });
  }
  const partialFraction = isMonthEnd ? 0 : (daysIn(latestMonth) - +latest.slice(8, 10)) / daysIn(latestMonth);
  if (baselineMonths[0] < first) notes.push(`Only ${months.filter((m) => m.key >= first && m.key <= lastFull).length} full months of history; the baseline averages over ${baselineMonths.length} anyway (missing months count as zero).`);

  // 3. Seasonality and growth
  const sv = Array.from({ length: 12 }, (_, i) => Math.max(0, +s.seasonality[i] || 0));
  const mean = sv.reduce((a, b) => a + b, 0) / 12 || 1;
  const seasonFactor = sv.map((v) => v / mean);
  const baselineSeason = baselineMonths.reduce((a, k) => a + seasonFactor[+k.slice(5, 7) - 1], 0) / baselineMonths.length || 1;
  const deseason = s.deseasonalizeBaseline ? 1 / baselineSeason : 1;
  const growthYear = String(+latestMonth.slice(0, 4) + 1);
  const factor = (k: string) => seasonFactor[+k.slice(5, 7) - 1] * deseason * (k.slice(0, 4) >= growthYear ? 1 + s.growthPct / 100 : 1);

  const fg: Series[] = [];
  for (const [key, mm] of hist) {
    const [loc, sku] = key.split("|");
    const baseline = baselineMonths.reduce((a, k) => a + (mm.get(k) ?? 0), 0) / baselineMonths.length;
    const m = months.map((mo) => {
      const act = mm.get(mo.key) ?? 0;
      if (mo.kind === "actual") return act;
      return act + baseline * factor(mo.key) * (mo.kind === "partial" ? partialFraction : 1);
    });
    fg.push({ id: key, sku, name: fgName.get(sku) ?? pname.get(sku) ?? sku, type: hasBom(sku) ? "Manufactured" : "Resale", location: loc, drivenBy: loc, m, baseline });
  }

  // 4. Explode every FG month (actual + forecast) into components, attributed to the selling location
  const comp = new Map<string, Series>();
  for (const f of fg) {
    if (f.type !== "Manufactured") continue;
    for (const [c, x] of explode(f.sku)) {
      const id = `${f.drivenBy}|${c}`;
      let row = comp.get(id);
      if (!row) {
        row = {
          id, sku: c, name: pname.get(c) ?? fgName.get(c) ?? c, type: hasBom(c) ? "Intermediate" : "Raw", location: MFG_LOCATION,
          drivenBy: f.drivenBy, m: months.map(() => 0), baseline: 0, level: x.level,
        };
        comp.set(id, row);
      }
      row.level = Math.min(row.level!, x.level);
      row.baseline += f.baseline * x.qty;
      for (let i = 0; i < months.length; i++) row.m[i] += f.m[i] * x.qty;
    }
  }
  const components = [...comp.values()];
  if (cycles.size) notes.push(`BOM loops skipped: ${[...cycles].slice(0, 5).join(", ")}.`);

  return {
    months, baselineMonths, latest, partialFraction, fg, components, excluded,
    blankLocationLines, mergedDeactivated, seasonFactor, baselineSeason, notes,
  };
}

/** Total units of a set of series over a set of month indexes. */
export function sumUnits(rows: Series[], idx: number[]): number {
  let q = 0;
  for (const r of rows) for (const i of idx) q += r.m[i];
  return q;
}

/** Roll rows up to one row per SKU (for the "All locations" view). */
export function rollupBySku(rows: Series[], location: string): Series[] {
  const out = new Map<string, Series>();
  for (const r of rows) {
    const cur = out.get(r.sku);
    if (!cur) {
      out.set(r.sku, { ...r, id: r.sku, location, drivenBy: "All", m: [...r.m] });
      continue;
    }
    cur.baseline += r.baseline;
    if (r.level != null) cur.level = Math.min(cur.level ?? r.level, r.level);
    for (let i = 0; i < r.m.length; i++) cur.m[i] += r.m[i];
  }
  return [...out.values()];
}
