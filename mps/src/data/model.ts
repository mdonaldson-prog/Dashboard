// Normalized shapes for the inFlow exports this tool reads.

export type FileKind = "inventory" | "reorder" | "sales" | "bom" | "po" | "moHistory";

export const FILES: Record<FileKind, { label: string; when: string; required: boolean }> = {
  inventory: { label: "Inventory summary", when: "Every run", required: true },
  reorder: { label: "Stock reordering report", when: "Every run", required: true },
  sales: { label: "Sales by product details (last 8+ weeks)", when: "Every run", required: true },
  bom: { label: "inFlow BOM", when: "Monthly, or when BOMs change", required: true },
  po: { label: "Purchase order status", when: "Each run: raw material due dates", required: false },
  moHistory: { label: "Completed MO history", when: "Optional: re-learns batch sizes and capacity", required: false },
};

export interface StockRow {
  sku: string;
  name: string;
  category: string;
  owned: number;
  reserved: number;
  onOrder: number;
  available: number;
}

export interface ReorderRow {
  sku: string;
  name: string;
  method: string;
  onOrder: number;
  anticipated: number;
  reorderPoint: number;
  suggested: number;
}

export interface SaleRow {
  sku: string;
  name: string;
  date: string; // YYYY-MM-DD
  qty: number;
}

export interface BomLine {
  parent: string;
  parentName: string;
  comp: string;
  compName: string;
  qty: number;
}

export interface PoRow {
  po: string;
  vendor: string;
  location: string;
  sku: string;
  name: string;
  /** Requested ship date, YYYY-MM-DD; blank when the PO has none. */
  due: string;
  remaining: number;
}

export interface MoRow {
  sku: string;
  name: string;
  mo: string;
  type: string; // TYPE column, may be blank
  qty: number;
  completed: string; // YYYY-MM-DD
}

export interface FileInfo {
  name: string;
  kind: FileKind | null;
  rows: number;
  warnings: string[];
}

export interface Dataset {
  files: FileInfo[];
  loadedAt: string;
  inventory: StockRow[];
  reorder: ReorderRow[];
  sales: SaleRow[];
  bom: BomLine[];
  /** Open purchase order lines. Missing on datasets saved before PO support. */
  pos?: PoRow[];
  moHistory: MoRow[];
}

export const emptyDataset = (): Dataset => ({
  files: [],
  loadedAt: "",
  inventory: [],
  reorder: [],
  sales: [],
  bom: [],
  pos: [],
  moHistory: [],
});
