// KPI definitions. Every KPI produces "facts" (dated numerator/denominator contributions
// with dimensions and a source record). Trends, breakdowns, tiles and drill-downs are all
// aggregations of the same facts, so the numbers always agree with each other.

import type { ReportKind } from "../data/model";
import { CARRIER_CLASS_LABEL } from "../data/settings";
import type { Ctx } from "./context";
import { addDays, businessDays, mondayOf, monthOf } from "./dates";

export type Unit = "units" | "pct" | "days" | "usd" | "count";
export type Agg = "sum" | "ratio" | "avg";
export type Better = "up" | "down" | "near100" | "none";

export interface Fact {
  date: string;
  num: number;
  den: number;
  dims: Record<string, string>;
  ref: Record<string, string | number>;
}

export interface Extra { label: string; value: number; unit: Unit }

export interface KpiDef {
  id: string;
  name: string;
  group: "Inventory" | "Production" | "Sales & fulfillment" | "Freight" | "Transfers";
  unit: Unit;
  agg: Agg;
  better: Better;
  description: string;
  sources: ReportKind[];
  tile: boolean;
  pointInTime?: boolean;
  locationAware: boolean;
  dims: { key: string; label: string }[];
  refCols: { key: string; label: string; unit?: Unit }[];
  facts: (c: Ctx) => Fact[];
  extras?: (facts: Fact[]) => Extra[];
}

const GROUND_NOTE = "Ground shipments (all UPS; FedEx Ground, Home, 2-day and Overnight) are not included.";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const MO_LABEL = { blend: "Blend", fill: "Fill", kit: "Kit (manual)", kit_auto: "Kit (auto-built at fulfillment)", other: "Unclassified" };

const mfgFacts = (types: string[]) => (c: Ctx): Fact[] =>
  c.ds.mfgOrders
    .filter((m) => types.includes(m.type) && m.completedDate)
    .map((m) => ({
      date: m.completedDate,
      num: m.qty,
      den: 1,
      dims: { type: MO_LABEL[m.type], category: m.category || c.category(m.sku, m.product), product: m.product },
      ref: { date: m.completedDate, mo: m.mo, product: m.product, sku: m.sku, type: MO_LABEL[m.type], qty: m.qty },
    }));

const mfgCols = [
  { key: "date", label: "Completed" }, { key: "mo", label: "MO #" }, { key: "type", label: "Type" },
  { key: "product", label: "Product" }, { key: "sku", label: "SKU" }, { key: "qty", label: "Units", unit: "units" as Unit },
];

function soLineFacts(c: Ctx, by: "order" | "fulfilled", kinds: string[], value: "qty" | "subtotal"): Fact[] {
  const out: Fact[] = [];
  for (const o of c.orders.values()) {
    if (o.isQuote || o.cancelled) continue;
    const date = by === "order" ? o.orderDate : o.fulfilled;
    if (!date) continue;
    for (const l of c.linesByOrder.get(o.order) ?? []) {
      if (!kinds.includes(l.kind)) continue;
      const v = l[value];
      out.push({
        date,
        num: v,
        den: 1,
        dims: {
          location: o.location,
          category: l.kind === "item" ? c.category(l.sku, l.product) : l.kind === "adjustment" ? "Adjustments" : "Tax",
          product: l.product,
          customer: o.customer || "(no customer)",
          lineType: l.kind === "item" ? "Items" : "Adjustments",
        },
        ref: { date, order: o.order, customer: o.customer, location: o.location, product: l.product, qty: l.qty, subtotal: l.subtotal },
      });
    }
  }
  return out;
}
const soCols = (dateLabel: string) => [
  { key: "date", label: dateLabel }, { key: "order", label: "Order #" }, { key: "customer", label: "Customer" },
  { key: "location", label: "Location" }, { key: "product", label: "Product" },
  { key: "qty", label: "Units", unit: "units" as Unit }, { key: "subtotal", label: "Amount", unit: "usd" as Unit },
];

