import type { Unit } from "../calc/kpis";

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Compact for tiles: 1,284 · 12.9K · $4.2M */
export function compact(v: number, unit: Unit): string {
  if (v == null || isNaN(v)) return "—";
  if (unit === "pct") return `${nf1.format(v)}%`;
  if (unit === "days") return `${nf1.format(v)} d`;
  const a = Math.abs(v);
  const pre = unit === "usd" ? "$" : "";
  const sign = v < 0 ? "−" : "";
  if (a >= 1e6) return `${sign}${pre}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${sign}${pre}${(a / 1e3).toFixed(1)}K`;
  return unit === "usd" ? usd0.format(v) : nf0.format(v);
}

/** Full precision for tables and tooltips. */
export function full(v: number | string | null | undefined, unit?: Unit): string {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v;
  if (isNaN(v)) return "—";
  switch (unit) {
    case "usd": return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 }).format(v);
    case "pct": return `${nf1.format(v)}%`;
    case "days": return Number.isInteger(v) ? nf0.format(v) : nf1.format(v);
    case "units":
    case "count": return Number.isInteger(v) ? nf0.format(v) : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v);
    default: return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v);
  }
}

export const unitWord = (u: Unit) => ({ units: "units", pct: "%", days: "business days", usd: "USD", count: "count" })[u];
