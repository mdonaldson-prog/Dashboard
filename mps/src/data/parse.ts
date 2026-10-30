// Turns inFlow export files into normalized tables. Each report is recognized by its
// column headings, so file names don't matter. Works in the browser and in Node.

import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { Dataset, FileInfo, FileKind } from "./model";
import { emptyDataset } from "./model";

type Row = Record<string, unknown>;

/** Repairs UTF-8 text that was decoded as Latin-1 ("HyperBONDÂ®") and drops replacement chars. */
export function fixText(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/[ÂÃ][\u0080-ÿ]/.test(s)) {
    try {
      s = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff)));
    } catch {
      s = s.replace(/Â(?=[®©°±·])/g, "");
    }
  }
  return s.replace(/ï¿½|�/g, "").replace(/\s+/g, " ").trim();
}

/** "$1,178.67", "-525", "6,807.6386 gal." → number. Blank → 0. */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  const s = v == null ? "" : String(v).trim();
  const m = s.replace(/[$,()]/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  const n = parseFloat(m[0]);
  return /^\(.*\)$/.test(s) ? -Math.abs(n) : n;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

/** "Oct 23, 2026", "10/23/2026", "2026-10-23" or an Excel date → "2026-10-23". */
export function parseDate(v: unknown): string {
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v ?? "").trim();
  let m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(+m[2])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

const SIGNATURES: [FileKind, string[]][] = [
  ["inventory", ["SKU", "Qty Owned", "Qty Available"]],
  ["reorder", ["SKU", "Reorder Method", "Reorder Point", "Suggested Quantity"]],
  ["sales", ["SKU", "Quantity Sold", "Order Number"]],
  ["bom", ["FinishedProductSKU", "ComponentProductSKU"]],
  ["po", ["PO Number", "Remaining Qty", "SKU"]],
  ["moHistory", ["Manufacture Order #", "Completed Date"]],
];

export function detectKind(headers: string[]): FileKind | null {
  const set = new Set(headers.map((h) => h.trim()));
  for (const [kind, cols] of SIGNATURES) if (cols.every((c) => set.has(c))) return kind;
  return null;
}

function readRows(name: string, bytes: Uint8Array): Row[] {
  if (/\.(xlsx|xls|xlsm)$/i.test(name)) {
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    return XLSX.utils.sheet_to_json<Row>(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: true });
  }
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  return Papa.parse<Row>(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.replace(/^﻿/, "").trim() }).data;
}

/** Parse one file into a partial dataset plus a file report. */
export function parseFile(name: string, bytes: Uint8Array): { info: FileInfo; data: Partial<Dataset> } {
  const rows = readRows(name, bytes);
  const kind = detectKind(rows.length ? Object.keys(rows[0]) : []);
  const info: FileInfo = { name, kind, rows: rows.length, warnings: [] };
  const s = (r: Row, k: string) => fixText(r[k]);
  const data: Partial<Dataset> = {};
  let blankSku = 0;

  switch (kind) {
    case "inventory":
      data.inventory = [];
      for (const r of rows) {
        const sku = s(r, "SKU");
        if (!sku) { blankSku++; continue; }
        data.inventory.push({
          sku, name: s(r, "ProductName"), category: s(r, "Category"),
          owned: num(r["Qty Owned"]), reserved: num(r["Qty Reserved"]), onOrder: num(r["Qty On Order"]), available: num(r["Qty Available"]),
        });
      }
      break;
    case "reorder":
      data.reorder = [];
      for (const r of rows) {
        const sku = s(r, "SKU");
        if (!sku) { blankSku++; info.warnings.push(`"${s(r, "ProductName")}" has no SKU and was skipped.`); continue; }
        data.reorder.push({
          sku, name: s(r, "ProductName"), method: s(r, "Reorder Method"), onOrder: num(r["Qty On Order"]),
          anticipated: num(r["Current Anticipated Qty"]), reorderPoint: num(r["Reorder Point"]), suggested: num(r["Suggested Quantity"]),
        });
      }
      blankSku = 0;
      break;
    case "sales":
      data.sales = [];
      for (const r of rows) {
        const sku = s(r, "SKU");
        const date = parseDate(r["Date"] || r["Order Date"]);
        if (!sku || !date) continue;
        data.sales.push({ sku, name: s(r, "ProductName"), date, qty: num(r["Quantity Sold"]) });
      }
      break;
    case "bom": {
      data.bom = [];
      let inactive = 0;
      for (const r of rows) {
        if (String(r["IsActive"]).trim().toLowerCase() === "false") { inactive++; continue; }
        const parent = s(r, "FinishedProductSKU");
        const comp = s(r, "ComponentProductSKU");
        if (!parent || !comp) continue;
        data.bom.push({ parent, parentName: s(r, "FinishedProduct"), comp, compName: s(r, "ComponentProduct"), qty: num(r["Quantity"]) });
      }
      if (inactive) info.warnings.push(`${inactive} inactive BOM lines ignored.`);
      break;
    }
    case "po":
      data.pos = [];
      for (const r of rows) {
        const sku = s(r, "SKU");
        const remaining = num(r["Remaining Qty"]);
        if (!sku || remaining <= 0) continue;
        data.pos.push({
          po: s(r, "PO Number"), vendor: s(r, "VendorName"), location: s(r, "Location"), sku, name: s(r, "ProductName"),
          due: parseDate(r["Requested Ship Date"]), remaining,
        });
      }
      if (data.pos.some((p) => !p.due)) info.warnings.push(`${data.pos.filter((p) => !p.due).length} open lines have no requested ship date and aren't counted.`);
      break;
    case "moHistory":
      data.moHistory = [];
      for (const r of rows) {
        const sku = s(r, "SKU");
        const completed = parseDate(r["Completed Date"]);
        if (!sku || !completed) continue;
        data.moHistory.push({ sku, name: s(r, "ProductName"), mo: s(r, "Manufacture Order #"), type: s(r, "TYPE").toUpperCase(), qty: num(r["Quantity"]), completed });
      }
      break;
    default:
      info.warnings.push("Not recognized. Expected an inventory summary, stock reordering report, sales by product details, BOM, purchase order status, or completed MO history.");
  }
  if (blankSku) info.warnings.push(`${blankSku} rows without a SKU skipped.`);
  return { info, data };
}

/** Merge parsed files. A later file of the same kind replaces the earlier one. */
export function mergeFiles(parts: { info: FileInfo; data: Partial<Dataset> }[], base?: Dataset): Dataset {
  const ds: Dataset = base ? { ...base, files: [...base.files] } : emptyDataset();
  for (const p of parts) {
    if (p.info.kind) {
      ds.files = ds.files.filter((f) => f.kind !== p.info.kind);
      Object.assign(ds, p.data);
    }
    ds.files.push(p.info);
  }
  ds.files = ds.files.filter((f, i, a) => f.kind || a.findIndex((g) => g.name === f.name) === i);
  ds.loadedAt = new Date().toISOString();
  return ds;
}
