import { useState } from "preact/hooks";
import type { Api } from "../App";
import type { ItemPlan } from "../calc/plan";
import { LANE_LABEL, LANES, type Lane } from "../data/settings";
import { downloadCsv } from "./csv";
import { fmt } from "./format";
import { IconDownload } from "./icons";

const COLS: { key: keyof ItemPlan; label: string; num?: boolean; title?: string }[] = [
  { key: "sku", label: "SKU" },
  { key: "product", label: "Product" },
  { key: "type", label: "Type" },
  { key: "available", label: "Available", num: true },
  { key: "reorderPoint", label: "Reorder pt", num: true },
  { key: "salesPerDay", label: "Sold/day", num: true, title: "Sold directly, per workday" },
  { key: "viaAutoPerDay", label: "Via auto-builds/day", num: true, title: "Used by 15-gal and private-label kits that are auto-built" },
  { key: "dependentPerDay", label: "Used by scheduled/day", num: true, title: "Used by the kits and fills this planner schedules" },
  { key: "coverDays", label: "Days of supply", num: true },
  { key: "target", label: "Target", num: true, title: "Cover + safety days of demand (reorder point as a minimum), plus what scheduled parents need" },
  { key: "batch", label: "Batch", num: true },
  { key: "planned", label: "Planned", num: true },
  { key: "scheduled", label: "Scheduled", num: true },
  { key: "blocked", label: "Short", num: true, title: "Held up by raw materials" },
  { key: "unplaced", label: "Didn't fit", num: true },
];

export function PlanTable(props: { api: Api }) {
  const { sched, s } = props.api;
  const [q, setQ] = useState("");
  const [lane, setLane] = useState<Lane | "ALL">("ALL");
  const [onlyPlanned, setOnlyPlanned] = useState(true);
  const [sort, setSort] = useState<{ key: keyof ItemPlan; dir: 1 | -1 }>({ key: "coverDays", dir: 1 });
  const rows = sched.plans
    .filter((p) => (lane === "ALL" || p.type === lane) && (!onlyPlanned || p.planned > 0) && (!q || `${p.sku} ${p.product}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" ? (x as number) - (y as number) : String(x).localeCompare(String(y))) * sort.dir;
    });
  return (
    <div class="card">
      <div class="card-head">
        <h2>Every item the planner looked at</h2>
        <span class="card-sub">Demand from sales {sched.salesFrom} to {sched.salesTo} ({sched.salesWorkdays} workdays). Target = {s.coverDays} + {s.safetyDays} safety days.</span>
      </div>
      <div class="card-body stack">
        <div class="row">
          <input class="input" placeholder="Search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          <div class="seg">
            {(["ALL", ...LANES] as const).map((l) => <button aria-pressed={lane === l} onClick={() => setLane(l)}>{l === "ALL" ? "All" : LANE_LABEL[l]}</button>)}
          </div>
          <label class="toggle"><input type="checkbox" checked={onlyPlanned} onChange={(e) => setOnlyPlanned((e.target as HTMLInputElement).checked)} /> Only items with a plan</label>
          <span class="spacer" />
          <button class="btn" onClick={() => downloadCsv("plan-details.csv", COLS.map((c) => c.label), rows.map((r) => COLS.map((c) => r[c.key] as string | number | null)))}><IconDownload /> CSV</button>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>{COLS.map((c) => (
                <th class={c.num ? "num" : ""} title={c.title} onClick={() => setSort((p) => ({ key: c.key, dir: p.key === c.key ? (-p.dir as 1 | -1) : 1 }))}>
                  {c.label}{sort.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>{COLS.map((c) => <td class={c.num ? "num" : ""}>{c.key === "type" ? LANE_LABEL[r.type] : c.num ? fmt(r[c.key] as number) : String(r[c.key])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="table-foot">{rows.length} items</div>
      </div>
    </div>
  );
}
