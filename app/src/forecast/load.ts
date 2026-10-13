// Reads the files the forecast needs: Sales Orders, BOM and (optionally) a product/cost export.
// Uses the dashboard's parser; a file it doesn't recognize is tried as a plain SKU + cost list.

import type { FileInfo, Product } from "../data/model";
import { fixText, num, parseFile, readRows } from "../data/parse";
import { namedStore } from "../data/store";
import type { Dataset } from "../data/model";

export type ForecastData = Pick<Dataset, "salesOrders" | "soLines" | "bom" | "products"> & {
  files: Partial<Record<"salesOrders" | "bom" | "products", FileInfo>>;
};

export const emptyForecastData = (): ForecastData => ({ salesOrders: [], soLines: [], bom: [], products: [], files: {} });

export const forecastStore = namedStore<ForecastData>("demand-forecast");

const SKU_COLS = [/^sku$/i, /^product ?sku$/i, /^item ?(#|number|code)$/i, /^part ?(#|number)$/i];
const COST_COLS = [/^cost$/i, /^unit ?cost$/i, /^default ?cost$/i, /^last ?purchase ?price$/i, /^purchase ?price$/i, /^average ?cost$/i, /^price$/i, /^unit ?price$/i];

/** Any sheet with a SKU column and a cost/price column, for when the export isn't the standard Product Details. */
function priceList(name: string, bytes: Uint8Array): { info: FileInfo; products: Product[] } | null {
  const rows = readRows(name, bytes);
  if (!rows.length) return null;
  const headers = Object.keys(rows[0]);
  const skuCol = SKU_COLS.map((re) => headers.find((h) => re.test(h.trim()))).find(Boolean);
  const costCol = COST_COLS.map((re) => headers.find((h) => re.test(h.trim()))).find(Boolean);
  if (!skuCol || !costCol) return null;
  const nameCol = headers.find((h) => /^(product ?name|name|description|item)$/i.test(h.trim()));
  const products: Product[] = [];
  for (const r of rows) {
    const sku = fixText(r[skuCol]);
    const cost = num(r[costCol]);
    if (!sku || !(cost > 0)) continue;
    products.push({ sku, name: nameCol ? fixText(r[nameCol]) : sku, category: "", itemType: "", cost, autoManufacture: false, isActive: true, hasSku: true });
  }
  return { info: { name, kind: "products", rows: rows.length, warnings: [`Read as a price list: "${skuCol}" + "${costCol}".`] }, products };
}

/** Adds files to the current data. A newer file of the same kind replaces the older one. */
export async function addFiles(cur: ForecastData, files: File[]): Promise<{ data: ForecastData; ignored: string[] }> {
  const data: ForecastData = { ...cur, files: { ...cur.files } };
  const ignored: string[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const { info, data: d } = parseFile(f.name, bytes);
    if (info.kind === "salesOrders") {
      data.salesOrders = d.salesOrders ?? [];
      data.soLines = d.soLines ?? [];
      data.files.salesOrders = info;
    } else if (info.kind === "bom") {
      data.bom = d.bom ?? [];
      data.files.bom = info;
    } else if (info.kind === "products") {
      data.products = d.products ?? [];
      data.files.products = info;
    } else {
      const pl = priceList(f.name, bytes);
      if (pl) {
        data.products = pl.products;
        data.files.products = pl.info;
      } else ignored.push(f.name);
    }
  }
  return { data, ignored };
}
