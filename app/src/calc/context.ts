// Lookups and classifications shared by every calculation. Built once per dataset + settings.

import type { Dataset, Product, ReportKind, SalesOrder, Shipment, SoLine } from "../data/model";
import { REPORTS } from "../data/model";
import type { CarrierClass, Settings } from "../data/settings";
import { carrierClass, defaultCarrierClass } from "../data/settings";
import { addDays, mondayOf } from "./dates";

/** stock = stocked item shipped from your sites (counts as units); dropship = ships from another
 *  location (e.g. per-lb flake from Torginol); nonstock = non-stocked items and fees. The last two
 *  count in sales dollars but not in units. */
export type LineClass = "stock" | "dropship" | "nonstock";

export interface Order extends SalesOrder {
  carrierClass: CarrierClass;
  fulfilled: string; // "" when not fulfilled
  locationWasBlank: boolean;
}

export type ShipmentDir = "outbound" | "inbound";
export interface ShipmentX extends Shipment {
  dir: ShipmentDir;
  originLoc: string; // your site name if the origin city is one of yours
  destLoc: string;
}

export interface Ctx {
  ds: Dataset;
  s: Settings;
  holidays: Set<string>;
  orders: Map<string, Order>;
  linesByOrder: Map<string, SoLine[]>;
  product: (sku: string, name?: string) => Product | undefined;
  category: (sku: string, name?: string) => string;
  lineClass: (l: SoLine, o: SalesOrder) => LineClass;
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

  // Orders with no location are credited to the default site (Aurora)
  const fulfilled = new Map(ds.shipped.map((x) => [x.order, x.fulfilledDate]));
  const orders = new Map<string, Order>();
  for (const o of ds.salesOrders) {
    const blank = o.location === "Unassigned";
    orders.set(o.order, {
      ...o,
      location: blank ? s.unassignedSalesLocation : o.location,
      locationWasBlank: blank,
      carrierClass: carrierClass(o.carrier, s),
      fulfilled: fulfilled.get(o.order) ?? "",
    });
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

  const patterns = s.dropShipPatterns.map((p) => p.trim().toLowerCase()).filter(Boolean);
  const dropLocs = new Set(s.dropShipLocations.map((l) => l.trim().toLowerCase()));
  const lineClass = (l: SoLine, o: SalesOrder): LineClass => {
    const name = l.product.toLowerCase();
    if (dropLocs.has(o.location.toLowerCase()) || patterns.some((p) => name.includes(p))) return "dropship";
    const p = product(l.sku, l.product);
    if (p && !/^stocked/i.test(p.itemType)) return "nonstock";
    return "stock";
  };

  // Freight portal: direction as reported, plus which of your sites each end is
  const cityToLoc = new Map<string, string>();
  for (const [loc, ls] of Object.entries(s.locations)) cityToLoc.set(ls.portalCity.toLowerCase(), loc);
  const shipments: ShipmentX[] = ds.shipments.map((sh) => ({
    ...sh,
    dir: sh.direction === "INBOUND" ? "inbound" : "outbound",
    originLoc: cityToLoc.get(sh.originCity.toLowerCase()) ?? "",
    destLoc: cityToLoc.get(sh.destCity.toLowerCase()) ?? "",
  }));

  // Coverage of each dated report, for knowing which weeks have data
  const coverage: Ctx["coverage"] = {};
  for (const f of ds.files) {
    if (f.kind && REPORTS[f.kind].dated && f.minDate && f.maxDate) coverage[f.kind] = { min: f.minDate, max: f.maxDate };
  }
  const latest = Object.values(coverage).map((c) => c!.max).sort().pop() ?? ds.loadedAt.slice(0, 10);
  const currentWeek = mondayOf(latest);

  const locations = [...new Set([...Object.keys(s.locations), ...ds.stockLevels.map((x) => x.location)].filter(Boolean))].sort();
  const unclassifiedCarriers = [...new Set(ds.salesOrders.map((o) => o.carrier).filter((c) => c && !s.carrierOverrides[c.toLowerCase()] && defaultCarrierClass(c) === null))].sort();

  return {
    ds, s, holidays, orders, linesByOrder, product, category, lineClass, shipments, coverage, latest,
    currentWeek, defaultWeek: addDays(currentWeek, -7), snapshotDate: latest, locations, unclassifiedCarriers,
  };
}
