// The master production schedule.
//
// 1. Products with an active BOM are Blends, Fills or Kits (from MO history, else from
//    the BOM's shape). Auto-built SKUs (MO-####) are never scheduled: their sales are
//    passed down to their components as demand.
// 2. Demand is the average daily sales over the last N weeks. Each item is planned to
//    cover `coverDays + safetyDays` of demand, with its reorder point as a minimum,
//    netted against available stock and rounded up to its typical batch size. Kits
//    then drive their fills, and fills their blends.
// 3. Batches are placed on workdays in priority order: deepest level first (blends,
//    then fills, then kits), each needing its components to be ready the same day or
//    earlier, room in its lane, and raw materials on hand. Batches that can't get raw
//    materials go to the shortage list; those that don't fit go to "didn't fit".

import type { BomLine, Dataset, StockRow } from "../data/model";
import type { Edits, Lane, Pin, Settings } from "../data/settings";
import { LANE_LABEL } from "../data/settings";
import type { Baselines } from "./baselines";
import { bomGallons, gallonsFromName, learnBaselines } from "./baselines";
import { addDays, countWorkdays, holidayMap, moStamp, nextWorkday, today, workdays } from "./dates";

export interface Item {
  sku: string;
  name: string;
  type: Lane;
  auto: boolean;
  comps: { sku: string; qty: number }[];
  parents: string[];
  /** Gallons per unit (fills); gallons per batch unit (blends = 1). */
  gpu: number;
  batch: number;
  stem: string;
  /** Low-level code: 0 = top of the BOM. */
  llc: number;
}

