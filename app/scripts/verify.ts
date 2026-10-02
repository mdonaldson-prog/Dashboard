// Prints last week's KPI values and the count plan for a folder of exports.
// Usage: npm run verify -- <folder> [weekMonday]
import { buildContext } from "../src/calc/context";
import { planCounts } from "../src/calc/counts";
import { addDays } from "../src/calc/dates";
import { KPIS, factsIn, filterLoc, valueOf } from "../src/calc/kpis";
import { DEFAULT_SETTINGS } from "../src/data/settings";
import { loadFolder } from "./load-files";

const dir = process.argv[2];
// SKIP: comma-separated file-name fragments to ignore (e.g. superseded copies of a report)
const ds = loadFolder(dir, (process.env.SKIP ?? "").split(",").filter(Boolean));
for (const f of ds.files) console.log(`${f.kind ?? "UNRECOGNIZED"}\t${f.rows}\t${f.minDate ?? ""}..${f.maxDate ?? ""}\t${f.name}\n   ${f.warnings.join("\n   ")}`);
const c = buildContext(ds, structuredClone(DEFAULT_SETTINGS));
const wk = process.argv[3] ?? c.defaultWeek;
console.log(`\nlatest ${c.latest}  week ${wk}..${addDays(wk, 6)}`);
for (const k of KPIS) {
  const f = filterLoc(k, k.facts(c), "All");
  const w = k.pointInTime ? f : factsIn(f, wk, addDays(wk, 6));
  const v = valueOf(k, w.reduce((a, x) => a + x.num, 0), w.reduce((a, x) => a + x.den, 0), w.length);
  const ex = k.extras ? " | " + k.extras(w).map((e) => `${e.label}=${Math.round(e.value * 100) / 100}`).join(", ") : "";
  console.log(`${k.name.padEnd(28)} ${v === null ? "—" : Math.round(v * 100) / 100}${ex}`);
}
console.log("");
for (const p of planCounts(c, structuredClone(DEFAULT_SETTINGS))) {
  console.log(`${p.location}: ${JSON.stringify(p.classCounts)} required/day ${p.requiredPerDay.toFixed(1)} cap ${p.capacity} atRisk ${p.atRisk} unplaced ${p.unplaced.length} days ${p.days.length} start ${p.start}`);
  console.log("   levers", p.levers.map((l) => `${l.label}: ${l.perDay.toFixed(1)}`).join("; "));
}
