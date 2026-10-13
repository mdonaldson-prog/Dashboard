// Prints the demand forecast summary for a folder of exports (Sales Orders + BOM, optional Product
// Details for component cost), using the same code as Forecast.html.
//   npm run verify:forecast -- /path/to/exports
import { buildForecast, DEFAULT_FORECAST_SETTINGS, LOCATIONS, sumQA, type Series } from "../src/forecast/engine";
import { loadFolder } from "./load-files";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: npm run verify:forecast -- <folder with exports>");
  process.exit(1);
}
const ds = loadFolder(dir);
const f = buildForecast(ds, DEFAULT_FORECAST_SETTINGS);
const usd = (v: number) => `$${Math.round(v).toLocaleString()}`;
const n = (v: number) => Math.round(v).toLocaleString();
const idx = (pred: (k: string) => boolean) => f.months.flatMap((m, i) => (pred(m.key) ? [i] : []));
const actual26 = idx((k) => k.startsWith("2026") && f.months.find((m) => m.key === k)!.kind === "actual");
const rest26 = idx((k) => k.startsWith("2026") && f.months.find((m) => m.key === k)!.kind !== "actual");
const y27 = idx((k) => k.startsWith("2027"));
const at = (rows: Series[], loc: string) => rows.filter((r) => loc === "All" || r.location === loc);

console.log(`Latest order ${f.latest}; baseline ${f.baselineMonths.join(", ")}; ${f.months.length} months to ${f.months.at(-1)!.key}`);
console.log(`Excluded: tax/adj ${f.excluded.tax.lines}, fees ${f.excluded.fees.lines} (${usd(f.excluded.fees.amount)}), drop-ship ${f.excluded.dropship.lines} (${usd(f.excluded.dropship.amount)}), quotes ${f.excluded.quotes.lines}`);
console.log(`Blank location → Aurora: ${f.blankLocationLines} lines. Deactivated SKUs merged: ${f.mergedDeactivated} lines.`);
console.log("\nFinished goods            baseline/mo        2026 actual    rest of 2026         2027");
for (const loc of ["All", ...LOCATIONS]) {
  const rows = at(f.fg, loc);
  const b = rows.reduce((a, r) => a + r.baseline.a, 0);
  console.log(`  ${loc.padEnd(10)} ${usd(b).padStart(20)} ${usd(sumQA(rows, actual26).a).padStart(18)} ${usd(sumQA(rows, rest26).a).padStart(15)} ${usd(sumQA(rows, y27).a).padStart(12)}   (${n(sumQA(rows, y27).q)} units, ${new Set(rows.map((r) => r.sku)).size} SKUs)`);
}
const raw = f.components.filter((r) => r.type === "Raw");
const inter = f.components.filter((r) => r.type === "Intermediate");
console.log(`\nComponents (planned at Aurora): ${new Set(raw.map((r) => r.sku)).size} raw, ${new Set(inter.map((r) => r.sku)).size} intermediate SKUs`);
for (const loc of ["All", ...LOCATIONS]) {
  const rows = raw.filter((r) => loc === "All" || r.drivenBy === loc);
  console.log(`  raw driven by ${loc.padEnd(8)} 2027 qty ${n(sumQA(rows, y27).q).padStart(10)}  $ ${f.hasPrices ? usd(sumQA(rows, y27).a) : "(no cost file)"}`);
}
const top = new Map<string, { name: string; q: number }>();
for (const r of raw) {
  const t = top.get(r.sku) ?? { name: r.name, q: 0 };
  t.q += sumQA([r], y27).q;
  top.set(r.sku, t);
}
console.log("\nTop raw components, 2027 qty:");
for (const [sku, t] of [...top].sort((a, b) => b[1].q - a[1].q).slice(0, 10)) console.log(`  ${sku.padEnd(14)} ${n(t.q).padStart(9)}  ${t.name}`);
if (f.notes.length) console.log("\nNotes:\n  " + f.notes.join("\n  "));
