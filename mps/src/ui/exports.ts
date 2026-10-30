import type { Schedule } from "../calc/plan";
import { LANE_LABEL } from "../data/settings";
import { downloadCsv } from "./csv";

/** The suggested MOs, one row each, in schedule order. */
export function exportMos(sched: Schedule) {
  downloadCsv(
    `suggested-mos-${sched.days[0]}.csv`,
    ["Date", "Manufacture Order #", "Type", "SKU", "Product", "Quantity", "Gallons", "Locked", "Manual", "Why"],
    sched.mos.map((m) => [m.date, m.name, LANE_LABEL[m.type], m.sku, m.product, m.qty, m.gallons || "", m.pinned ? "Yes" : "", m.manual ? "Yes" : "", m.why.join(" ")]),
  );
}
