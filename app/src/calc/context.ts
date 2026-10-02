// Lookups and classifications shared by every calculation. Built once per dataset + settings.

import type { Dataset, Product, ReportKind, SalesOrder, Shipment, SoLine } from "../data/model";
import { REPORTS } from "../data/model";
import type { CarrierClass, Settings } from "../data/settings";
import { carrierClass, defaultCarrierClass } from "../data/settings";
import { addDays, mondayOf } from "./dates";

export interface Order extends SalesOrder {
  carrierClass: CarrierClass;
  fulfilled: string; // "" when not fulfilled
}

export interface TransferHeader {
  transfer: string;
  from: string;
  to: string;
  lane: string;
  transferDate: string;
  sent: string;
  received: string;
  units: number;
  value: number;
  lines: number;
  freight: number; // matched freight-portal cost
}

export type ShipmentDir = "outbound" | "inbound" | "transfer";
export interface ShipmentX extends Shipment {
  dir: ShipmentDir;
  originLoc: string;
  destLoc: string;
  transfer: string; // matched transfer #, "" if none
  ownSites: boolean; // origin and destination are both your sites
}

export interface Ctx {
  ds: Dataset;
  s: Settings;
  holidays: Set<string>;
  orders: Map<string, Order>;
  linesByOrder: Map<string, SoLine[]>;
  product: (sku: string, name?: string) => Product | undefined;
  category: (sku: string, name?: string) => string;
  transfers: TransferHeader[];
  shipments: ShipmentX[];
  coverage: Partial<Record<ReportKind, { min: string; max: string }>>;
  latest: string; // newest transaction date across dated reports
  currentWeek: string; // Monday of the week containing `latest` (usually partial)
  defaultWeek: string; // the last complete week
  snapshotDate: string; // date the stock levels represent
  locations: string[];
  unclassifiedCarriers: string[];
}

export function buildContext(ds: Dataset, s: Settings): Ctx {
  const holidays = new Set(s.holidays);

  const fulfilled = new Map(ds.shipped.map((x) => [x.order, x.fulfilledDate]));
  const orders = new Map<string, Order>();
  for (const o of ds.salesOrders) {
    orders.set(o.order, { ...o, carrierClass: carrierClass(o.carrier, s), fulfilled: fulfilled.get(o.order) ?? "" });
  }
  const linesByOrder = new Map<string, SoLine[]>();
  for (const l of ds.soLines) {
    const arr = linesByOrder.get(l.order);
    if (arr) arr.push(l);
    else linesByOrder.set(l.order, [l]);
  }

  const bySku = new Map<string, Product>();
  const byName = new Map<string, Product>();
  for (const p of ds.products) {
    if (p.sku && !bySku.has(p.sku)) bySku.set(p.sku, p);
    if (p.name && !byName.has(p.name)) byName.set(p.name, p);
  }
  const product = (sku: string, name?: string) => bySku.get(sku) ?? (name ? byName.get(name) : undefined) ?? byName.get(sku);
  const category = (sku: string, name?: string) => product(sku, name)?.category ?? "Uncategorized";

  // Transfer headers (bin transfers were already dropped on import)
  const th = new Map<string, TransferHeader>();
  for (const t of ds.transfers) {
    let h = th.get(t.transfer);
    if (!h) {
      h = { transfer: t.transfer, from: t.from, to: t.to, lane: `${t.from} → ${t.to}`, transferDate: t.transferDate, sent: t.sent, received: t.received, units: 0, value: 0, lines: 0, freight: 0 };
      th.set(t.transfer, h);
    }
    h.units += t.qty;
    h.value += t.cost;
    h.lines++;
    if (!t.received) h.received = "";
  }
  const transfers = [...th.values()];

  // Freight portal: direction, own-site mapping, and matching to stock transfers
  const cityToLoc = new Map<string, string>();
  for (const [loc, ls] of Object.entries(s.locations)) cityToLoc.set(ls.portalCity.toLowerCase(), loc);
  const shipments: ShipmentX[] = ds.shipments.map((sh) => {
    const originLoc = cityToLoc.get(sh.originCity.toLowerCase()) ?? "";
    const destLoc = cityToLoc.get(sh.destCity.toLowerCase()) ?? "";
    let transfer = "";
    if (originLoc && destLoc && originLoc !== destLoc && sh.pickup) {
      let best: TransferHeader | undefined;
      let bestGap = Infinity;
      for (const t of transfers) {
        if (t.from !== originLoc || t.to !== destLoc || !t.sent) continue;
        const gap = Math.abs((Date.parse(t.sent) - Date.parse(sh.pickup)) / 86400000);
        if (gap <= s.transferMatchDays && gap < bestGap) { best = t; bestGap = gap; }
      }
      if (best) { transfer = best.transfer; best.freight += sh.cost; }
    }
    const dir: ShipmentDir = transfer ? "transfer" : sh.direction === "INBOUND" ? "inbound" : "outbound";
    return { ...sh, dir, originLoc, destLoc, transfer, ownSites: !!(originLoc && destLoc && originLoc !== destLoc) };
  });

  // Coverage of each dated report, for knowing which weeks have data
  const coverage: Ctx["coverage"] = {};
  for (const f of ds.files) {
    if (f.kind && f.minDate && f.maxDate) coverage[f.kind] = { min: f.minDate, max: f.maxDate };
  }
  const latest = ds.files
    .filter((f) => f.kind && REPORTS[f.kind].dated && f.maxDate)
    .map((f) => f.maxDate!)
    .sort()
    .pop() ?? ds.loadedAt.slice(0, 10);
  const currentWeek = mondayOf(latest);

  const locations = [...new Set([...Object.keys(s.locations), ...ds.stockLevels.map((x) => x.location)].filter(Boolean))].sort();
  const unclassifiedCarriers = [...new Set(ds.salesOrders.map((o) => o.carrier).filter((c) => c && !s.carrierOverrides[c.toLowerCase()] && defaultCarrierClass(c) === null))].sort();

  return {
    ds, s, holidays, orders, linesByOrder, product, category, transfers, shipments, coverage, latest,
    currentWeek, defaultWeek: addDays(currentWeek, -7), snapshotDate: latest, locations, unclassifiedCarriers,
  };
}
