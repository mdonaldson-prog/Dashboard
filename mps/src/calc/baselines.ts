// What the planner learns from completed MO history: each SKU's MO type, its typical
// batch size, the name stem you use for it, which SKUs are auto-built (MO-####), and
// daily capacity. A copy learned from Jun–Oct 2026 history is built in (baselines.json);
// uploading a newer MO history re-learns it.

import type { BomLine, MoRow } from "../data/model";
import type { Capacity, Lane } from "../data/settings";
import { countWorkdays } from "./dates";

export interface ItemBaseline {
  type: Lane;
  /** Median quantity per MO. */
  batch: number;
  /** Name stem from your most recent MO, e.g. "SGLOWODOR3GALKIT". */
  stem: string;
  mos: number;
}

export interface Baselines {
  source: string;
  from: string;
  to: string;
  items: Record<string, ItemBaseline>;
  /** SKUs only ever built as MO-#### after a sales order is picked. */
  auto: string[];
  capacity: Capacity | null;
}

const LABEL_SUFFIX = /-(FGP|GFP|INTEGRITY|CORESOURCE|EPOXYWORX|THEGARAGEFLOORCOMPANY|GFC|FCUSA|RAD|EW|CS)$/i;

/** MO type from the TYPE column, else from the MO number prefix (typos included). */
export function moType(r: MoRow): Lane | "AUTO" | null {
  if (r.type === "BLEND" || r.type === "FILL" || r.type === "KIT") return r.type;
  const p = (r.mo.match(/^([A-Za-z]+)/)?.[1] ?? "").toUpperCase();
  if (p === "MO") return "AUTO";
  if (p.startsWith("BLEND")) return "BLEND";
  if (/^R?FIL+/.test(p)) return "FILL";
  if (/^KI+K?TS?$/.test(p)) return "KIT";
  return null;
}

/** "KIT-262907-SGLOWODOR3GALKIT-FGP" → "SGLOWODOR3GALKIT" */
export function stemOf(mo: string): string {
  const m = mo.match(/^[A-Za-z]+[-=/]?\d{6}-(.+)$/);
  if (!m) return "";
  return m[1].replace(LABEL_SUFFIX, "").replace(/[^A-Za-z0-9'()/&.-]/g, "").toUpperCase();
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};

export function learnBaselines(rows: MoRow[], gallonsPerUnit?: (sku: string) => number, source = "Completed MO history"): Baselines {
  const bySku = new Map<string, { types: Map<string, number>; qtys: number[]; last: MoRow | null }>();
  let from = "9999", to = "";
  for (const r of rows) {
    const t = moType(r);
    if (!t || r.qty <= 0) continue;
    if (r.completed < from) from = r.completed;
    if (r.completed > to) to = r.completed;
    let e = bySku.get(r.sku);
    if (!e) bySku.set(r.sku, (e = { types: new Map(), qtys: [], last: null }));
    e.types.set(t, (e.types.get(t) ?? 0) + 1);
    if (t !== "AUTO") {
      e.qtys.push(r.qty);
      if (stemOf(r.mo) && (!e.last || r.completed >= e.last.completed)) e.last = r;
    }
  }
  const items: Record<string, ItemBaseline> = {};
  const auto: string[] = [];
  for (const [sku, e] of bySku) {
    const scheduled = [...e.types].filter(([t]) => t !== "AUTO").sort((a, b) => b[1] - a[1]);
    if (!scheduled.length) { auto.push(sku); continue; }
    items[sku] = {
      type: scheduled[0][0] as Lane,
      batch: scheduled[0][0] === "BLEND" ? Math.round(median(e.qtys) * 10) / 10 : Math.max(1, Math.round(median(e.qtys))),
      stem: e.last ? stemOf(e.last.mo) : "",
      mos: e.qtys.length,
    };
  }

  // Capacity: standard blends at the median day, fill gallons and kits at a good (75th percentile) day
  let capacity: Capacity | null = null;
  if (to) {
    const days = new Map<string, { std: number; big: number; gal: number; kits: number }>();
    const none = new Map<string, string>();
    const n = countWorkdays(from, to, none);
    const day = (d: string) => days.get(d) ?? (days.set(d, { std: 0, big: 0, gal: 0, kits: 0 }), days.get(d)!);
    for (const r of rows) {
      const it = items[r.sku];
      if (!it || r.qty <= 0 || moType(r) === "AUTO") continue;
      const d = day(r.completed);
      if (it.type === "BLEND") r.qty >= 1000 ? d.big++ : d.std++;
      else if (it.type === "FILL") d.gal += r.qty * (gallonsPerUnit?.(r.sku) ?? 0);
      else d.kits += r.qty;
    }
    const all = (f: (x: { std: number; big: number; gal: number; kits: number }) => number) => {
      const v = [...days.values()].map(f);
      while (v.length < n) v.push(0);
      return v;
    };
    capacity = {
      blendStd: Math.max(1, Math.round(median(all((x) => x.std)))),
      blendBig: Math.max(1, Math.max(...all((x) => x.big))),
      bigThreshold: 1000,
      fillGal: Math.round(quantile(all((x) => x.gal), 0.75) / 5) * 5,
      kits: Math.round(quantile(all((x) => x.kits), 0.75) / 5) * 5,
    };
  }
  return { source, from, to, items, auto: auto.sort(), capacity };
}

/** Gallons in one unit of a filled product: from its name ("5 Ga", "1 Gallon", "Quart"), else from its BOM. */
export function gallonsFromName(name: string): number | null {
  const n = name.toLowerCase();
  const m = n.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:ga\b|gal\b|gal\.|gallon|ga\.)/);
  if (m) return parseFloat(m[1]);
  if (/\b(quart|qt)\b/.test(n)) return 0.25;
  const oz = n.match(/(\d+)\s*oz/);
  if (oz) return +oz[1] / 128;
  return null;
}

export function bomGallons(sku: string, bom: BomLine[], isBulk: (sku: string) => boolean): number {
  let g = 0;
  for (const l of bom) if (l.parent === sku && (isBulk(l.comp) || /^R\d/.test(l.comp)) && l.qty >= 0.2) g += l.qty;
  return g;
}