/** Freight-portal cost facts. `dirs` picks outbound / inbound / transfer. */
function portalFacts(c: Ctx, dirs: string[], asDen = false): Fact[] {
  return c.shipments
    .filter((s) => dirs.includes(s.dir) && s.pickup)
    .map((s) => ({
      date: s.pickup,
      num: asDen ? 0 : s.cost,
      den: asDen ? s.cost : 1,
      dims: {
        location: s.dir === "inbound" ? s.destLoc || "Other" : s.originLoc || "Other",
        direction: s.dir === "outbound" ? "Outbound to customers" : s.dir === "inbound" ? "Inbound" : "Transfers",
        carrier: s.carrier || "(none)",
        mode: s.mode || "(none)",
        origin: s.originCity,
      },
      ref: { date: s.pickup, id: s.id, dir: s.dir, carrier: s.carrier, mode: s.mode, from: s.originCity, to: `${s.dest} (${s.destCity})`, cost: s.cost, transfer: s.transfer },
    }));
}
const portalCols = [
  { key: "date", label: "Pickup" }, { key: "id", label: "Shipment" }, { key: "dir", label: "Direction" }, { key: "carrier", label: "Carrier" },
  { key: "mode", label: "Mode" }, { key: "from", label: "From" }, { key: "to", label: "To" }, { key: "cost", label: "Cost", unit: "usd" as Unit },
];

