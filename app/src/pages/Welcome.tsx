import { useState } from "preact/hooks";
import type { Dataset, ReportKind } from "../data/model";
import { REPORTS } from "../data/model";
import { buildDataset, parseFile } from "../data/parse";
import { IconCheck, IconFolder, IconUpload } from "../ui/icons";

const WEEKLY = (Object.keys(REPORTS) as ReportKind[]).filter((k) => REPORTS[k].weekly);

/** Read every CSV/XLSX in a chosen folder (and its inflow-exports / carrier-files subfolders). */
async function filesFromFolder(): Promise<File[]> {
  const dir = await (window as any).showDirectoryPicker({ mode: "read" });
  const out: File[] = [];
  const walk = async (d: any, depth: number) => {
    for await (const entry of d.values()) {
      if (entry.kind === "file" && /\.(csv|xlsx|xls)$/i.test(entry.name)) out.push(await entry.getFile());
      else if (entry.kind === "directory" && depth < 1) await walk(entry, depth + 1);
    }
  };
  await walk(dir, 0);
  return out;
}

export async function loadFiles(files: File[], onProgress: (p: number, name: string) => void): Promise<Dataset> {
  const parsed = [];
  for (let i = 0; i < files.length; i++) {
    onProgress(i / files.length, files[i].name);
    await new Promise((r) => setTimeout(r, 16)); // let the progress bar paint
    parsed.push(parseFile(files[i].name, new Uint8Array(await files[i].arrayBuffer())));
  }
  onProgress(1, "");
  return buildDataset(parsed);
}

export function Welcome(props: { demo: Dataset | null; onLoaded: (d: Dataset) => void }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<{ p: number; name: string } | null>(null);
  const [err, setErr] = useState("");
  const canFolder = typeof (window as any).showDirectoryPicker === "function";

  const run = async (files: File[]) => {
    if (!files.length) return;
    setErr("");
    try {
      const ds = await loadFiles(files, (p, name) => setBusy({ p, name }));
      if (!ds.files.some((f) => f.kind)) {
        setErr("None of these files look like the weekly reports. Check the list below.");
        setBusy(null);
        return;
      }
      props.onLoaded(ds);
    } catch (e) {
      setErr(`Could not read the files: ${(e as Error).message}`);
      setBusy(null);
    }
  };

  return (
    <div class="welcome">
      <div class="welcome-card">
        <div>
          <div class="brand" style={{ padding: "0 0 8px" }}><span class="brand-mark"><IconUpload /></span> Operations dashboard</div>
          <h1 style={{ fontSize: 26 }}>Load this week's reports</h1>
          <p class="secondary" style={{ margin: "6px 0 0" }}>
            Everything runs in this browser. Nothing is uploaded anywhere.
          </p>
        </div>
        <div
          class={`drop ${over ? "over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); run([...(e.dataTransfer?.files ?? [])]); }}
        >
          <IconUpload />
          <div style={{ fontWeight: 600 }}>Drop the export files here</div>
          <div class="small muted">CSV or Excel. File names don't matter — each report is recognized by its columns.</div>
          <div class="row" style={{ justifyContent: "center" }}>
            <label class="btn primary">
              Choose files
              <input type="file" multiple accept=".csv,.xlsx,.xls" style={{ display: "none" }} onChange={(e) => run([...((e.target as HTMLInputElement).files ?? [])])} />
            </label>
            {canFolder && (
              <button class="btn" onClick={async () => { try { run(await filesFromFolder()); } catch { /* cancelled */ } }}>
                <IconFolder /> Open folder
              </button>
            )}
            {props.demo && <button class="btn" onClick={() => props.onLoaded(props.demo!)}>Use sample data</button>}
          </div>
          {busy && (
            <div style={{ width: "100%", maxWidth: 360 }}>
              <div class="progress"><span style={{ width: `${Math.round(busy.p * 100)}%` }} /></div>
              <div class="small muted" style={{ marginTop: 6 }}>{busy.name ? `Reading ${busy.name}…` : "Calculating…"}</div>
            </div>
          )}
          {err && <div class="badge bad">{err}</div>}
        </div>
        <div class="card">
          <div class="card-body">
            <h3 style={{ marginBottom: 10 }}>Weekly reports</h3>
            <div class="checklist">
              {WEEKLY.map((k) => (
                <div class="check"><IconCheck /> {REPORTS[k].label}</div>
              ))}
              <div class="check muted"><IconCheck /> BOM (monthly, or when BOMs change)</div>
            </div>
            <p class="small muted" style={{ margin: "12px 0 0" }}>
              Dated reports: export the last 90 days. Stock Levels and Product Details: current, no date filter.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
