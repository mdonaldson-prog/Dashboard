// Reads every export in a folder the same way the page does.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeFiles, parseFile } from "../src/data/parse";

export function loadFolder(dir: string) {
  const parts = readdirSync(dir)
    .filter((f) => /\.(csv|xlsx|xls)$/i.test(f))
    .map((f) => parseFile(f, new Uint8Array(readFileSync(join(dir, f)))));
  return mergeFiles(parts);
}
