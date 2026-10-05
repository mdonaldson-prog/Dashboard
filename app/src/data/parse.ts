// Turns raw export files into normalized tables. Each report is recognized by its
// column headings, so file names don't matter. Works in the browser and in Node.

import Papa from "papaparse";
import * as XLSX from "xlsx";
import { parseDate } from "../calc/dates";
import type {
  BomLine, CountLine, Dataset, FileInfo, MfgOrder, MoType, Product, ReportKind, SalesOrder,
  Shipment, ShippedOrder, SoLine, TransferLine,
} from "./model";
import { emptyDataset } from "./model";

type Row = Record<string, unknown>;

/** Repairs UTF-8 text that was decoded as Latin-1 ("HyperBONDÂ®") and drops replacement chars. */
export function fixText(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/[ÂÃ][\u0080-ÿ]/.test(s)) {
    try {
      const bytes = Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      s = decoded;
    } catch {
      s = s.replace(/Â(?=[®©°±·])/g, "");
    }
  }
  return s.replace(/ï¿½|�/g, "").replace(/\s+/g, " ").trim();
}

/** "$1,178.67", "($397.74)", "700 gal.", "328.8." → number. Blank → NaN. */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (v == null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/^\$/, ""));
  const m = s.replace(/[$,()]/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return NaN;
  return neg ? -parseFloat(m[0]) : parseFloat(m[0]);
}
const num0 = (v: unknown) => {
  const n = num(v);
  return isNaN(n) ? 0 : n;
};
const bool = (v: unknown) => String(v).trim().toLowerCase() === "true";

const SIGNATURES: [ReportKind, string[]][] = [
  ["salesOrders", ["OrderNumber", "ProductQuantity"]],
  ["shipped", ["Order Number", "Fulfillment Date"]],
  ["mfgOrders", ["Manufacture Order #", "Completed Date"]],
  ["stockCounts", ["Stock Count #", "Counted Quantity"]],
  ["transfers", ["TransferNumber", "From Location"]],
  ["bom", ["FinishedProductSKU", "ComponentProductSKU"]],
  ["products", ["ItemType", "Cost", "SKU"]],
  ["shipments", ["Shipment Id", "Total Cost"]],
  ["stockLevels", ["Location", "Sublocation", "Quantity", "SKU"]],
];

export function detectKind(headers: string[]): ReportKind | null {
  const set = new Set(headers.map((h) => h.trim()));
  for (const [kind, cols] of SIGNATURES) if (cols.every((c) => set.has(c))) return kind;
  return null;
}

function readRows(name: string, bytes: Uint8Array): Row[] {
  if (/\.(xlsx|xls|xlsm)$/i.test(name)) {
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<Row>(ws, { defval: "", raw: true });
  }
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  const res = Papa.parse<Row>(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.replace(/^﻿/, "").trim() });
  return res.data;
}

const moType = (mo: string): MoType => {
  const p = (mo.match(/^([A-Za-z]+)/)?.[1] ?? "").toUpperCase();
  if (["FILL", "FFILL", "FIL"].includes(p)) return "fill";
  if (["KIT", "KITS", "KIIT"].includes(p)) return "kit";
  if (p === "BLEND") return "blend";
  if (p === "MO") return "kit_auto";
  return "other";
};

