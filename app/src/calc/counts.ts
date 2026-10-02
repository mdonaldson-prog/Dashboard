// Velocity-based cycle count schedule. One count = one SKU at one location (all its bins).
// The dashboard only plans counts; counting is done and recorded in inFlow.

import type { Settings, VelocityClass } from "../data/settings";
import type { Ctx } from "./context";
import { addDays, dayOfWeek, mondayOf } from "./dates";

export const CLASSES: VelocityClass[] = ["fast", "medium", "slow", "dormant"];
export const CLASS_LABEL: Record<VelocityClass, string> = { fast: "Fast", medium: "Medium", slow: "Slow", dormant: "Dormant" };

export interface SkuVelocity {
  sku: string;
  product: string;
  location: string;
  transactions: number;
  rank: number;
  cumulativePct: number;
  computedClass: VelocityClass;
  cls: VelocityClass; // after overrides
  overridden: boolean;
  onHand: number;
  sublocations: string[];
  lastCounted: string; // "" = never
  due: string;
}

export interface ScheduledCount {
  sku: string;
  product: string;
  cls: VelocityClass;
  due: string;
  date: string; // "" = could not be placed in the horizon
  atRisk: boolean; // placed outside its window, or not placed
  sublocations: string[];
  lastCounted: string;
}

export interface LocationPlan {
  location: string;
  active: boolean;
  capacity: number;
  skus: SkuVelocity[];
  classCounts: Record<VelocityClass, number>;
  requiredPerDay: number;
  levers: { label: string; perDay: number }[];
  days: string[];
  byDay: Map<string, ScheduledCount[]>;
  unplaced: ScheduledCount[];
  atRisk: number;
  withinCadence: Record<VelocityClass, { ok: number; total: number }>;
  start: string;
}

const isCountable = (itemType: string | undefined) => !itemType || /^stocked/i.test(itemType);

/** Transactions per SKU × location over the lookback window. */
function transactionCounts(c: Ctx, s: Settings, end: string) {
  const start = addDays(end, -s.counts.lookbackDays);
  const tx = new Map<string, number>();
  const add = (loc: string, sku: string, n = 1) => {
    if (!loc || !sku) return;
    const k = `${loc}|${sku}`;
    tx.set(k, (tx.get(k) ?? 0) + n);
  };
  const inWin = (d: string) => d > start && d <= end;
  for (const o of c.orders.values()) {
    if (o.isQuote || o.cancelled || !inWin(o.orderDate)) continue;
    const loc = o.location === "Unassigned" ? s.unassignedSalesLocation : o.location;
    for (const l of c.linesByOrder.get(o.order) ?? []) if (l.kind === "item") add(loc, l.sku);
  }
  const bomBy = new Map<string, string[]>();
  for (const b of c.ds.bom) {
    const arr = bomBy.get(b.parent);
    if (arr) arr.push(b.component);
    else bomBy.set(b.parent, [b.component]);
  }
  for (const m of c.ds.mfgOrders) {
    if (!inWin(m.completedDate)) continue;
    add(s.mfgLocation, m.sku);
    for (const comp of bomBy.get(m.sku) ?? []) add(s.mfgLocation, comp);
  }
  for (const t of c.ds.transfers) {
    const d = t.sent || t.transferDate;
    if (!inWin(d)) continue;
    add(t.from, t.sku);
    add(t.to, t.sku);
  }
  return tx;
}

function workingDays(s: Settings, start: string, weeks: number): string[] {
  const out: string[] = [];
  const black = new Set([...s.counts.blackouts, ...s.holidays]);
  for (let d = start; d < addDays(start, weeks * 7); d = addDays(d, 1)) {
    if (s.counts.workingDays.includes(dayOfWeek(d)) && !black.has(d)) out.push(d);
  }
  return out;
}

