// Target status (red / amber / green) for a KPI value.

import type { Target } from "../data/settings";
import type { KpiDef } from "./kpis";

export type Status = "good" | "warn" | "bad";

export function targetStatus(def: KpiDef, value: number | null, t: Target | undefined): Status | null {
  if (!t || value == null || isNaN(value) || isNaN(t.value)) return null;
  const tol = Math.abs(t.value) * (t.tolerancePct / 100);
  switch (def.better) {
    case "up":
      return value >= t.value ? "good" : value >= t.value - tol ? "warn" : "bad";
    case "down":
      return value <= t.value ? "good" : value <= t.value + tol ? "warn" : "bad";
    case "near100": {
      const d = Math.abs(100 - value);
      const td = Math.abs(100 - t.value);
      return d <= td ? "good" : d <= td + tol ? "warn" : "bad";
    }
    case "near0":
      return Math.abs(value) <= Math.abs(t.value) ? "good" : Math.abs(value) <= Math.abs(t.value) + tol ? "warn" : "bad";
    default:
      return null;
  }
}

export const STATUS_LABEL: Record<Status, string> = { good: "On target", warn: "Near target", bad: "Off target" };
