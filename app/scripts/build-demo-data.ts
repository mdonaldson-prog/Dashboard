// Builds demo-data/demo.json from a folder of sample exports, using the same parser as the app.
// Only the normalized fields the dashboard uses are kept (no customer emails, phones or addresses).
// Usage: npm run demo-data -- <folder>
import { mkdirSync, writeFileSync } from "node:fs";
import { loadFolder } from "./load-files";

const dir = process.argv[2] ?? process.env.SAMPLE_DIR;
if (!dir) throw new Error("Pass the folder with the sample exports");
// SKIP: comma-separated file-name fragments to ignore (e.g. superseded copies of a report)
const ds = loadFolder(dir, (process.env.SKIP ?? "").split(",").filter(Boolean));
mkdirSync("demo-data", { recursive: true });
writeFileSync("demo-data/demo.json", JSON.stringify(ds));
console.log(`demo-data/demo.json: ${ds.files.length} files, ${(JSON.stringify(ds).length / 1e6).toFixed(1)} MB`);
