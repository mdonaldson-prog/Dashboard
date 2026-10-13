// Demand forecast: finished goods from sales history, BOM components by exploding that forecast.
// Pure functions (no DOM) so the same code runs in the browser and in `npm run verify:forecast`.
//
// Method
//  1. Finished-good (FG) demand = sales-order lines by order date, per selling location and SKU.
//     Fulfilled and open orders both count; quotes, cancelled orders, tax/adjustment/fee lines and
//     drop-ships (Torginol) don't. "- Deactivated" SKUs are merged into the active SKU.
//  2. Baseline = average monthly qty and $ over the last N full months (default 3).
//  3. Each forecast month = baseline × seasonality(month) × growth, where growth is 1 for the rest
//     of the current year and (1 + growth %) for the next. The seasonality index is normalized to
//     average 1, so it only moves volume between months: the forecast year still totals
//     baseline × 12 × (1 + growth %). The current, partial month = actual to date + the forecast
//     for its remaining days.
//  4. Components = every month's FG qty (actual and forecast) exploded through all BOM levels.
//     Intermediates (components with their own BOM) and raw materials (no BOM) are both listed.
//     All component demand is planned at the manufacturing site; "driven by" keeps the location
//     whose sales created it.

import type { BomLine, Dataset, Product, SoLine } from "../data/model";

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
export interface QA { q: number; a: number }

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
  /** Per month key, aligned with Forecast.months. */
  m: QA[];
  baseline: QA;
  /** Unit price used for $: average sales price (FG) or product cost (components). NaN = unknown. */
  unitPrice: number;
  /** Component only: BOM depth below the sold FG (1 = direct component). */
  level?: number;
}

export interface Exclusions { lines: number; amount: number }