export interface Model {
  items: Map<string, Item>;
  stock: Map<string, StockRow>;
  names: Map<string, string>;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ---------- Item model ----------

export function buildModel(ds: Pick<Dataset, "bom" | "inventory">, base: Baselines): Model {
  const bomBy = new Map<string, BomLine[]>();
  for (const l of ds.bom) {
    if (!bomBy.has(l.parent)) bomBy.set(l.parent, []);
    bomBy.get(l.parent)!.push(l);
  }
  const names = new Map<string, string>();
  for (const l of ds.bom) { names.set(l.parent, l.parentName); if (!names.has(l.comp)) names.set(l.comp, l.compName); }
  for (const r of ds.inventory) names.set(r.sku, r.name);
  const stock = new Map(ds.inventory.map((r) => [r.sku, r]));
  const autoSet = new Set(base.auto);

  // Type: learned from MO history, else from the BOM's shape
  const typeMemo = new Map<string, Lane>();
  const typeOf = (sku: string, depth = 0): Lane => {
    const known = base.items[sku]?.type ?? typeMemo.get(sku);
    if (known) return known;
    const lines = bomBy.get(sku) ?? [];
    const made = lines.filter((l) => bomBy.has(l.comp));
    const compTypes = depth > 6 ? [] : made.map((l) => typeOf(l.comp, depth + 1));
    const name = names.get(sku) ?? "";
    let t: Lane;
    if (compTypes.some((x) => x === "FILL" || x === "KIT")) t = "KIT";
    else if (compTypes.includes("BLEND")) t = "FILL";
    else if (/blend/i.test(name)) t = "BLEND";
    else if (gallonsFromName(name) != null) t = "FILL";
    else {
      const bulk = lines.filter((l) => /^R\d/.test(l.comp)).reduce((a, l) => a + l.qty, 0);
      t = bulk > 0.8 && bulk < 1.2 && lines.every((l) => /^R\d/.test(l.comp)) ? "BLEND" : "FILL";
    }
    typeMemo.set(sku, t);
    return t;
  };

  const items = new Map<string, Item>();
  for (const [sku, lines] of bomBy) {
    const type = typeOf(sku);
    const b = base.items[sku];
    const name = names.get(sku) ?? sku;
    // Kits never seen in MO history: 10/15-gal kits and private-label kits are auto-built like their siblings
    const auto = autoSet.has(sku) || (!b && type === "KIT" && (/\b1[05][ -]?ga/i.test(name) || /-(I|CS|EW)$/i.test(sku)));
    items.set(sku, {
      sku, name, type, auto,
      comps: lines.map((l) => ({ sku: l.comp, qty: l.qty })),
      parents: [], gpu: 1, batch: b?.batch ?? 0, stem: b?.stem ?? "", llc: 0,
    });
  }
  for (const it of items.values()) for (const c of it.comps) items.get(c.sku)?.parents.push(it.sku);
  for (const it of items.values()) {
    if (it.type === "FILL") it.gpu = gallonsFromName(it.name) ?? bomGallons(it.sku, ds.bom, (s) => items.get(s)?.type === "BLEND");
  }
  // Fills made from other fills (HyperCure A uses a little 5-gal HyperFlex A): sum their gallons
  for (const it of items.values()) {
    if (it.type === "FILL" && !it.gpu) it.gpu = it.comps.reduce((g, c) => g + c.qty * (items.get(c.sku)?.type === "FILL" ? items.get(c.sku)!.gpu : 0), 0);
  }
  // Low-level codes: a component sits at least one level below every parent
  for (let pass = 0, changed = true; changed && pass < 12; pass++) {
    changed = false;
    for (const it of items.values()) for (const c of it.comps) {
      const ci = items.get(c.sku);
      if (ci && ci.llc < it.llc + 1) { ci.llc = it.llc + 1; changed = true; }
    }
  }
  return { items, stock, names };
}

// ---------- Plan ----------

export type Tier = "backorder" | "belowReorder" | "cover" | "feeds" | "locked" | "manual";

export interface Batch {
  id: string;
  sku: string;
  qty: number;
  /** Lower = more urgent. */
  key: number;
  tier: Tier;
  /** Days of supply before this batch (for the "why"). */
  cover: number | null;
  feeds: Set<string>;
  pin?: Pin;
  warnings?: string[];
}

export interface Mo {
  id: string;
  /** Key for a renamed MO: "SKU|date|n". */
  nameKey: string;
  sku: string;
  product: string;
  type: Lane;
  date: string;
  qty: number;
  gallons: number;
  name: string;
  defaultName: string;
  pinned: boolean;
  manual: boolean;
  why: string[];
  key: number;
  warnings: string[];
  batchIds: string[];
}

export interface Unplaced {
  sku: string;
  product: string;
  type: Lane;
  qty: number;
  reason: string;
  key: number;
}

export interface Shortage {
  sku: string;
  product: string;
  type: Lane;
  qtyBlocked: number;
  key: number;
  why: string[];
  /** component = a made item that is itself short (e.g. a 1-gal fill waiting on jugs). */
  missing: { sku: string; name: string; need: number; have: number; component: boolean }[];
}

export interface MaterialShort {
  sku: string;
  name: string;
  needed: number;
  available: number;
  short: number;
  onOrder: number;
  items: string[];
}

export interface Flag {
  sku: string;
  product: string;
  kind: "noSales" | "noBom" | "notFound";
  message: string;
  available: number;
  reorderPoint: number;
  suggested: number;
  suggestQty: number;
  added: boolean;
}

export interface ItemPlan {
  sku: string;
  product: string;
  type: Lane;
  available: number;
  reorderPoint: number;
  salesPerDay: number;
  viaAutoPerDay: number;
  dependentPerDay: number;
  coverDays: number | null;
  target: number;
  batch: number;
  planned: number;
  scheduled: number;
  blocked: number;
  unplaced: number;
}

export interface DayLoad {
  date: string;
  holidayNext?: string;
  blendStd: number;
  blendBig: number;
  fillGal: number;
  kits: number;
}

export interface Schedule {
  days: string[];
  closures: { date: string; name: string }[];
  salesFrom: string;
  salesTo: string;
  salesWorkdays: number;
  mos: Mo[];
  loads: DayLoad[];
  unplaced: Unplaced[];
  shortages: Shortage[];
  materials: MaterialShort[];
  flags: Flag[];
  plans: ItemPlan[];
  warnings: string[];
  model: Model;
}

export function moName(type: Lane, date: string, stem: string, sku: string, s: Settings): string {
  const label = type === "BLEND" ? "" : (s.labels.find((l) => l.ending && sku.toUpperCase().endsWith(l.ending.toUpperCase()))?.label ?? s.defaultLabel);
  return [type, moStamp(date), stem, label].filter(Boolean).join("-");
}

/** A name stem from the product name when there's no MO history: "3 Ga Kit HyperBond Tan" → "3GAKITHYPERBONDTAN". */
export const stemFromName = (name: string) => name.toUpperCase().replace(/®|™/g, "").replace(/[^A-Z0-9]+/g, "").slice(0, 40);

export function buildSchedule(ds: Dataset, base: Baselines, s: Settings, edits: Edits, now = today()): Schedule {
  const warnings: string[] = [];
  const model = buildModel(ds, base);
  const { items, stock } = model;
  const avail = (sku: string) => stock.get(sku)?.available ?? 0;
  const reorder = new Map(ds.reorder.map((r) => [r.sku.trim(), r]));

  // Calendar
  const y = +now.slice(0, 4);
  const hol = holidayMap([y - 1, y, y + 1], s.holidayRules, s.extraClosures);
  const start = s.startDate && s.startDate > now ? workdays(s.startDate, 1, hol)[0] : nextWorkday(now, hol);
  const days = workdays(start, s.horizonDays, hol);
  const closures = [...hol].filter(([d]) => d >= start && d <= days[days.length - 1]).map(([date, name]) => ({ date, name }));

  // Demand: average daily sales over the last N weeks of the sales file
  let salesTo = "";
  for (const r of ds.sales) if (r.date > salesTo) salesTo = r.date;
  const salesFrom = salesTo ? addDays(salesTo, -7 * s.demandWeeks + 1) : "";
  const salesWorkdays = salesTo ? Math.max(1, countWorkdays(salesFrom, salesTo, hol)) : 1;
  const sold = new Map<string, number>();
  for (const r of ds.sales) if (r.date >= salesFrom) sold.set(r.sku, (sold.get(r.sku) ?? 0) + r.qty);
  if (!ds.sales.length) warnings.push("No sales file loaded: demand is zero, so only reorder points and manual adds drive the plan.");

  const direct = new Map<string, number>();
  const viaAuto = new Map<string, number>();
  const push = (sku: string, rate: number, depth: number, fromAuto: boolean) => {
    const it = items.get(sku);
    if (it?.auto && depth < 6) {
      for (const c of it.comps) push(c.sku, rate * c.qty, depth + 1, true);
      return;
    }
    const m = fromAuto ? viaAuto : direct;
    m.set(sku, (m.get(sku) ?? 0) + rate);
  };
  for (const [sku, q] of sold) if (q > 0) push(sku, q / salesWorkdays, 0, false);
  const indepRate = (sku: string) => (direct.get(sku) ?? 0) + (viaAuto.get(sku) ?? 0);

  // Dependent demand rate (for days-of-supply only)
  const ordered = [...items.values()].filter((i) => !i.auto).sort((a, b) => a.llc - b.llc);
  const depRate = new Map<string, number>();
  for (const it of ordered) {
    const r = indepRate(it.sku) + (depRate.get(it.sku) ?? 0);
    if (r > 0) for (const c of it.comps) if (items.has(c.sku)) depRate.set(c.sku, (depRate.get(c.sku) ?? 0) + r * c.qty);
  }
  const totalRate = (sku: string) => indepRate(sku) + (depRate.get(sku) ?? 0);

  // Priority key for a projected stock level
  const keyFor = (sku: string, projected: number): { key: number; tier: Tier; cover: number | null } => {
    const rop = reorder.get(sku)?.reorderPoint ?? 0;
    const rate = totalRate(sku);
    const cover = rate > 0 ? Math.max(0, projected) / rate : null;
    if (projected < 0) return { key: -100000 + projected, tier: "backorder", cover };
    if (rop > 0 && projected < rop) return { key: -10000 + 1000 * (projected / rop), tier: "belowReorder", cover };
    return { key: cover ?? 999, tier: "cover", cover };
  };

  // Locked / manual quantities count as supply already planned
  const pinsBy = new Map<string, Pin[]>();
  for (const p of edits.pins) {
    if (!items.has(p.sku) || items.get(p.sku)!.auto) { warnings.push(`${p.sku}: locked or added MO ignored because it no longer has an active BOM (or is auto-built).`); continue; }
    if (p.date && !days.includes(p.date)) {
      if (!p.manual) continue; // a lock outside this two-week window has expired
    }
    if (!pinsBy.has(p.sku)) pinsBy.set(p.sku, []);
    pinsBy.get(p.sku)!.push(p);
  }

  // Net requirements, top of the BOM down, one level at a time. After each level, raw
  // materials go to its batches in priority order; a batch that can't get them is blocked
  // and asks nothing of the levels below.
  const batches = new Map<string, Batch[]>();
  const plans = new Map<string, ItemPlan>();
  const flags: Flag[] = [];
  const rawLeft = new Map<string, number>();
  const rawLeftOf = (sku: string) => rawLeft.get(sku) ?? avail(sku) + (s.countOnOrder ? stock.get(sku)?.onOrder ?? 0 : 0);
  const isMade = (sku: string) => items.has(sku) && !items.get(sku)!.auto;
  const blockedBatches: { b: Batch; missing: { sku: string; need: number; have: number }[] }[] = [];
  let seq = 0;
  const levels = [...new Set(ordered.map((i) => i.llc))].sort((a, b) => a - b);
  for (const lv of levels) {
  const atLevel = ordered.filter((i) => i.llc === lv);
  for (const it of atLevel) {
    const a = avail(it.sku);
    const rop = reorder.get(it.sku)?.reorderPoint ?? 0;
    const ir = indepRate(it.sku);
    const hasDemand = ir > 0 || (depRate.get(it.sku) ?? 0) > 0;
    let indepTarget = ir * (s.coverDays + s.safetyDays);
    if (s.useReorderFloor && rop > 0 && (ir > 0 || hasDemand)) indepTarget = Math.max(indepTarget, rop);

    // Demand stream: parents' batches (in their priority) + own sales in batch-size chunks
    const entries: { qty: number; key: number; tier: Tier; cover: number | null; from?: string }[] = [];
    for (const p of it.parents) {
      const pi = items.get(p);
      if (!pi || pi.auto) continue;
      const per = pi.comps.filter((c) => c.sku === it.sku).reduce((x, c) => x + c.qty, 0);
      for (const b of batches.get(p) ?? []) entries.push({ qty: b.qty * per, key: b.key, tier: "feeds", cover: null, from: p });
    }
    const pins = pinsBy.get(it.sku) ?? [];
    const pinnedQty = pins.reduce((x, p) => x + p.qty, 0);
    const own: Batch[] = pins.map((p) => ({
      id: `p${p.id}`, sku: it.sku, qty: p.qty, key: p.manual ? -2e6 : -3e6, tier: p.manual ? "manual" : "locked", cover: null, feeds: new Set(), pin: p,
    }));

    const totalNeed = entries.reduce((x, e) => x + e.qty, 0) + indepTarget;
    const batch = it.batch > 0 ? it.batch : Math.max(1, Math.ceil(totalNeed - a - pinnedQty));
    if (indepTarget > 0) {
      const chunks = Math.ceil(indepTarget / batch);
      for (let j = 0; j < chunks; j++) {
        const k = keyFor(it.sku, a + j * batch);
        entries.push({ qty: Math.min(batch, indepTarget - j * batch), ...k });
      }
    }
    if (a < 0) entries.push({ qty: 0, ...keyFor(it.sku, a) });
    entries.sort((x, y) => x.key - y.key);

    let cum = a + pinnedQty;
    for (const e of entries) {
      cum -= e.qty;
      while (cum < -1e-6) {
        // As urgent as the need it covers, or as its own stock level, whichever is sooner
        const ownKey = keyFor(it.sku, cum + e.qty);
        const useOwn = ownKey.key < e.key;
        own.push({
          id: `b${seq++}`, sku: it.sku, qty: batch,
          key: Math.min(e.key, ownKey.key), tier: useOwn ? ownKey.tier : e.tier, cover: useOwn ? ownKey.cover : e.cover,
          feeds: new Set(e.from ? [e.from] : []),
        });
        cum += batch;
      }
    }
    batches.set(it.sku, own);

    // No sales and below reorder point: flag rather than schedule
    const rr = reorder.get(it.sku);
    if (rr && !hasDemand && a < rop && rr.suggested > 0 && /manufact/i.test(rr.method)) {
      const want = Math.max(rr.suggested, rop - a);
      flags.push({
        sku: it.sku, product: it.name, kind: "noSales",
        message: `No sales in the last ${s.demandWeeks} weeks, but the reorder report suggests ${round(rr.suggested)}.`,
        available: a, reorderPoint: rop, suggested: rr.suggested,
        suggestQty: it.batch > 0 ? Math.ceil(want / it.batch) * it.batch : want,
        added: pins.some((p) => p.manual),
      });
    }
    const planned = own.reduce((x, b) => x + b.qty, 0);
    if (planned > 0 || hasDemand || rr) {
      const tr = totalRate(it.sku);
      plans.set(it.sku, {
        sku: it.sku, product: it.name, type: it.type, available: a, reorderPoint: rop,
        salesPerDay: round(direct.get(it.sku) ?? 0, 2), viaAutoPerDay: round(viaAuto.get(it.sku) ?? 0, 2),
        dependentPerDay: round(depRate.get(it.sku) ?? 0, 2), coverDays: tr > 0 ? round(Math.max(0, a) / tr) : null,
        target: round(indepTarget + entries.filter((e) => e.from).reduce((x, e) => x + e.qty, 0)),
        batch, planned, scheduled: 0, blocked: 0, unplaced: 0,
      });
    }
  }
  const ok = new Set<Batch>();
  for (const b of atLevel.flatMap((i) => batches.get(i.sku) ?? []).sort((x, y) => x.key - y.key)) {
    const raw = items.get(b.sku)!.comps.filter((c) => !isMade(c.sku));
    const missing = raw.map((c) => ({ sku: c.sku, need: b.qty * c.qty, have: rawLeftOf(c.sku) })).filter((m) => m.have < m.need - 1e-6);
    if (missing.length && !b.pin?.date) { blockedBatches.push({ b, missing }); continue; }
    // A locked day keeps its MO even when short; it carries a warning instead
    b.warnings = missing.map((m) => `Short ${round(m.need - Math.max(0, m.have))} of raw material ${m.sku}.`);
    for (const c of raw) rawLeft.set(c.sku, rawLeftOf(c.sku) - b.qty * c.qty);
    ok.add(b);
  }
  for (const it of atLevel) batches.set(it.sku, (batches.get(it.sku) ?? []).filter((b) => ok.has(b)));
  }

  // Reorder-report items that can't be scheduled
  for (const r of ds.reorder) {
    if (!/manufact/i.test(r.method)) continue;
    const sku = r.sku.trim();
    const it = items.get(sku);
    if (it?.auto) continue;
    if (!it) {
      flags.push({
        sku, product: r.name, kind: stock.has(sku) ? "noBom" : "notFound",
        message: stock.has(sku) ? "On the reorder report but has no active BOM, so it can't be scheduled." : "On the reorder report but the SKU isn't in the BOM or inventory files (check for a typo or trailing space).",
        available: avail(sku), reorderPoint: r.reorderPoint, suggested: r.suggested, suggestQty: 0, added: false,
      });
    }
  }

  // ---------- Place batches on days ----------
  const H = days.length;
  const loads: DayLoad[] = days.map((date) => ({ date, blendStd: 0, blendBig: 0, fillGal: 0, kits: 0 }));
  const produced = new Map<string, number[]>();
  const consumed = new Map<string, number>();
  const placed: { b: Batch; day: number; warnings: string[] }[] = [];
  const waiting: { b: Batch; late: { sku: string; need: number; have: number }[] }[] = [];
  const noRoom: Batch[] = [];
  const blockedSkus = new Set(blockedBatches.map((x) => x.b.sku));
  const cap = s.capacity;

  const isBig = (it: Item, qty: number) => it.type === "BLEND" && qty >= cap.bigThreshold;
  const fits = (it: Item, qty: number, d: number) => {
    const L = loads[d];
    if (it.type === "BLEND") return isBig(it, qty) ? L.blendBig < cap.blendBig : L.blendStd < cap.blendStd;
    // A single batch bigger than a whole day may take an empty day on its own
    if (it.type === "FILL") return L.fillGal === 0 || L.fillGal + qty * it.gpu <= cap.fillGal + 1e-6;
    return L.kits === 0 || L.kits + qty <= cap.kits;
  };
  const load = (it: Item, qty: number, d: number) => {
    const L = loads[d];
    if (it.type === "BLEND") isBig(it, qty) ? L.blendBig++ : L.blendStd++;
    else if (it.type === "FILL") L.fillGal += qty * it.gpu;
    else L.kits += qty;
  };
  // Stock of a component on day d: on hand + made through day d − already promised
  const readyBy = (sku: string, d: number) => avail(sku) + (produced.get(sku) ?? []).slice(0, d + 1).reduce((x, q) => x + q, 0) - (consumed.get(sku) ?? 0);

  // Deepest level first so blends are on the calendar before the fills that use them.
  // Locked batches go first in their level so they claim their day.
  for (const lv of [...levels].reverse()) {
    const list = ordered.filter((i) => i.llc === lv).flatMap((i) => batches.get(i.sku) ?? []);
    list.sort((a, b) => Number(!!b.pin?.date) - Number(!!a.pin?.date) || a.key - b.key);
    for (const b of list) {
      const it = items.get(b.sku)!;
      const made = it.comps.filter((c) => isMade(c.sku));
      const pinDay = b.pin?.date ? days.indexOf(b.pin.date) : -1;
      let day = -1;
      const warn = [...(b.warnings ?? [])];
      if (pinDay >= 0) {
        day = pinDay;
        if (!fits(it, b.qty, day)) warn.push(`Over ${LANE_LABEL[it.type].toLowerCase()} capacity on this day.`);
        for (const c of made) if (readyBy(c.sku, day) < b.qty * c.qty - 1e-6) warn.push(`Not enough ${c.sku} ready by this day.`);
      } else {
        for (let d = 0; d < H && day < 0; d++) {
          if (fits(it, b.qty, d) && made.every((c) => readyBy(c.sku, d) >= b.qty * c.qty - 1e-6)) day = d;
        }
      }
      if (day < 0) {
        const late = made.map((c) => ({ sku: c.sku, need: b.qty * c.qty, have: readyBy(c.sku, H - 1) })).filter((c) => c.have < c.need - 1e-6);
        if (late.length) waiting.push({ b, late });
        else noRoom.push(b);
        continue;
      }
      for (const c of made) consumed.set(c.sku, (consumed.get(c.sku) ?? 0) + b.qty * c.qty);
      if (!produced.has(b.sku)) produced.set(b.sku, Array(H).fill(0));
      produced.get(b.sku)![day] += b.qty;
      load(it, b.qty, day);
      placed.push({ b, day, warnings: warn });
    }
  }

  // ---------- MOs: batches of one SKU on one day become one MO ----------
  const why = (b: Batch, it: Item): string[] => {
    const out: string[] = [];
    const a = avail(it.sku);
    const rop = reorder.get(it.sku)?.reorderPoint ?? 0;
    if (b.tier === "locked") out.push("Locked to this day.");
    if (b.tier === "manual") out.push("Added manually.");
    if (a < 0) out.push(`Available is ${round(a)} (more reserved than on hand).`);
    else if (rop > 0 && a < rop) out.push(`Available ${round(a)} is below the reorder point of ${round(rop)}.`);
    const tr = totalRate(it.sku);
    if (tr > 0) out.push(`${round(Math.max(0, a) / tr)} days of supply left at ${round(tr, 1)}/day.`);
    const va = viaAuto.get(it.sku) ?? 0;
    if (va > 0) out.push(`${round(va, 1)}/day of its demand comes from auto-built kits (15-gal or private label).`);
    for (const f of b.feeds) out.push(`Feeds ${items.get(f)?.type === "KIT" ? "kit" : items.get(f)?.type === "FILL" ? "fill" : "blend"} ${f} ${items.get(f)?.name ?? ""}.`);
    return out;
  };
  const groups = new Map<string, { list: typeof placed; pinned: boolean }>();
  for (const p of placed) {
    const pinned = !!p.b.pin;
    // Each blend batch is its own tank run; fills and kits of one SKU on one day are one MO
    const k = pinned ? `pin:${p.b.pin!.id}` : items.get(p.b.sku)!.type === "BLEND" ? p.b.id : `${p.b.sku}|${p.day}`;
    if (!groups.has(k)) groups.set(k, { list: [], pinned });
    groups.get(k)!.list.push(p);
  }
  const mos: Mo[] = [];
  const sameDay = new Map<string, number>();
  for (const [k, g] of [...groups].sort((a, b) => Math.min(...a[1].list.map((p) => p.b.key)) - Math.min(...b[1].list.map((p) => p.b.key)))) {
    const first = g.list[0];
    const it = items.get(first.b.sku)!;
    const date = days[first.day];
    const qty = round(g.list.reduce((x, p) => x + p.b.qty, 0), 2);
    // A second run of the same SKU on the same day gets "-2" on its name stem
    const n = (sameDay.get(`${it.sku}|${date}`) ?? 0) + 1;
    sameDay.set(`${it.sku}|${date}`, n);
    const stem = (it.stem || stemFromName(it.name)) + (n > 1 ? `-${n}` : "");
    const defaultName = moName(it.type, date, stem, it.sku, s);
    const nameKey = `${it.sku}|${date}|${n}`;
    const reasons = new Set<string>();
    for (const p of g.list) for (const w of why(p.b, it)) reasons.add(w);
    mos.push({
      id: g.pinned ? k : nameKey, nameKey, sku: it.sku, product: it.name, type: it.type, date, qty, gallons: it.type === "FILL" ? round(qty * it.gpu) : it.type === "BLEND" ? qty : 0,
      name: edits.names[nameKey] || defaultName, defaultName,
      pinned: g.pinned && !first.b.pin!.manual, manual: g.pinned && first.b.pin!.manual,
      why: [...reasons], key: Math.min(...g.list.map((p) => p.b.key)), warnings: g.list.flatMap((p) => p.warnings),
      batchIds: g.list.map((p) => p.b.id),
    });
  }
  const laneOrder = { BLEND: 0, FILL: 1, KIT: 2 };
  mos.sort((a, b) => a.date.localeCompare(b.date) || laneOrder[a.type] - laneOrder[b.type] || a.key - b.key);

  // ---------- Shortages ----------
  // Blocked: can't get a raw material. Waiting: needs a made component that is itself blocked.
  const shortBy = new Map<string, Shortage>();
  const matNeed = new Map<string, { need: number; items: Set<string> }>();
  const shortOf = (b: Batch) => {
    const it = items.get(b.sku)!;
    let sh = shortBy.get(b.sku);
    if (!sh) shortBy.set(b.sku, (sh = { sku: b.sku, product: it.name, type: it.type, qtyBlocked: 0, key: b.key, why: why(b, it), missing: [] }));
    sh.qtyBlocked = round(sh.qtyBlocked + b.qty, 2);
    sh.key = Math.min(sh.key, b.key);
    return sh;
  };
  const addMissing = (sh: Shortage, m: { sku: string; need: number; have: number }, component: boolean) => {
    const ex = sh.missing.find((x) => x.sku === m.sku);
    if (ex) ex.need = round(ex.need + m.need, 2);
    else sh.missing.push({ sku: m.sku, name: model.names.get(m.sku) ?? m.sku, need: round(m.need, 2), have: round(m.have, 2), component });
  };
  for (const { b, missing } of blockedBatches) {
    const sh = shortOf(b);
    for (const m of missing) {
      addMissing(sh, m, false);
      const mn = matNeed.get(m.sku) ?? { need: 0, items: new Set<string>() };
      mn.need += m.need;
      mn.items.add(b.sku);
      matNeed.set(m.sku, mn);
    }
  }
  const unplacedBy = new Map<string, Unplaced>();
  const addUnplaced = (b: Batch, reason: string) => {
    const it = items.get(b.sku)!;
    const k = `${b.sku}|${reason}`;
    const u = unplacedBy.get(k);
    if (u) { u.qty = round(u.qty + b.qty, 2); u.key = Math.min(u.key, b.key); }
    else unplacedBy.set(k, { sku: b.sku, product: it.name, type: it.type, qty: b.qty, reason, key: b.key });
  };
  // A component counts as blocked if it, or anything it is made from, is short
  const blockedDeep = (sku: string, depth = 0): boolean =>
    blockedSkus.has(sku) || (depth < 6 && (items.get(sku)?.comps ?? []).some((c) => isMade(c.sku) && blockedDeep(c.sku, depth + 1)));
  for (const { b, late } of waiting) {
    const blockedLate = late.filter((c) => blockedDeep(c.sku));
    if (blockedLate.length) {
      const sh = shortOf(b);
      for (const c of blockedLate) addMissing(sh, c, true);
      blockedSkus.add(b.sku);
    } else {
      addUnplaced(b, `Waiting on ${late.map((c) => c.sku).join(", ")}: not enough can be made in time within ${H} days.`);
    }
  }
  for (const b of noRoom) addUnplaced(b, `No ${LANE_LABEL[items.get(b.sku)!.type].toLowerCase()} capacity left within ${H} days.`);
  const unplaced = [...unplacedBy.values()].sort((a, b) => a.key - b.key);
  const materials: MaterialShort[] = [...matNeed].map(([sku, m]) => {
    const left = Math.max(0, rawLeftOf(sku));
    return {
      sku, name: model.names.get(sku) ?? sku, needed: round(m.need, 2), available: round(avail(sku), 2),
      short: round(Math.max(0, m.need - left), 2), onOrder: stock.get(sku)?.onOrder ?? 0, items: [...m.items],
    };
  }).filter((m) => m.short > 0).sort((a, b) => b.short - a.short);
  const shortages = [...shortBy.values()].sort((a, b) => a.key - b.key);

  for (const m of mos) { const p = plans.get(m.sku); if (p) p.scheduled += m.qty; }
  for (const u of unplaced) { const p = plans.get(u.sku); if (p) p.unplaced += u.qty; }
  for (const sh of shortages) { const p = plans.get(sh.sku); if (p) p.blocked += sh.qtyBlocked; }

  return {
    days, closures, salesFrom, salesTo, salesWorkdays, mos, loads, unplaced,
    shortages, materials, flags, plans: [...plans.values()].filter((p) => p.planned > 0 || p.salesPerDay > 0 || p.viaAutoPerDay > 0),
    warnings, model,
  };
}

/** Baselines from an uploaded MO history (two passes: types first, then fill gallons for capacity). */
export function baselinesFrom(ds: Dataset, builtIn: Baselines): Baselines {
  if (!ds.moHistory.length) return builtIn;
  const first = learnBaselines(ds.moHistory);
  const model = buildModel(ds, first);
  const base = learnBaselines(ds.moHistory, (sku) => model.items.get(sku)?.gpu ?? 0);
  return { ...base, source: `Uploaded MO history, ${base.from} to ${base.to}` };
}
