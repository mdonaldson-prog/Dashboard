// Reads the files the forecast needs: Sales Orders and BOM, with the dashboard's parser.

import type { Dataset, FileInfo } from "../data/model";
import { parseFile } from "../data/parse";
import { namedStore } from "../data/store";

export type ForecastData = Pick<Dataset, "salesOrders" | "soLines" | "bom"> & {
  files: Partial<Record<"salesOrders" | "bom", FileInfo>>;
};

export const emptyForecastData = (): ForecastData => ({ salesOrders: [], soLines: [], bom: [], files: {} });

export const forecastStore = namedStore<ForecastData>("demand-forecast");

/** Adds files to the current data. A newer file of the same kind replaces the older one. */
export async function addFiles(cur: ForecastData, files: File[]): Promise<{ data: ForecastData; ignored: string[] }> {
  const data: ForecastData = { ...cur, files: { ...cur.files } };
  const ignored: string[] = [];
  for (const f of files) {
    const { info, data: d } = parseFile(f.name, new Uint8Array(await f.arrayBuffer()));
    if (info.kind === "salesOrders") {
      data.salesOrders = d.salesOrders ?? [];
      data.soLines = d.soLines ?? [];
      data.files.salesOrders = info;
    } else if (info.kind === "bom") {
      data.bom = d.bom ?? [];
      data.files.bom = info;
    } else ignored.push(f.name);
  }
  return { data, ignored };
}
