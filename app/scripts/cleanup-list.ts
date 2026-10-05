// Writes the data cleanup workbook for a folder of exports. Usage: npm run cleanup -- <folder> <out.xlsx>
import * as XLSX from "xlsx";
import { buildContext } from "../src/calc/context";
import { cleanupSheets } from "../src/calc/cleanup";
import { DEFAULT_SETTINGS } from "../src/data/settings";
import { loadFolder } from "./load-files";

const [dir, out = "data-cleanup.xlsx"] = process.argv.slice(2);
const c = buildContext(loadFolder(dir, (process.env.SKIP ?? "").split(",").filter(Boolean)), structuredClone(DEFAULT_SETTINGS));
const wb = XLSX.utils.book_new();
const sheets = cleanupSheets(c);
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Sheet", "Rows", "What to fix"], ...sheets.map((s) => [s.name, s.rows.length, s.why])]), "Summary");
for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ Note: "Nothing to fix" }]), s.name.slice(0, 31));
XLSX.writeFile(wb, out);
console.log(sheets.map((s) => `${s.name}: ${s.rows.length}`).join("\n"));
