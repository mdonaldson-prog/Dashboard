import { useState } from "preact/hooks";
import type { Dataset, FileKind } from "../data/model";
import { FILES } from "../data/model";
import { mergeFiles, parseFile } from "../data/parse";
import { IconAlert, IconCalendar, IconCheck, IconUpload } from "./icons";

export async function readFiles(files: File[], base?: Dataset): Promise<Dataset> {
  const parts = [];
  for (const f of files) parts.push(parseFile(f.name, new Uint8Array(await f.arrayBuffer())));
  return mergeFiles(parts, base);
}

/** Drop zone + checklist. With `base`, new files replace only the reports they contain. */
export function DropFiles(props: { base?: Dataset; onLoaded: (ds: Dataset) => void; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [pending, setPending] = useState<Dataset | null>(null);
  const have = new Set((pending ?? props.base)?.files.map((f) => f.kind) ?? []);

  const run = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setErr("");
    try {
      const ds = await readFiles(files, pending ?? props.base);
      const missing = (Object.keys(FILES) as FileKind[]).filter((k) => FILES[k].required && !ds.files.some((f) => f.kind === k));
      if (missing.length) setPending(ds);
      else { setPending(null); props.onLoaded(ds); }
      const bad = ds.files.filter((f) => !f.kind).map((f) => f.name);
      if (bad.length) setErr(`Not recognized: ${bad.join(", ")}`);
    } catch (e) {
      setErr(`Couldn't read the files: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack">
      <div
        class={`dropzone ${over ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); run([...(e.dataTransfer?.files ?? [])]); }}
      >
        <IconUpload />
        <div style={{ fontWeight: 600 }}>Drop the inFlow exports here</div>
        <div class="small muted">CSV or Excel. File names don't matter: each report is recognized by its columns.</div>
        <label class="btn primary">
          Choose files
          <input type="file" multiple accept=".csv,.xlsx,.xls" style={{ display: "none" }} onChange={(e) => run([...((e.target as HTMLInputElement).files ?? [])])} />
        </label>
        {busy && <div class="small muted">Reading…</div>}
        {err && <div class="badge bad"><IconAlert /> {err}</div>}
      </div>
      <div class="checklist">
        {(Object.keys(FILES) as FileKind[]).map((k) => (
          <div class={`check ${have.has(k) ? "" : FILES[k].required ? "" : "muted"}`}>
            {have.has(k) ? <span class="status-dot good"><IconCheck /></span> : <span class="status-dot empty" />}
            <span>
              {FILES[k].label}
              <span class="small muted"> · {FILES[k].when}</span>
            </span>
          </div>
        ))}
      </div>
      {pending && (
        <div class="notice warn">
          <IconAlert /> Still needed: {(Object.keys(FILES) as FileKind[]).filter((k) => FILES[k].required && !have.has(k)).map((k) => FILES[k].label).join(", ")}.
          {props.compact ? "" : " Drop them in to build the schedule."}
        </div>
      )}
    </div>
  );
}

export function Upload(props: { onLoaded: (ds: Dataset) => void }) {
  return (
    <div class="welcome">
      <div class="welcome-card">
        <div class="row" style={{ gap: 12 }}>
          <span class="brand-mark" style={{ width: 40, height: 40 }}><IconCalendar /></span>
          <div>
            <h1>Master Production Schedule</h1>
            <div class="small muted">A suggested two-week Blend, Fill and Kit schedule from demand, stock and capacity. Everything runs in this browser; nothing is uploaded.</div>
          </div>
        </div>
        <div class="card"><div class="card-body"><DropFiles onLoaded={props.onLoaded} /></div></div>
        <div class="small muted">
          Export from inFlow: <b>Inventory summary</b>, <b>Stock reordering report</b> and <b>Sales by product details</b> (last 8+ weeks) each time;
          the <b>BOM</b> monthly. Capacity and typical batch sizes are built in from your completed MOs (Jun–Oct 2026); drop a newer
          <b> completed MO</b> export in to re-learn them.
        </div>
      </div>
    </div>
  );
}