/** Parse one file into a partial dataset plus a file report. */
export function parseFile(name: string, bytes: Uint8Array): { info: FileInfo; data: Partial<Dataset> } {
  const rows = readRows(name, bytes);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const kind = detectKind(headers);
  const info: FileInfo = { name, kind, rows: rows.length, warnings: [] };
  const data: Partial<Dataset> = {};
  const dates: string[] = [];
  const s = (r: Row, k: string) => fixText(r[k]);

  switch (kind) {
    case "salesOrders": {
      const orders = new Map<string, SalesOrder>();
      const lines: SoLine[] = [];
      for (const r of rows) {
        const order = s(r, "OrderNumber");
        if (!order) continue;
        if (!orders.has(order)) {
          const orderDate = parseDate(r["OrderDate"]);
          dates.push(orderDate);
          orders.set(order, {
            order,
            customer: s(r, "Customer"),
            location: s(r, "Location") || "Unassigned",
            orderDate,
            carrier: s(r, "ShippingCarrier"),
            freight: num0(r["Freight"]),
            status: s(r, "InventoryStatus"),
            isQuote: bool(r["IsQuote"]),
            cancelled: bool(r["IsCancelled"]),
          });
        }
        const product = s(r, "ProductName");
        const sku = s(r, "ProductSKU");
        const kindOf = /^tax from imported order/i.test(product)
          ? "tax"
          : /^adjustment from imported order/i.test(product)
            ? "adjustment"
            : "item";
        lines.push({ order, kind: kindOf, sku: sku || product, product, qty: num0(r["ProductQuantity"]), subtotal: num0(r["ProductSubtotal"]) });
      }
      data.salesOrders = [...orders.values()];
      data.soLines = lines;
      const blank = data.salesOrders.filter((o) => !o.carrier).length;
      if (blank) info.warnings.push(`${blank.toLocaleString()} orders have no shipping carrier (treated as "Carrier unknown").`);
      const noLoc = data.salesOrders.filter((o) => o.location === "Unassigned").length;
      if (noLoc) info.warnings.push(`${noLoc.toLocaleString()} orders have no location ("Unassigned").`);
      break;
    }
    case "shipped": {
      const out: ShippedOrder[] = [];
      let missing = 0;
      for (const r of rows) {
        const fulfilledDate = parseDate(r["Fulfillment Date"]);
        if (!fulfilledDate) { missing++; continue; }
        dates.push(fulfilledDate);
        out.push({ order: s(r, "Order Number"), orderDate: parseDate(r["Order Date"]), fulfilledDate });
      }
      data.shipped = out;
      if (missing) info.warnings.push(`${missing} orders have no fulfillment date and were skipped.`);
      break;
    }
    case "mfgOrders": {
      const out: MfgOrder[] = [];
      for (const r of rows) {
        const mo = s(r, "Manufacture Order #");
        const completedDate = parseDate(r["Completed Date"]);
        dates.push(completedDate);
        out.push({
          mo, sku: s(r, "SKU"), product: s(r, "ProductName"), category: s(r, "CategoryName"), type: moType(mo),
          qty: num0(r["Quantity"]), orderDate: parseDate(r["Order Date"]), completedDate, unitCost: num0(r["Unit Cost"]),
        });
      }
      data.mfgOrders = out;
      const other = out.filter((m) => m.type === "other").length;
      if (other) info.warnings.push(`${other} manufacturing orders have no Blend/Fill/Kit prefix (unclassified).`);
      break;
    }
    case "stockCounts": {
      const out: CountLine[] = [];
      let blank = 0;
      for (const r of rows) {
        const started = parseDate(r["Started Date"]);
        dates.push(started);
        const c = num(r["Counted Quantity"]);
        if (isNaN(c)) blank++;
        out.push({
          count: s(r, "Stock Count #"), location: s(r, "Location"), sublocation: s(r, "Sublocation"), sku: s(r, "SKU"),
          product: s(r, "ProductName"), started, reported: num0(r["Snapshot Quantity"]), counted: isNaN(c) ? null : c,
          adjValue: num0(r["Adjustment Value"]),
        });
      }
      data.countLines = out;
      if (blank) info.warnings.push(`${blank} count lines have no counted quantity and are skipped.`);
      break;
    }
    case "stockLevels": {
      data.stockLevels = rows.map((r) => ({
        sku: s(r, "SKU") || s(r, "ProductName"), product: s(r, "ProductName"), location: s(r, "Location"),
        sublocation: s(r, "Sublocation"), qty: num0(r["Quantity"]),
      }));
      const neg = data.stockLevels.filter((x) => x.qty < 0).length;
      if (neg) info.warnings.push(`${neg} stock rows have negative on-hand (excluded from inventory value).`);
      break;
    }
    case "products": {
      const out: Product[] = [];
      let noSku = 0;
      for (const r of rows) {
        const sku = s(r, "SKU");
        if (!sku) noSku++;
        out.push({
          sku: sku || s(r, "ProductName"), name: s(r, "ProductName"), category: s(r, "Category") || "Uncategorized",
          itemType: s(r, "ItemType"), cost: num0(r["Cost"]), autoManufacture: bool(r["AutoManufacture"]), isActive: r["IsActive"] == null || bool(r["IsActive"]), hasSku: !!sku,
        });
      }
      data.products = out;
      if (noSku) info.warnings.push(`${noSku} products have no SKU (matched by name instead).`);
      break;
    }
    case "bom": {
      data.bom = rows
        .filter((r) => bool(r["IsActive"]))
        .map<BomLine>((r) => ({ parent: s(r, "FinishedProductSKU"), component: s(r, "ComponentProductSKU"), qty: num0(r["Quantity"]) }));
      break;
    }
    case "shipments": {
      data.shipments = rows.map<Shipment>((r) => {
        const pickup = parseDate(r["Scheduled Pickup"]);
        dates.push(pickup);
        return {
          id: s(r, "Shipment Id"), status: s(r, "Status"), direction: s(r, "Direction").toUpperCase(), mode: s(r, "Shipment Mode"),
          carrier: s(r, "Carrier Name"), origin: s(r, "Origin Location Name"), originCity: s(r, "Origin City State"),
          dest: s(r, "Dest Location Name"), destCity: s(r, "Dest City State"), pickup,
          scheduledDelivery: parseDate(r["Scheduled Delivery"]), actualArrival: parseDate(r["Dest Actual Arrival"]),
          reference: s(r, "Shipment Carrier Reference Number"), orderRefs: s(r, "Order Purchase Order Numbers"),
          weight: num0(r["Shipment Total Weight"]), cost: num0(r["Total Cost"]),
        };
      });
      const noArrival = data.shipments.filter((x) => x.direction === "OUTBOUND" && !x.actualArrival).length;
      if (noArrival) info.warnings.push(`${noArrival} outbound shipments have no actual arrival time.`);
      break;
    }
    case "transfers": {
      const out: TransferLine[] = [];
      let bin = 0;
      for (const r of rows) {
        const from = s(r, "From Location");
        const to = s(r, "To Location");
        if (from === to) { bin++; continue; } // bin transfers are no longer used
        const transferDate = parseDate(r["Transfer Date"]);
        dates.push(transferDate);
        out.push({
          transfer: s(r, "TransferNumber"), sku: s(r, "SKU"), product: s(r, "ProductName"), transferDate,
          sent: parseDate(r["Sent Date"]), received: parseDate(r["Received Date"]), from, to, qty: num0(r["Quantity"]), cost: num0(r["Cost"]),
        });
      }
      data.transfers = out;
      if (bin) info.warnings.push(`${bin} same-location (bin) transfer lines ignored.`);
      const zero = out.filter((t) => t.cost === 0).length;
      if (zero) info.warnings.push(`${zero} transfer lines have $0 cost.`);
      break;
    }
    default:
      info.warnings.push("Not recognized. Check that this is one of the weekly reports.");
  }
  const valid = dates.filter(Boolean).sort();
  if (valid.length) {
    info.minDate = valid[0];
    info.maxDate = valid[valid.length - 1];
  }
  return { info, data };
}

/** Combine parsed files into one dataset. A later file of the same kind replaces an earlier one. */
export function buildDataset(parsed: { info: FileInfo; data: Partial<Dataset> }[]): Dataset {
  const ds = emptyDataset();
  const byKind = new Map<string, { info: FileInfo; data: Partial<Dataset> }>();
  for (const p of parsed) {
    if (p.info.kind) {
      const prev = byKind.get(p.info.kind);
      if (prev) prev.info.warnings.push(`Replaced by ${p.info.name}.`);
      byKind.set(p.info.kind, p);
    }
    ds.files.push(p.info);
  }
  for (const { data } of byKind.values()) Object.assign(ds, data);
  return ds;
}
