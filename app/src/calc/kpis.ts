// KPI definitions. Every KPI produces "facts" (dated numerator/denominator contributions
// with dimensions and a source record). Trends, breakdowns, tiles and drill-downs are all
// aggregations of the same facts, so the numbers always agree with each other.

import type { ReportKind } from "../data/model";
import { CARRIER_CLASS_LABEL } from "../data/settings";
import type { Ctx, ShipmentX } from "./context";
import { transactionCounts } from "./counts";
import { addDays, businessDays, mondayOf, monthOf } from "./dates";

export type Unit = "units" | "pct" | "days" | "usd" | "count";
export type Agg = "sum" | "ratio" | "avg";
export type Better = "up" | "down" | "near100" | "near0" | "none";

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
  group: "Inventory" | "Production" | "Sales & fulfillment" | "Freight";
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

const LINE_TYPE = { stock: "Stocked items", dropship: "Ships from another location", nonstock: "Non-stock items & fees" };

/** Sales-order line facts. `unitsOnly` keeps stocked items shipped from your sites (excludes drop-ship and non-stock). */
function soLineFacts(c: Ctx, by: "order" | "fulfilled", kinds: string[], value: "qty" | "subtotal", unitsOnly = false): Fact[] {
  const out: Fact[] = [];
  for (const o of c.orders.values()) {
    if (o.isQuote || o.cancelled) continue;
    const date = by === "order" ? o.orderDate : o.fulfilled;
    if (!date) continue;
    for (const l of c.linesByOrder.get(o.order) ?? []) {
      if (!kinds.includes(l.kind)) continue;
      const cls = l.kind === "item" ? c.lineClass(l, o) : null;
      if (unitsOnly && cls !== "stock") continue;
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
          lineType: cls ? LINE_TYPE[cls] : "Adjustments",
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

const dirLabel = (c: Ctx, s: ShipmentX) => (s.dir === "inbound" ? "Inbound" : s.destLoc ? "Between your sites" : "Outbound to customers");

/** Freight-portal cost facts. `dirs`: outbound (to customers), inbound, own (between your sites). */
function portalFacts(c: Ctx, dirs: ("outbound" | "inbound" | "own")[], _spent = false): Fact[] {
  return c.shipments
    .filter((s) => s.pickup)
    .map((s) => ({ s, d: (s.dir === "inbound" ? "inbound" : s.destLoc ? "own" : "outbound") as "outbound" | "inbound" | "own" }))
    .filter(({ d }) => dirs.includes(d))
    .map(({ s, d }) => ({
      date: s.pickup,
      num: s.cost,
      den: 1,
      dims: {
        location: s.dir === "inbound" ? s.destLoc || "Other" : s.originLoc || "Other",
        direction: dirLabel(c, s),
        carrier: s.carrier || "(none)",
        mode: s.mode || "(none)",
        origin: s.originCity,
      },
      ref: { date: s.pickup, id: s.id, dir: d, carrier: s.carrier, mode: s.mode, from: s.originCity, to: `${s.dest} (${s.destCity})`, cost: s.cost, weight: s.weight },
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
        { label: "Lines exact", value: f.length ? (f.filter((x) => x.num === x.den).length / f.length) * 100 : NaN, unit: "pct" },
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
    description: "Units of stocked items on sales orders placed in the period. Excluded: items shipped from another location (per-lb flake from Torginol), non-stocked items and fees, tax and adjustment lines, quotes and cancelled orders.",
    sources: ["salesOrders"], tile: true, locationAware: true,
    dims: [{ key: "location", label: "Location" }, { key: "category", label: "Category" }, { key: "product", label: "Product" }, { key: "customer", label: "Customer" }],
    refCols: soCols("Ordered"), facts: (c) => soLineFacts(c, "order", ["item"], "qty", true),
  },
  {
    id: "units_shipped", name: "Units Shipped", group: "Sales & fulfillment", unit: "units", agg: "sum", better: "up",
    description: "Units of stocked items shipped from your locations on orders fulfilled in the period (fulfillment date from the Shipped report). Items shipped from another location (per-lb flake from Torginol) and non-stocked items are excluded.",
    sources: ["shipped", "salesOrders"], tile: true, locationAware: true,
    dims: [{ key: "location", label: "Location" }, { key: "category", label: "Category" }, { key: "product", label: "Product" }, { key: "customer", label: "Customer" }],
    refCols: soCols("Fulfilled"), facts: (c) => soLineFacts(c, "fulfilled", ["item"], "qty", true),
  },
  {
    id: "total_sales", name: "Total Sales", group: "Sales & fulfillment", unit: "usd", agg: "sum", better: "up",
    description: "All item line amounts (including items shipped from another location, non-stocked items and fees) plus \"Adjustment from imported order\" lines, by order date. Tax, quotes and cancelled orders are excluded.",
    sources: ["salesOrders"], tile: false, locationAware: true,
    dims: [{ key: "lineType", label: "Line type" }, { key: "location", label: "Location" }, { key: "category", label: "Category" }, { key: "customer", label: "Customer" }],
    refCols: soCols("Ordered"),
    facts: (c) => soLineFacts(c, "order", ["item", "adjustment"], "subtotal"),
  },
  {
    id: "late_orders", name: "Late Orders", group: "Sales & fulfillment", unit: "count", agg: "sum", better: "down",
    description: "Open (unfulfilled) orders more than 3 business days old as of the latest data. Orders that only contain items shipped from another location or non-stock items are left out. The breakdown and records show every open order with its age.",
    sources: ["salesOrders", "shipped"], tile: true, pointInTime: true, locationAware: true,
    dims: [{ key: "age", label: "Age" }, { key: "location", label: "Location" }, { key: "customer", label: "Customer" }],
    refCols: [
      { key: "order", label: "Order #" }, { key: "customer", label: "Customer" }, { key: "location", label: "Location" }, { key: "orderDate", label: "Ordered" },
      { key: "age", label: "Business days open", unit: "days" }, { key: "status", label: "Status" }, { key: "units", label: "Units", unit: "units" }, { key: "value", label: "Value", unit: "usd" },
    ],
    facts: (c) => {
      const out: Fact[] = [];
      const lateAfter = c.s.lateOrderDays;
      for (const o of c.orders.values()) {
        if (o.isQuote || o.cancelled || o.fulfilled || /^fulfilled$/i.test(o.status)) continue;
        const lines = c.linesByOrder.get(o.order) ?? [];
        const stock = lines.filter((l) => l.kind === "item" && c.lineClass(l, o) === "stock");
        if (!stock.length) continue;
        const age = businessDays(o.orderDate, c.latest, c.holidays);
        const units = sum(stock.map((l) => l.qty));
        const value = sum(lines.filter((l) => l.kind !== "tax").map((l) => l.subtotal));
        const late = age > lateAfter;
        out.push({
          date: c.snapshotDate, num: late ? 1 : 0, den: 1,
          dims: { age: age <= lateAfter ? `0–${lateAfter} days (on time)` : age <= 5 ? `${lateAfter + 1}–5 days` : age <= 10 ? "6–10 days" : age <= 30 ? "11–30 days" : "Over 30 days", location: o.location, customer: o.customer || "(no customer)" },
          ref: { order: o.order, customer: o.customer, location: o.location, orderDate: o.orderDate, age, status: o.status, units, value },
        });
      }
      return out;
    },
    extras: (f) => [
      { label: "Open orders", value: f.length, unit: "count" },
      { label: "Open units", value: sum(f.map((x) => Number(x.ref.units))), unit: "units" },
      { label: "Open value", value: sum(f.map((x) => Number(x.ref.value))), unit: "usd" },
    ],
  },
  {
    id: "freight_net", name: "Freight Paid vs Spent", group: "Freight", unit: "usd", agg: "sum", better: "up",
    description: `Net freight = paid − spent. Paid: freight charged to customers on orders fulfilled in the period by freight carriers or with carrier unknown. Spent: freight-portal cost of outbound shipments to customers picked up in the period. Inbound freight and shipments between your own sites are not included. ${GROUND_NOTE}`,
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
          date: o.fulfilled, num: o.freight, den: 1,
          dims: { side: "Paid by customers", carrier: o.carrier || "Carrier unknown", location: o.location },
          ref: { date: o.fulfilled, side: "Paid", doc: o.order, party: o.customer, paid: o.freight, spent: 0 },
        });
      }
      for (const f of portalFacts(c, ["outbound"], true)) {
        out.push({ ...f, num: -f.ref.cost, den: 1, dims: { side: "Spent with carriers", carrier: f.dims.carrier, location: f.dims.location }, ref: { date: f.date, side: "Spent", doc: f.ref.id, party: f.ref.carrier, paid: 0, spent: f.ref.cost } });
      }
      return out;
    },
    extras: (f) => [
      { label: "Paid", value: sum(f.map((x) => Number(x.ref.paid))), unit: "usd" },
      { label: "Spent", value: sum(f.map((x) => Number(x.ref.spent))), unit: "usd" },
    ],
  },
  {
    id: "freight_pct_sales", name: "Freight as % of Sales", group: "Freight", unit: "pct", agg: "ratio", better: "down",
    description: `Outbound freight to customers (freight portal) ÷ Total Sales, in the period. ${GROUND_NOTE}`,
    sources: ["salesOrders", "shipments"], tile: true, locationAware: true,
    dims: [{ key: "location", label: "Location" }],
    refCols: [{ key: "date", label: "Date" }, { key: "doc", label: "Order / shipment" }, { key: "freight", label: "Freight", unit: "usd" }, { key: "sales", label: "Sales", unit: "usd" }],
    facts: (c) => [
      ...portalFacts(c, ["outbound"], true).map((f) => ({ ...f, num: f.ref.cost as number, den: 0, ref: { date: f.date, doc: `Shipment ${f.ref.id}`, freight: f.ref.cost, sales: 0 } })),
      ...soLineFacts(c, "order", ["item", "adjustment"], "subtotal").map((f) => ({ ...f, den: f.num, num: 0, ref: { date: f.date, doc: `Order ${f.ref.order}`, freight: 0, sales: f.ref.subtotal } })),
    ],
    extras: (f) => [
      { label: "Freight spent", value: sum(f.map((x) => x.num)), unit: "usd" },
      { label: "Total sales", value: sum(f.map((x) => x.den)), unit: "usd" },
    ],
  },
  {
    id: "total_freight", name: "Total Freight Spend", group: "Freight", unit: "usd", agg: "sum", better: "down",
    description: `All freight-portal cost picked up in the period: outbound to customers, inbound, and shipments between your own sites. ${GROUND_NOTE}`,
    sources: ["shipments"], tile: true, locationAware: true,
    dims: [{ key: "direction", label: "Direction" }, { key: "carrier", label: "Carrier" }, { key: "mode", label: "Mode" }, { key: "location", label: "Site" }],
    refCols: portalCols, facts: (c) => portalFacts(c, ["outbound", "inbound", "own"]),
    extras: (f) => [
      { label: "To customers", value: sum(f.filter((x) => x.ref.dir === "outbound").map((x) => x.num)), unit: "usd" },
      { label: "Inbound", value: sum(f.filter((x) => x.ref.dir === "inbound").map((x) => x.num)), unit: "usd" },
      { label: "Between sites", value: sum(f.filter((x) => x.ref.dir === "own").map((x) => x.num)), unit: "usd" },
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
    id: "carrier_on_time", name: "Carrier On-Time Delivery", group: "Freight", unit: "pct", agg: "ratio", better: "up",
    description: `Freight-portal shipments delivered on or before the scheduled delivery date ÷ shipments with an actual delivery date, by delivery date. Shipments with no actual arrival in the portal aren't measured. ${GROUND_NOTE}`,
    sources: ["shipments"], tile: true, locationAware: true,
    dims: [{ key: "carrier", label: "Carrier" }, { key: "direction", label: "Direction" }, { key: "mode", label: "Mode" }],
    refCols: [
      { key: "date", label: "Delivered" }, { key: "id", label: "Shipment" }, { key: "carrier", label: "Carrier" }, { key: "scheduled", label: "Scheduled" },
      { key: "late", label: "Days late", unit: "days" }, { key: "to", label: "To" },
    ],
    facts: (c) =>
      c.shipments
        .filter((s) => s.actualArrival && s.scheduledDelivery)
        .map((s) => {
          const late = Math.max(0, businessDays(s.scheduledDelivery, s.actualArrival, c.holidays));
          return {
            date: s.actualArrival, num: s.actualArrival <= s.scheduledDelivery ? 1 : 0, den: 1,
            dims: { carrier: s.carrier || "(none)", direction: dirLabel(c, s), mode: s.mode || "(none)", location: s.dir === "inbound" ? s.destLoc || "Other" : s.originLoc || "Other" },
            ref: { date: s.actualArrival, id: s.id, carrier: s.carrier, scheduled: s.scheduledDelivery, late, to: `${s.dest} (${s.destCity})` },
          };
        }),
    extras: (f) => [
      { label: "Delivered", value: f.length, unit: "count" },
      { label: "Late", value: f.filter((x) => !x.num).length, unit: "count" },
    ],
  },
  {
    id: "freight_cost_lb", name: "Freight Cost per lb", group: "Freight", unit: "usd", agg: "avg", better: "down",
    description: `Freight-portal cost ÷ shipment weight (lb), for shipments picked up in the period. Compare carriers in the breakdown. ${GROUND_NOTE}`,
    sources: ["shipments"], tile: false, locationAware: true,
    dims: [{ key: "carrier", label: "Carrier" }, { key: "mode", label: "Mode" }, { key: "direction", label: "Direction" }],
    refCols: [...portalCols, { key: "weight", label: "Weight (lb)", unit: "units" }],
    facts: (c) => portalFacts(c, ["outbound", "inbound", "own"]).filter((f) => Number(f.ref.weight) > 0).map((f) => ({ ...f, den: Number(f.ref.weight) })),
  },
  {
    id: "count_adjustments", name: "Count Adjustments", group: "Inventory", unit: "usd", agg: "sum", better: "near0",
    description: "Net dollar value of stock count adjustments (gains minus losses) for completed counts started in the period, from the Adjustment Value column. Negative means inventory was written down.",
    sources: ["stockCounts"], tile: true, locationAware: true,
    dims: [{ key: "direction", label: "Gain / loss" }, { key: "count", label: "Stock count" }, { key: "product", label: "Product" }, { key: "location", label: "Location" }],
    refCols: [
      { key: "date", label: "Started" }, { key: "count", label: "Count #" }, { key: "product", label: "Product" }, { key: "sku", label: "SKU" },
      { key: "reported", label: "Reported", unit: "units" }, { key: "counted", label: "Counted", unit: "units" }, { key: "value", label: "Adjustment $", unit: "usd" },
    ],
    facts: (c) =>
      c.ds.countLines
        .filter((l) => l.counted !== null && l.started && l.adjValue)
        .map((l) => ({
          date: l.started, num: l.adjValue, den: 1,
          dims: { direction: l.adjValue < 0 ? "Losses" : "Gains", count: l.count, product: l.product, location: l.location },
          ref: { date: l.started, count: l.count, product: l.product, sku: l.sku, reported: l.reported, counted: l.counted!, value: l.adjValue },
        })),
    extras: (f) => [
      { label: "Losses", value: sum(f.filter((x) => x.num < 0).map((x) => x.num)), unit: "usd" },
      { label: "Gains", value: sum(f.filter((x) => x.num > 0).map((x) => x.num)), unit: "usd" },
    ],
  },
  {
    id: "dormant_inventory", name: "Dormant Inventory", group: "Inventory", unit: "usd", agg: "sum", better: "down",
    description: "Value of stock on hand with no movement in the last 120 days: no sales of the item, no manufacturing of it, and no use as a BOM component. Value = on hand × product cost, as of the latest upload.",
    sources: ["stockLevels", "products", "salesOrders", "mfgOrders"], tile: true, pointInTime: true, locationAware: true,
    dims: [{ key: "location", label: "Location" }, { key: "category", label: "Category" }, { key: "product", label: "Product" }],
    refCols: [
      { key: "location", label: "Location" }, { key: "product", label: "Product" }, { key: "sku", label: "SKU" }, { key: "lastCounted", label: "Last counted" },
      { key: "qty", label: "On hand", unit: "units" }, { key: "cost", label: "Unit cost", unit: "usd" }, { key: "value", label: "Value", unit: "usd" },
    ],
    facts: (c) => {
      const tx = transactionCounts(c, c.s, c.latest, c.s.dormantDays);
      const counted = new Map<string, string>();
      for (const l of c.ds.countLines) if (l.counted !== null && (counted.get(`${l.location}|${l.sku}`) ?? "") < l.started) counted.set(`${l.location}|${l.sku}`, l.started);
      return c.ds.stockLevels
        .filter((x) => x.qty > 0 && !tx.get(`${x.location}|${x.sku}`))
        .map((x) => {
          const p = c.product(x.sku, x.product);
          const cost = p?.cost ?? 0;
          return {
            date: c.snapshotDate, num: x.qty * cost, den: 1,
            dims: { location: x.location, category: p?.category ?? "Uncategorized", product: x.product },
            ref: { location: x.location, product: x.product, sku: x.sku, lastCounted: counted.get(`${x.location}|${x.sku}`) ?? "Never", qty: x.qty, cost, value: x.qty * cost },
          };
        });
    },
    extras: (f) => [{ label: "SKU-locations", value: new Set(f.map((x) => `${x.ref.location}|${x.ref.sku}`)).size, unit: "count" }],
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
