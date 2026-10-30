// Prints the two-week schedule for a folder of exports.
// Usage: npm run verify -- <folder> [today YYYY-MM-DD]
import type { Baselines } from "../src/calc/baselines";
import { buildSchedule } from "../src/calc/plan";
import baselines from "../src/data/baselines.json";
import { DEFAULT_SETTINGS, EMPTY_EDITS } from "../src/data/settings";
import { loadFolder } from "./load-files";

const ds = loadFolder(process.argv[2]);
for (const f of ds.files) console.log(`${f.kind ?? "UNRECOGNIZED"}\t${f.rows}\t${f.name}${f.warnings.length ? "\n   " + f.warnings.join("\n   ") : ""}`);
const settings = { ...structuredClone(DEFAULT_SETTINGS), countOnOrder: process.env.ONORDER === "1" };
const s = buildSchedule(ds, baselines as Baselines, settings, structuredClone(EMPTY_EDITS), process.argv[3] ?? "2026-10-30");
const r = (n: number) => Math.round(n);
console.log(`\nSales ${s.salesFrom}..${s.salesTo} (${s.salesWorkdays} workdays). Days ${s.days[0]}..${s.days.at(-1)}. Closures: ${s.closures.map((c) => c.date).join(", ") || "none"}`);
for (const w of s.warnings) console.log("WARN", w);
for (const L of s.loads) {
  console.log(`\n== ${L.date}  blends ${L.blendStd}+${L.blendBig} big | fill ${r(L.fillGal)} gal | kits ${r(L.kits)}`);
  for (const m of s.mos.filter((m) => m.date === L.date)) console.log(`  ${m.type.padEnd(5)} ${m.name.padEnd(48)} ${m.sku.padEnd(14)} ${String(m.qty).padStart(6)}${m.type === "FILL" ? ` (${r(m.gallons)} gal)` : ""}  | ${m.why[0] ?? ""}`);
}
const tot = (t: string) => s.mos.filter((m) => m.type === t);
console.log(`\nTOTAL blends ${tot("BLEND").length} MOs ${r(tot("BLEND").reduce((a, m) => a + m.qty, 0))} gal | fills ${tot("FILL").length} MOs ${r(tot("FILL").reduce((a, m) => a + m.gallons, 0))} gal | kits ${tot("KIT").length} MOs ${r(tot("KIT").reduce((a, m) => a + m.qty, 0))}`);
console.log(`\nDIDN'T FIT (${s.unplaced.length})`);
for (const u of s.unplaced) console.log(`  ${u.type} ${u.sku} ${u.qty}: ${u.reason}`);
console.log(`\nBLOCKED BY RAW MATERIALS (${s.shortages.length})`);
for (const x of s.shortages) console.log(`  ${x.type} ${x.sku} ${x.qtyBlocked}: ${x.missing.map((m) => `${m.component ? "[made] " : ""}${m.sku} need ${r(m.need)} have ${r(m.have)}`).join("; ")}`);
console.log(`\nMATERIALS SHORT`);
for (const m of s.materials) console.log(`  ${m.sku.padEnd(14)} ${m.name.slice(0, 40).padEnd(40)} need ${r(m.needed)} avail ${r(m.available)} short ${r(m.short)} ${m.onOrder > 0 ? `PO on order ${r(m.onOrder)}` : "No PO"}`);
console.log(`\nFLAGGED (${s.flags.length})`);
for (const f of s.flags) console.log(`  ${f.kind} ${f.sku} ${f.product}: ${f.message} suggest ${f.suggestQty}`);