export const KPIS: KpiDef[] = [
  {
    id: "inventory_accuracy",
    name: "Inventory Accuracy",
    group: "Inventory",
    unit: "pct",
    agg: "ratio",
    better: "near100",
    description: "Total Units Counted ÷ Total Units Reported × 100, for completed stock counts started in the period. Overcounts and undercounts offset each other. Lines with no counted quantity are skipped.",
    sources: ["stockCounts"],
    tile: true,
    locationAware: true,
    dims: [{ key: "location", label: "Location" }, { key: "count", label: "Stock count" }, { key: "product", label: "Product" }],
    refCols: [
      { key: "date", label: "Started" }, { key: "count", label: "Count #" }, { key: "location", label: "Location" }, { key: "product", label: "Product" },
      { key: "sku", label: "SKU" }, { key: "reported", label: "Reported", unit: "units" }, { key: "counted", label: "Counted", unit: "units" },
      { key: "variance", label: "Variance", unit: "units" },
    ],
    facts: (c) =>
      c.ds.countLines
        .filter((l) => l.counted !== null && l.started)
        .map((l) => ({
          date: l.started,
          num: l.counted!,
          den: l.reported,
          dims: { location: l.location, count: l.count, product: l.product },
          ref: { date: l.started, count: l.count, location: l.location, product: l.product, sku: l.sku, reported: l.reported, counted: l.counted!, variance: l.reported - l.counted! },
        })),
    extras: (f) => {
      const rep = sum(f.map((x) => x.den));
      const cnt = sum(f.map((x) => x.num));
      return [
        { label: "Units reported", value: rep, unit: "units" },
        { label: "Units counted", value: cnt, unit: "units" },
        { label: "Variance", value: rep - cnt, unit: "units" },
      ];
    },
  },
  {
    id: "units_blended", name: "Units Blended", group: "Production", unit: "units", agg: "sum", better: "up",
    description: "Units on Blend manufacturing orders completed in the period (MO numbers starting BLEND-).",
    sources: ["mfgOrders"], tile: true, locationAware: false,
    dims: [{ key: "category", label: "Category" }, { key: "product", label: "Product" }],
    refCols: mfgCols, facts: mfgFacts(["blend"]),
  },
  {
    id: "units_filled", name: "Units Filled", group: "Production", unit: "units", agg: "sum", better: "up",
    description: "Units on Fill manufacturing orders completed in the period (MO numbers starting FILL-, including typos FFILL/FIL).",
    sources: ["mfgOrders"], tile: true, locationAware: false,
    dims: [{ key: "category", label: "Category" }, { key: "product", label: "Product" }],
    refCols: mfgCols, facts: mfgFacts(["fill"]),
  },
  {
    id: "units_kitted", name: "Units Kitted", group: "Production", unit: "units", agg: "sum", better: "up",
    description: "Units on Kit manufacturing orders completed in the period: manual kits (KIT-) plus kits auto-built when a sales order is fulfilled (MO- numbers).",
    sources: ["mfgOrders"], tile: true, locationAware: false,
    dims: [{ key: "type", label: "Kit type" }, { key: "category", label: "Category" }, { key: "product", label: "Product" }],
    refCols: mfgCols, facts: mfgFacts(["kit", "kit_auto"]),
    extras: (f) => [
      { label: "Manual", value: sum(f.filter((x) => x.dims.type === MO_LABEL.kit).map((x) => x.num)), unit: "units" },
      { label: "Auto-built", value: sum(f.filter((x) => x.dims.type === MO_LABEL.kit_auto).map((x) => x.num)), unit: "units" },
    ],
  },
  {
    id: "fulfillment_speed", name: "Order Fulfillment Speed", group: "Sales & fulfillment", unit: "days", agg: "avg", better: "down",
    description: "Average business days from order date to fulfillment date, for orders fulfilled in the period. Pickup orders are excluded; orders with no carrier are included as \"Carrier unknown\".",
    sources: ["shipped", "salesOrders"], tile: true, locationAware: true,
    dims: [{ key: "location", label: "Location" }, { key: "carrier", label: "Carrier type" }, { key: "bucket", label: "Days to fulfill" }],
    refCols: [
      { key: "date", label: "Fulfilled" }, { key: "order", label: "Order #" }, { key: "customer", label: "Customer" }, { key: "orderDate", label: "Ordered" },
      { key: "carrier", label: "Carrier" }, { key: "days", label: "Business days", unit: "days" },
    ],
    facts: (c) => {
      const out: Fact[] = [];
      for (const o of c.orders.values()) {
        if (!o.fulfilled || o.isQuote || o.cancelled || o.carrierClass === "pickup") continue;
        const d = businessDays(o.orderDate, o.fulfilled, c.holidays);
        if (isNaN(d) || d < 0) continue;
        out.push({
          date: o.fulfilled, num: d, den: 1,
          dims: { location: o.location, carrier: CARRIER_CLASS_LABEL[o.carrierClass], bucket: d === 0 ? "0 (same day)" : d === 1 ? "1" : d === 2 ? "2" : d <= 5 ? "3–5" : "6+" },
          ref: { date: o.fulfilled, order: o.order, customer: o.customer, orderDate: o.orderDate, carrier: o.carrier || "Carrier unknown", days: d },
        });
      }
      return out;
    },
    extras: (f) => [
      { label: "Median", value: median(f.map((x) => x.num)), unit: "days" },
      { label: "Within 1 day", value: f.length ? (f.filter((x) => x.num <= 1).length / f.length) * 100 : NaN, unit: "pct" },
      { label: "Orders", value: f.length, unit: "count" },
    ],
  },
  {
    id: "units_sold", name: "Units Sold", group: "Sales & fulfillment", unit: "units", agg: "sum", better: "up",
    description: "Units on item lines of sales orders placed in the period. Quotes, cancelled orders, tax and adjustment lines are excluded.",
    sources: ["salesOrders"], tile: true, locationAware: true,
    dims: [{ key: "location", label: "Location" }, { key: "category", label: "Category" }, { key: "product", label: "Product" }, { key: "customer", label: "Customer" }],
    refCols: soCols("Ordered"), facts: (c) => soLineFacts(c, "order", ["item"], "qty"),
  },
  {
    id: "units_shipped", name: "Units Shipped", group: "Sales & fulfillment", unit: "units", agg: "sum", better: "up",
    description: "Units on item lines of orders fulfilled in the period (fulfillment date from the Shipped report).",
    sources: ["shipped", "salesOrders"], tile: true, locationAware: true,
    dims: [{ key: "location", label: "Location" }, { key: "category", label: "Category" }, { key: "product", label: "Product" }, { key: "customer", label: "Customer" }],
    refCols: soCols("Fulfilled"), facts: (c) => soLineFacts(c, "fulfilled", ["item"], "qty"),
  },
  {
    id: "total_sales", name: "Total Sales", group: "Sales & fulfillment", unit: "usd", agg: "sum", better: "up",
    description: "Item line amounts plus \"Adjustment from imported order\" lines, by order date. Tax, quotes and cancelled orders are excluded.",
    sources: ["salesOrders"], tile: false, locationAware: true,
    dims: [{ key: "lineType", label: "Line type" }, { key: "location", label: "Location" }, { key: "category", label: "Category" }, { key: "customer", label: "Customer" }],
    refCols: soCols("Ordered"),
    facts: (c) => soLineFacts(c, "order", ["item", "adjustment"], "subtotal"),
  },
  {
    id: "freight_recovery", name: "Freight Paid vs Spent", group: "Freight", unit: "pct", agg: "ratio", better: "up",
    description: `Recovery % = freight paid ÷ freight spent. Paid: freight charged to customers on orders fulfilled in the period by freight carriers or with carrier unknown. Spent: freight-portal cost of outbound customer shipments picked up in the period. Inbound freight and transfers are not included. ${GROUND_NOTE}`,
    sources: ["salesOrders", "shipped", "shipments"], tile: true, locationAware: true,
    dims: [{ key: "side", label: "Paid / spent" }, { key: "carrier", label: "Carrier" }, { key: "location", label: "Location" }],
    refCols: [
      { key: "date", label: "Date" }, { key: "side", label: "Side" }, { key: "doc", label: "Order / shipment" }, { key: "party", label: "Customer / carrier" },
      { key: "paid", label: "Paid", unit: "usd" }, { key: "spent", label: "Spent", unit: "usd" },
    ],
    facts: (c) => {
      const out: Fact[] = [];
      for (const o of c.orders.values()) {
        if (!o.fulfilled || o.isQuote || o.cancelled || !(o.carrierClass === "freight" || o.carrierClass === "unknown") || !o.freight) continue;
        out.push({
          date: o.fulfilled, num: o.freight, den: 0,
          dims: { side: "Paid by customers", carrier: o.carrier || "Carrier unknown", location: o.location },
          ref: { date: o.fulfilled, side: "Paid", doc: o.order, party: o.customer, paid: o.freight, spent: 0 },
        });
      }
      for (const f of portalFacts(c, ["outbound"], true)) {
        out.push({ ...f, dims: { side: "Spent with carriers", carrier: f.dims.carrier, location: f.dims.location }, ref: { date: f.date, side: "Spent", doc: f.ref.id, party: f.ref.carrier, paid: 0, spent: f.den } });
      }
      return out;
    },
    extras: (f) => [
      { label: "Paid", value: sum(f.map((x) => x.num)), unit: "usd" },
      { label: "Spent", value: sum(f.map((x) => x.den)), unit: "usd" },
    ],
  },
  {
    id: "freight_pct_sales", name: "Freight as % of Sales", group: "Freight", unit: "pct", agg: "ratio", better: "down",
    description: `Outbound customer freight spent (freight portal) ÷ Total Sales, in the period. ${GROUND_NOTE}`,
    sources: ["salesOrders", "shipments"], tile: true, locationAware: true,
    dims: [{ key: "location", label: "Location" }],
    refCols: [{ key: "date", label: "Date" }, { key: "doc", label: "Order / shipment" }, { key: "freight", label: "Freight", unit: "usd" }, { key: "sales", label: "Sales", unit: "usd" }],
    facts: (c) => [
      ...portalFacts(c, ["outbound"]).map((f) => ({ ...f, den: 0, ref: { date: f.date, doc: `Shipment ${f.ref.id}`, freight: f.num, sales: 0 } })),
      ...soLineFacts(c, "order", ["item", "adjustment"], "subtotal").map((f) => ({ ...f, den: f.num, num: 0, ref: { date: f.date, doc: `Order ${f.ref.order}`, freight: 0, sales: f.ref.subtotal } })),
    ],
    extras: (f) => [
      { label: "Freight spent", value: sum(f.map((x) => x.num)), unit: "usd" },
      { label: "Total sales", value: sum(f.map((x) => x.den)), unit: "usd" },
    ],
  },
  {
    id: "total_freight", name: "Total Freight Spend", group: "Freight", unit: "usd", agg: "sum", better: "down",
    description: `All freight-portal cost picked up in the period: outbound to customers, inbound, and transfer freight (shipments matched to a stock transfer). ${GROUND_NOTE}`,
    sources: ["shipments"], tile: true, locationAware: true,
    dims: [{ key: "direction", label: "Direction" }, { key: "carrier", label: "Carrier" }, { key: "mode", label: "Mode" }, { key: "location", label: "Site" }],
    refCols: portalCols, facts: (c) => portalFacts(c, ["outbound", "inbound", "transfer"]),
    extras: (f) => [
      { label: "Outbound", value: sum(f.filter((x) => x.ref.dir === "outbound").map((x) => x.num)), unit: "usd" },
      { label: "Inbound", value: sum(f.filter((x) => x.ref.dir === "inbound").map((x) => x.num)), unit: "usd" },
      { label: "Transfers", value: sum(f.filter((x) => x.ref.dir === "transfer").map((x) => x.num)), unit: "usd" },
    ],
  },
  {
    id: "inbound_freight", name: "Inbound Freight Spend", group: "Freight", unit: "usd", agg: "sum", better: "down",
    description: "Freight-portal cost of inbound shipments picked up in the period. Also part of Total Freight Spend.",
    sources: ["shipments"], tile: false, locationAware: true,
    dims: [{ key: "carrier", label: "Carrier" }, { key: "location", label: "Receiving site" }],
    refCols: portalCols, facts: (c) => portalFacts(c, ["inbound"]),
  },
  {
    id: "stock_transfers", name: "Stock Transfers", group: "Transfers", unit: "units", agg: "sum", better: "none",
    description: "Units on inter-site transfers sent in the period. Same-location (bin) transfers are ignored.",
    sources: ["transfers"], tile: true, locationAware: true,
    dims: [{ key: "lane", label: "Route" }, { key: "category", label: "Category" }, { key: "product", label: "Product" }],
    refCols: [
      { key: "date", label: "Sent" }, { key: "transfer", label: "Transfer #" }, { key: "lane", label: "Route" }, { key: "product", label: "Product" },
      { key: "qty", label: "Units", unit: "units" }, { key: "cost", label: "Value", unit: "usd" },
    ],
    facts: (c) =>
      c.ds.transfers
        .filter((t) => t.sent)
        .map((t) => ({
          date: t.sent, num: t.qty, den: 1,
          dims: { lane: `${t.from} → ${t.to}`, category: c.category(t.sku, t.product), product: t.product, from: t.from, to: t.to },
          ref: { date: t.sent, transfer: t.transfer, lane: `${t.from} → ${t.to}`, product: t.product, qty: t.qty, cost: t.cost },
        })),
    extras: (f) => [
      { label: "Transfers", value: new Set(f.map((x) => x.ref.transfer)).size, unit: "count" },
      { label: "Value", value: sum(f.map((x) => Number(x.ref.cost))), unit: "usd" },
    ],
  },
  {
    id: "transfer_transit", name: "Transfer Transit Time", group: "Transfers", unit: "days", agg: "avg", better: "down",
    description: "Average business days from sent to received, for inter-site transfers received in the period.",
    sources: ["transfers"], tile: true, locationAware: true,
    dims: [{ key: "lane", label: "Route" }],
    refCols: [
      { key: "date", label: "Received" }, { key: "transfer", label: "Transfer #" }, { key: "lane", label: "Route" }, { key: "sent", label: "Sent" },
      { key: "days", label: "Business days", unit: "days" }, { key: "units", label: "Units", unit: "units" }, { key: "value", label: "Value", unit: "usd" },
    ],
    facts: (c) =>
      c.transfers
        .filter((t) => t.sent && t.received)
        .map((t) => {
          const d = businessDays(t.sent, t.received, c.holidays);
          return {
            date: t.received, num: d, den: 1, dims: { lane: t.lane, from: t.from, to: t.to },
            ref: { date: t.received, transfer: t.transfer, lane: t.lane, sent: t.sent, days: d, units: t.units, value: t.value },
          };
        }),
  },
  {
    id: "transfer_freight", name: "Transfer Freight Spend", group: "Transfers", unit: "usd", agg: "sum", better: "down",
    description: "Freight-portal cost of shipments matched to a stock transfer (same route, picked up within 3 days of the sent date).",
    sources: ["shipments", "transfers"], tile: false, locationAware: true,
    dims: [{ key: "carrier", label: "Carrier" }, { key: "location", label: "From site" }],
    refCols: [...portalCols, { key: "transfer", label: "Transfer #" }], facts: (c) => portalFacts(c, ["transfer"]),
  },
  {
    id: "count_lines_exact", name: "Count Lines Exact", group: "Inventory", unit: "pct", agg: "ratio", better: "up",
    description: "Share of counted lines where the counted quantity equals the quantity on record. Shown next to Inventory Accuracy because the accuracy formula nets overcounts against undercounts.",
    sources: ["stockCounts"], tile: false, locationAware: true,
    dims: [{ key: "location", label: "Location" }, { key: "count", label: "Stock count" }],
    refCols: [{ key: "date", label: "Started" }, { key: "count", label: "Count #" }, { key: "product", label: "Product" }, { key: "reported", label: "Reported", unit: "units" }, { key: "counted", label: "Counted", unit: "units" }],
    facts: (c) =>
      c.ds.countLines
        .filter((l) => l.counted !== null && l.started)
        .map((l) => ({
          date: l.started, num: l.counted === l.reported ? 1 : 0, den: 1, dims: { location: l.location, count: l.count },
          ref: { date: l.started, count: l.count, product: l.product, reported: l.reported, counted: l.counted! },
        })),
  },
  {
    id: "inventory_value", name: "Current Inventory Value", group: "Inventory", unit: "usd", agg: "sum", better: "none",
    description: "On-hand quantity × product cost from the latest Stock Levels and Product Details uploads. Negative on-hand is excluded. Items with $0 or blank cost add nothing until their cost is filled in inFlow.",
    sources: ["stockLevels", "products"], tile: true, pointInTime: true, locationAware: true,
    dims: [{ key: "location", label: "Location" }, { key: "category", label: "Category" }, { key: "product", label: "Product" }],
    refCols: [
      { key: "location", label: "Location" }, { key: "sublocation", label: "Sublocation" }, { key: "product", label: "Product" }, { key: "sku", label: "SKU" },
      { key: "qty", label: "On hand", unit: "units" }, { key: "cost", label: "Unit cost", unit: "usd" }, { key: "value", label: "Value", unit: "usd" },
    ],
    facts: (c) =>
      c.ds.stockLevels
        .filter((x) => x.qty > 0)
        .map((x) => {
          const p = c.product(x.sku, x.product);
          const cost = p?.cost ?? 0;
          return {
            date: c.snapshotDate, num: x.qty * cost, den: 1,
            dims: { location: x.location, category: p?.category ?? "Uncategorized", product: x.product },
            ref: { location: x.location, sublocation: x.sublocation || "—", product: x.product, sku: x.sku, qty: x.qty, cost, value: x.qty * cost },
          };
        }),
    extras: (f) => [{ label: "Lines with $0 cost", value: f.filter((x) => !Number(x.ref.cost)).length, unit: "count" }],
  },
];