export function classify(c: Ctx, s: Settings, fastCutoff = s.counts.fastCutoff) {
  const end = c.latest;
  const tx = transactionCounts(c, s, end);
  const lastCount = new Map<string, string>();
  for (const l of c.ds.countLines) {
    if (l.counted === null) continue;
    const k = `${l.location}|${l.sku}`;
    if ((lastCount.get(k) ?? "") < l.started) lastCount.set(k, l.started);
  }
  // Universe: SKUs at each location in Stock Levels (stocked products only)
  const atLoc = new Map<string, Map<string, { product: string; onHand: number; subs: Set<string> }>>();
  for (const x of c.ds.stockLevels) {
    if (!isCountable(c.product(x.sku, x.product)?.itemType)) continue;
    const m = atLoc.get(x.location) ?? new Map();
    atLoc.set(x.location, m);
    const e = m.get(x.sku) ?? { product: x.product, onHand: 0, subs: new Set<string>() };
    e.onHand += x.qty;
    if (x.sublocation) e.subs.add(x.sublocation);
    m.set(x.sku, e);
  }
  const result = new Map<string, SkuVelocity[]>();
  for (const [loc, skus] of atLoc) {
    const moving = [...skus.entries()]
      .map(([sku, e]) => ({ sku, e, t: tx.get(`${loc}|${sku}`) ?? 0 }))
      .filter((x) => x.t > 0)
      .sort((a, b) => b.t - a.t || a.sku.localeCompare(b.sku));
    const total = moving.reduce((a, b) => a + b.t, 0);
    let cum = 0;
    const list: SkuVelocity[] = [];
    moving.forEach((x, i) => {
      const before = total ? (cum / total) * 100 : 0;
      cum += x.t;
      // A SKU is Fast if the cumulative share *before* it is under the cutoff (so the top SKU is always Fast)
      const computed: VelocityClass = before < fastCutoff ? "fast" : before < s.counts.mediumCutoff ? "medium" : "slow";
      list.push(mk(loc, x.sku, x.e, x.t, i + 1, total ? (cum / total) * 100 : 0, computed));
    });
    for (const [sku, e] of skus) {
      if (tx.get(`${loc}|${sku}`)) continue;
      if (e.onHand === 0) continue; // no movement and nothing on hand: left off
      list.push(mk(loc, sku, e, 0, 0, 100, "dormant"));
    }
    result.set(loc, list);
  }
  return result;

  function mk(loc: string, sku: string, e: { product: string; onHand: number; subs: Set<string> }, t: number, rank: number, cumPct: number, computed: VelocityClass): SkuVelocity {
    const ov = s.velocityOverrides[`${loc}|${sku}`];
    const cls = ov ?? computed;
    const last = lastCount.get(`${loc}|${sku}`) ?? "";
    return {
      sku, product: e.product, location: loc, transactions: t, rank, cumulativePct: cumPct, computedClass: computed, cls, overridden: !!ov,
      onHand: e.onHand, sublocations: [...e.subs].sort(), lastCounted: last, due: last ? addDays(last, s.counts.cadenceWeeks[cls] * 7) : "",
    };
  }
}

const requiredPerDay = (counts: Record<VelocityClass, number>, s: Settings) =>
  CLASSES.reduce((a, k) => a + counts[k] / (s.counts.cadenceWeeks[k] * s.counts.workingDays.length), 0);

const countBy = (list: SkuVelocity[]) => {
  const r = { fast: 0, medium: 0, slow: 0, dormant: 0 } as Record<VelocityClass, number>;
  for (const x of list) r[x.cls]++;
  return r;
};

