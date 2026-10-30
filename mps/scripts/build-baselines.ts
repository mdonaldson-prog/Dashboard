// Learns the built-in baselines from a folder holding the completed MO history and the BOM.
// Usage: npm run baselines -- <folder>   → writes src/data/baselines.json
import { writeFileSync } from "node:fs";
import { learnBaselines } from "../src/calc/baselines";
import { buildModel } from "../src/calc/plan";
import { loadFolder } from "./load-files";

const ds = loadFolder(process.argv[2]);
const first = learnBaselines(ds.moHistory);
const model = buildModel(ds, first);
const gpu = (sku: string) => model.items.get(sku)?.gpu ?? 0;
const base = learnBaselines(ds.moHistory, gpu, `Built in: completed MOs ${first.from} to ${first.to}`);
writeFileSync(new URL("../src/data/baselines.json", import.meta.url), JSON.stringify(base, null, 1) + "\n");
console.log(base.source, Object.keys(base.items).length, "items,", base.auto.length, "auto-built, capacity", base.capacity);
