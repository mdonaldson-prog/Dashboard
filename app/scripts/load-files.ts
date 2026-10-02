// Node helper: parse every export in a folder with the same code the browser uses.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDataset, parseFile } from "../src/data/parse";

export function loadFolder(dir: string, skip: string[] = []) {
  const files = readdirSync(dir).filter((f) => /\.(csv|xlsx)$/i.test(f) && !skip.some((s) => f.includes(s)));
  return buildDataset(files.map((f) => parseFile(f, new Uint8Array(readFileSync(join(dir, f))))));
}