export function planCounts(c: Ctx, s: Settings): LocationPlan[] {
  const classes = classify(c, s);
  const alt = classify(c, s, 70);
  // Schedule starts on the Monday after the latest data
  const start = addDays(mondayOf(c.latest), 7);
  const days = workingDays(s, start, s.counts.horizonWeeks);
  const end = addDays(start, s.counts.horizonWeeks * 7);
  const plans: LocationPlan[] = [];

  for (const loc of c.locations) {
    const ls = s.locations[loc] ?? { countingActive: false, capacityPerDay: 50, portalCity: "" };
    const skus = (classes.get(loc) ?? []).sort((a, b) => CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls) || b.transactions - a.transactions);
    const classCounts = countBy(skus);
    const altCounts = countBy(alt.get(loc) ?? []);
    const slow8 = { ...s, counts: { ...s.counts, cadenceWeeks: { ...s.counts.cadenceWeeks, slow: 8 } } };

    // Occurrences inside the horizon
    // SKUs never counted, or already overdue, get their first count spread evenly across
    // one cadence period (by velocity rank), so the backlog doesn't all land on day one.
    const occ: ScheduledCount[] = [];
    const backlog = new Map<VelocityClass, SkuVelocity[]>();
    for (const k of skus) if (!k.due || k.due <= start) backlog.set(k.cls, [...(backlog.get(k.cls) ?? []), k]);
    const firstDue = new Map<SkuVelocity, string>();
    for (const [cls, list] of backlog) {
      const span = s.counts.cadenceWeeks[cls] * 7;
      list.forEach((k, i) => firstDue.set(k, addDays(start, Math.floor((i * span) / list.length))));
    }
    for (const k of skus) {
      const cadence = s.counts.cadenceWeeks[k.cls] * 7;
      let due = firstDue.get(k) ?? k.due;
      for (; due < end; due = addDays(due, cadence)) {
        occ.push({ sku: k.sku, product: k.product, cls: k.cls, due, date: "", atRisk: false, sublocations: k.sublocations, lastCounted: k.lastCounted });
      }
    }
    occ.sort((a, b) => a.due.localeCompare(b.due) || CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls));

    const load = new Map(days.map((d) => [d, 0]));
    const byDay = new Map<string, ScheduledCount[]>(days.map((d) => [d, []]));
    const unplaced: ScheduledCount[] = [];
    const dayIndex = (d: string) => {
      let i = days.findIndex((x) => x >= d);
      return i === -1 ? days.length - 1 : i;
    };
    for (const o of occ) {
      const i0 = dayIndex(o.due);
      const w = s.counts.windowDays[o.cls];
      const order: number[] = [i0];
      for (let k = 1; k < days.length; k++) order.push(i0 + k, i0 - k);
      let placed = false;
      for (const i of order) {
        if (i < 0 || i >= days.length) continue;
        const d = days[i];
        if ((load.get(d) ?? 0) >= ls.capacityPerDay) continue;
        o.date = d;
        o.atRisk = Math.abs(i - i0) > w;
        load.set(d, (load.get(d) ?? 0) + 1);
        byDay.get(d)!.push(o);
        placed = true;
        break;
      }
      if (!placed) { o.atRisk = true; unplaced.push(o); }
    }
    for (const list of byDay.values()) {
      list.sort((a, b) => (a.sublocations[0] ?? "~").localeCompare(b.sublocations[0] ?? "~") || a.sku.localeCompare(b.sku));
    }

    const withinCadence = { fast: { ok: 0, total: 0 }, medium: { ok: 0, total: 0 }, slow: { ok: 0, total: 0 }, dormant: { ok: 0, total: 0 } };
    for (const k of skus) {
      withinCadence[k.cls].total++;
      if (k.lastCounted && k.due >= c.latest) withinCadence[k.cls].ok++;
    }

    plans.push({
      location: loc,
      active: ls.countingActive,
      capacity: ls.capacityPerDay,
      skus,
      classCounts,
      requiredPerDay: requiredPerDay(classCounts, s),
      levers: [
        { label: "Fast = top 70% of transactions", perDay: requiredPerDay(altCounts, s) },
        { label: "Slow counted every 8 weeks", perDay: requiredPerDay(classCounts, slow8) },
        { label: "Both of the above", perDay: requiredPerDay(altCounts, slow8) },
      ],
      days,
      byDay,
      unplaced,
      atRisk: occ.filter((o) => o.atRisk).length,
      withinCadence,
      start,
    });
  }
  return plans;
}
