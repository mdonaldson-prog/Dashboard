// Records to fix in inFlow before the next upload. Used by the "Download cleanup list" button.

import type { Ctx } from "./context";

export interface CleanupSheet {
  name: string;
  why: string;
  rows: Record<string, string | number>[];
}

export function cleanupSheets(c: Ctx): CleanupSheet[] {
  const noSku = c.ds.products
    .filter((p) => !p.hasSku)
    .map((p) => ({ Product: p.name, Category: p.category, "Item type": p.itemType, Cost: p.cost }));

  const zeroCost = c.ds.stockLevels
    .filter((x) => x.qty > 0)
    .map((x) => ({ x, p: c.product(x.sku, x.product) }))
    .filter(({ p }) => p && !p.cost)
    .map(({ x, p }) => ({ SKU: x.sku, Product: x.product, Location: x.location, Sublocation: x.sublocation, "On hand": x.qty, "Item type": p!.itemType }));

  const notInProducts = c.ds.stockLevels
    .filter((x) => !c.product(x.sku, x.product))
    .map((x) => ({ SKU: x.sku, Product: x.product, Location: x.location, Sublocation: x.sublocation, "On hand": x.qty }));

  const negative = c.ds.stockLevels
    .filter((x) => x.qty < 0)
    .map((x) => ({ SKU: x.sku, Product: x.product, Location: x.location, Sublocation: x.sublocation, "On hand": x.qty }));

  // Items sold that aren't in the product export (usually deactivated) — they get no category or cost
  const sold = new Map<string, { sku: string; product: string; lines: number; units: number; sales: number }>();
  for (const l of c.ds.soLines) {
    if (l.kind !== "item" || c.product(l.sku, l.product)) continue;
    const e = sold.get(l.sku) ?? { sku: l.sku, product: l.product, lines: 0, units: 0, sales: 0 };
    e.lines++;
    e.units += l.qty;
    e.sales += l.subtotal;
    sold.set(l.sku, e);
  }
  const soldMissing = [...sold.values()]
    .sort((a, b) => b.sales - a.sales)
    .map((e) => ({ SKU: e.sku === e.product ? "" : e.sku, Product: e.product, "Order lines": e.lines, Units: e.units, "Sales $": Math.round(e.sales * 100) / 100 }));

  return [
    { name: "Products without SKU", why: "Products in inFlow with a blank SKU. Add a SKU so sales, stock and counts link to them reliably.", rows: noSku },
    { name: "Stocked items $0 cost", why: "Items with stock on hand but no cost. Inventory value and dormant inventory are understated until a cost is entered.", rows: zeroCost },
    { name: "Stock not in products", why: "Stock Levels rows that don't match any product by SKU or name.", rows: notInProducts },
    { name: "Negative on hand", why: "Negative stock usually means a missed receipt or an unrecorded movement. Good candidates for a count.", rows: negative },
    { name: "Sold, not in products", why: "Items on sales orders that aren't in the Product Details export (often deactivated). They have no category or cost in the dashboard.", rows: soldMissing },
  ];
}