export interface Forecast {
  months: Month[];
  baselineMonths: string[];
  latest: string; // newest order date in the data, YYYY-MM-DD
  partialFraction: number; // share of the current month still to forecast
  fg: Series[];
  components: Series[];
  hasPrices: boolean;
  componentsWithoutCost: number;
  excluded: Record<"tax" | "fees" | "dropship" | "quotes", Exclusions>;
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

export function buildForecast(ds: Pick<Dataset, "salesOrders" | "soLines" | "bom" | "products">, s: ForecastSettings): Forecast {
  const notes: string[] = [];
  const excluded: Forecast["excluded"] = {
    tax: { lines: 0, amount: 0 }, fees: { lines: 0, amount: 0 }, dropship: { lines: 0, amount: 0 }, quotes: { lines: 0, amount: 0 },
  };
  const orders = new Map(ds.salesOrders.map((o) => [o.order, o]));
  const { explode, hasBom, cycles } = bomExploder(ds.bom);

  // Product cost (for components) and names, keyed by the active SKU
  const cost = new Map<string, number>();
  const pname = new Map<string, string>();
  for (const b of ds.bom) {
    if (b.parentName) pname.set(b.parent, b.parentName);
    if (b.componentName) pname.set(b.component, b.componentName);
  }
  for (const p of ds.products as Product[]) {
    const sku = stripDeactivated(p.sku);
    if (!sku) continue;
    if (!pname.has(sku) || p.isActive) pname.set(sku, stripDeactivated(p.name));
    if (p.cost > 0 && (!cost.has(sku) || p.isActive)) cost.set(sku, p.cost);
  }

  // 1. FG history: location|sku → month → qty/$
  const hist = new Map<string, Map<string, QA>>();
  const fgName = new Map<string, string>();
  let latest = "";
  let blankLocationLines = 0;
  let mergedDeactivated = 0;
  const bump = (e: Exclusions, l: SoLine) => { e.lines++; e.amount += l.subtotal; };
  for (const l of ds.soLines) {
    const o = orders.get(l.order);
    if (!o || !o.orderDate) continue;
    if (o.isQuote || o.cancelled) { bump(excluded.quotes, l); continue; }
    if (l.kind !== "item") { bump(excluded.tax, l); continue; }
    const rawName = l.product;
    if (FEE_PATTERNS.some((p) => p.test(rawName)) || /^cartrover/i.test(l.sku)) { bump(excluded.fees, l); continue; }
    if (DROPSHIP_LOCATIONS.has(o.location.toLowerCase()) || DROPSHIP_PATTERNS.some((p) => p.test(rawName))) { bump(excluded.dropship, l); continue; }
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
    const cur = mm.get(month);
    if (cur) { cur.q += l.qty; cur.a += l.subtotal; }
    else mm.set(month, { q: l.qty, a: l.subtotal });
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
    const base: QA = { q: 0, a: 0 };
    for (const k of baselineMonths) {
      const x = mm.get(k);
      if (x) { base.q += x.q; base.a += x.a; }
    }
    base.q /= baselineMonths.length;
    base.a /= baselineMonths.length;
    let tq = 0, ta = 0;
    for (const x of mm.values()) { tq += x.q; ta += x.a; }
    const unitPrice = base.q > 0 ? base.a / base.q : tq > 0 ? ta / tq : NaN;
    const m = months.map<QA>((mo) => {
      const act = mm.get(mo.key) ?? { q: 0, a: 0 };
      if (mo.kind === "actual") return { q: act.q, a: act.a };
      const f = factor(mo.key) * (mo.kind === "partial" ? partialFraction : 1);
      return { q: act.q + base.q * f, a: act.a + base.a * f };
    });
    fg.push({ id: key, sku, name: fgName.get(sku) ?? pname.get(sku) ?? sku, type: hasBom(sku) ? "Manufactured" : "Resale", location: loc, drivenBy: loc, m, baseline: base, unitPrice });
  }

  // 4. Explode every FG month (actual + forecast) into components, attributed to the selling location
  const comp = new Map<string, Series>();
  for (const f of fg) {
    if (f.type !== "Manufactured") continue;
    for (const [c, x] of explode(f.sku)) {
      const id = `${f.drivenBy}|${c}`;
      let row = comp.get(id);
      if (!row) {
        const unit = cost.get(c) ?? NaN;
        row = {
          id, sku: c, name: pname.get(c) ?? fgName.get(c) ?? c, type: hasBom(c) ? "Intermediate" : "Raw", location: MFG_LOCATION,
          drivenBy: f.drivenBy, m: months.map(() => ({ q: 0, a: 0 })), baseline: { q: 0, a: 0 }, unitPrice: unit, level: x.level,
        };
        comp.set(id, row);
      }
      row.level = Math.min(row.level!, x.level);
      row.baseline.q += f.baseline.q * x.qty;
      for (let i = 0; i < months.length; i++) row.m[i].q += f.m[i].q * x.qty;
    }
  }
  const components = [...comp.values()];
  for (const r of components) {
    const u = isNaN(r.unitPrice) ? 0 : r.unitPrice;
    r.baseline.a = r.baseline.q * u;
    for (const x of r.m) x.a = x.q * u;
  }
  const hasPrices = cost.size > 0;
  const componentsWithoutCost = new Set(components.filter((r) => isNaN(r.unitPrice)).map((r) => r.sku)).size;
  if (cycles.size) notes.push(`BOM loops skipped: ${[...cycles].slice(0, 5).join(", ")}.`);

  return {
    months, baselineMonths, latest, partialFraction, fg, components, hasPrices, componentsWithoutCost, excluded,
    blankLocationLines, mergedDeactivated, seasonFactor, baselineSeason, notes,
  };
}

/** Sum of a set of series over a set of month indexes. */
export function sumQA(rows: Series[], idx: number[]): QA {
  let q = 0, a = 0;
  for (const r of rows) for (const i of idx) { q += r.m[i].q; a += r.m[i].a; }
  return { q, a };
}

/** Roll rows up to one row per SKU (for the "All locations" view). */
export function rollupBySku(rows: Series[], location: string): Series[] {
  const out = new Map<string, Series>();
  for (const r of rows) {
    const cur = out.get(r.sku);
    if (!cur) {
      out.set(r.sku, { ...r, id: r.sku, location, drivenBy: "All", m: r.m.map((x) => ({ ...x })), baseline: { ...r.baseline } });
      continue;
    }
    cur.baseline.q += r.baseline.q;
    cur.baseline.a += r.baseline.a;
    if (r.level != null) cur.level = Math.min(cur.level ?? r.level, r.level);
    for (let i = 0; i < r.m.length; i++) { cur.m[i].q += r.m[i].q; cur.m[i].a += r.m[i].a; }
  }
  for (const r of out.values()) if (r.type === "Manufactured" || r.type === "Resale") r.unitPrice = r.baseline.q > 0 ? r.baseline.a / r.baseline.q : r.unitPrice;
  return [...out.values()];
}