export const KPI_BY_ID = new Map(KPIS.map((k) => [k.id, k]));

// ---------- Aggregation ----------

export type Grain = "week" | "month";
export const bucketOf = (grain: Grain) => (d: string) => (grain === "week" ? mondayOf(d) : monthOf(d));

export interface Point { key: string; value: number | null; num: number; den: number; n: number; partial: boolean }

export function valueOf(def: KpiDef, num: number, den: number, n: number): number | null {
  if (def.agg === "sum") return n || num ? num : 0;
  if (!den) return null;
  return def.agg === "ratio" ? (num / den) * 100 : num / den;
}

/** The date range where every source report for a KPI has data. */
export function coverageOf(c: Ctx, def: KpiDef): { min: string; max: string } | null {
  let min = "";
  let max = "9999-12-31";
  for (const s of def.sources) {
    const cv = c.coverage[s];
    if (!cv) {
      if (s === "stockLevels" || s === "products") continue; // undated
      return null;
    }
    if (cv.min > min) min = cv.min;
    if (cv.max < max) max = cv.max;
  }
  return { min, max };
}

export function filterLoc(def: KpiDef, facts: Fact[], loc: string): Fact[] {
  if (loc === "All" || !def.locationAware) return facts;
  return facts.filter((f) => f.dims.location === loc || f.dims.from === loc || f.dims.to === loc);
}

