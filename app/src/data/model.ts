// Normalized tables built from the inFlow and freight-portal exports.
// Dates are ISO "YYYY-MM-DD" strings in the company's local calendar.

export type ReportKind =
  | "salesOrders"
  | "shipped"
  | "mfgOrders"
  | "stockCounts"
  | "stockLevels"
  | "products"
  | "bom"
  | "shipments"
  | "transfers";

export const REPORTS: Record<ReportKind, { label: string; weekly: boolean; dated: boolean }> = {
  salesOrders: { label: "Sales Orders", weekly: true, dated: true },
  shipped: { label: "MD Sales Orders Shipped", weekly: true, dated: true },
  mfgOrders: { label: "MD Complete MFG Orders", weekly: true, dated: true },
  stockCounts: { label: "Stock count report (completed)", weekly: true, dated: true },
  stockLevels: { label: "Stock Levels", weekly: true, dated: false },
  products: { label: "Product Details", weekly: true, dated: false },
  shipments: { label: "Shipment Summary (freight portal, one per account: Aurora + DFW/Houston)", weekly: true, dated: true },
  transfers: { label: "Stock transfer report (not used)", weekly: false, dated: false },
  bom: { label: "BOM (monthly)", weekly: false, dated: false },
};

export type LineKind = "item" | "adjustment" | "tax";

export interface SoLine {
  order: string;
  kind: LineKind;
  sku: string;
  product: string;
  qty: number;
  subtotal: number;
}

export interface SalesOrder {
  order: string;
  customer: string;
  location: string; // "Unassigned" when blank
  orderDate: string;
  carrier: string; // raw inFlow value, "" when blank
  freight: number; // charged to the customer
  status: string;
  isQuote: boolean;
  cancelled: boolean;
}

export interface ShippedOrder {
  order: string;
  orderDate: string;
  fulfilledDate: string;
}

export type MoType = "blend" | "fill" | "kit" | "kit_auto" | "other";

export interface MfgOrder {
  mo: string;
  sku: string;
  product: string;
  category: string;
  type: MoType;
  qty: number;
  orderDate: string;
  completedDate: string;
  unitCost: number;
}

export interface CountLine {
  count: string;
  location: string;
  sublocation: string;
  sku: string;
  product: string;
  started: string;
  reported: number;
  counted: number | null; // null = not counted
  adjValue: number; // $ value of the count adjustment (negative = loss)
}

export interface StockLevel {
  sku: string;
  product: string;
  location: string;
  sublocation: string;
  qty: number;
}

export interface Product {
  sku: string;
  name: string;
  category: string;
  itemType: string;
  cost: number;
  autoManufacture: boolean;
  isActive: boolean;
  hasSku: boolean; // false when the SKU was blank (the name is used as the key)
}

export interface BomLine {
  parent: string;
  component: string;
  qty: number;
}

export interface Shipment {
  id: string;
  status: string;
  direction: "OUTBOUND" | "INBOUND" | string;
  mode: string;
  carrier: string;
  origin: string;
  originCity: string;
  dest: string;
  destCity: string;
  pickup: string;
  scheduledDelivery: string;
  actualArrival: string;
  reference: string;
  orderRefs: string;
  weight: number;
  cost: number;
}

export interface TransferLine {
  transfer: string;
  sku: string;
  product: string;
  transferDate: string;
  sent: string;
  received: string; // "" = in transit
  from: string;
  to: string;
  qty: number;
  cost: number;
}

export interface FileInfo {
  name: string;
  kind: ReportKind | null;
  rows: number;
  minDate?: string;
  maxDate?: string;
  warnings: string[];
}

export interface Dataset {
  loadedAt: string;
  files: FileInfo[];
  salesOrders: SalesOrder[];
  soLines: SoLine[];
  shipped: ShippedOrder[];
  mfgOrders: MfgOrder[];
  countLines: CountLine[];
  stockLevels: StockLevel[];
  products: Product[];
  bom: BomLine[];
  shipments: Shipment[];
  transfers: TransferLine[];
}

export const emptyDataset = (): Dataset => ({
  loadedAt: new Date().toISOString(),
  files: [],
  salesOrders: [],
  soLines: [],
  shipped: [],
  mfgOrders: [],
  countLines: [],
  stockLevels: [],
  products: [],
  bom: [],
  shipments: [],
  transfers: [],
});