/** Time series over consecutive buckets. Buckets outside the KPI's data coverage are null. */
export function series(c: Ctx, def: KpiDef, facts: Fact[], grain: Grain, from: string, to: string): Point[] {
  const b = bucketOf(grain);
  const acc = new Map<string, { num: number; den: number; n: number }>();
  for (const f of facts) {
    if (f.date < from || f.date > to) continue;
    const k = b(f.date);
    const a = acc.get(k) ?? { num: 0, den: 0, n: 0 };
    a.num += f.num;
    a.den += f.den;
    a.n++;
    acc.set(k, a);
  }
  const cov = coverageOf(c, def);
  const out: Point[] = [];
  const step = (k: string) => (grain === "week" ? addDays(k, 7) : monthOf(addDays(k, 32)));
  for (let k = b(from); k <= to; k = step(k)) {
    const end = grain === "week" ? addDays(k, 6) : addDays(step(k), -1);
    const a = acc.get(k) ?? { num: 0, den: 0, n: 0 };
    const covered = def.pointInTime ? a.n > 0 : !!cov && end >= cov.min && k <= cov.max;
    out.push({
      key: k,
      value: covered ? valueOf(def, a.num, a.den, a.n) : null,
      num: a.num,
      den: a.den,
      n: a.n,
      partial: !!cov && !def.pointInTime && end > cov.max,
    });
  }
  return out;
}

export function factsIn(facts: Fact[], from: string, to: string) {
  return facts.filter((f) => f.date >= from && f.date <= to);
}

export function breakdown(def: KpiDef, facts: Fact[], dim: string) {
  const g = new Map<string, { num: number; den: number; n: number }>();
  for (const f of facts) {
    const k = f.dims[dim] ?? "(none)";
    const a = g.get(k) ?? { num: 0, den: 0, n: 0 };
    a.num += f.num;
    a.den += f.den;
    a.n++;
    g.set(k, a);
  }
  return [...g.entries()]
    .map(([key, a]) => ({ key, ...a, value: valueOf(def, a.num, a.den, a.n) }))
    .sort((x, y) => (def.agg === "sum" ? Math.abs(y.num) - Math.abs(x.num) : y.den - x.den || y.n - x.n));
}
