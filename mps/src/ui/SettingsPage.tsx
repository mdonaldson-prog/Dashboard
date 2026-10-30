import { useState } from "preact/hooks";
import type { Api } from "../App";
import { HOLIDAY_RULES, holidaysForYear, longDate, today } from "../calc/dates";
import { FILES } from "../data/model";
import type { Capacity, Settings } from "../data/settings";
import { DEFAULT_SETTINGS, loadEdits } from "../data/settings";
import { downloadBlob } from "./csv";
import { fmt } from "./format";
import { IconDownload, IconUpload, IconX } from "./icons";
import { DropFiles } from "./Upload";

function NumField(props: { label: string; value: number; onChange: (n: number) => void; step?: number; suffix?: string; hint?: string }) {
  return (
    <label class="field" title={props.hint}>
      {props.label}
      <span class="row" style={{ gap: 6 }}>
        <input class="input" type="number" min={0} step={props.step ?? 1} style={{ width: 110 }} value={props.value}
          onChange={(e) => { const v = +(e.target as HTMLInputElement).value; if (isFinite(v) && v >= 0) props.onChange(v); }} />
        {props.suffix && <span class="small muted">{props.suffix}</span>}
      </span>
    </label>
  );
}

export function SettingsPage(props: { api: Api }) {
  const { api } = props;
  const { s, setS, base, ds } = api;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));
  const setCap = <K extends keyof Capacity>(k: K, v: number) => setS((x) => ({ ...x, capacity: { ...x.capacity, [k]: v } }));
  const [closure, setClosure] = useState({ date: "", name: "" });
  const [msg, setMsg] = useState("");
  const y = +today().slice(0, 4);
  const upcoming = [...holidaysForYear(y, s.holidayRules), ...holidaysForYear(y + 1, s.holidayRules)].filter((h) => h.date >= today()).slice(0, 8);
  const learned = base.capacity;

  const exportAll = () => downloadBlob("production-schedule-settings.json", new Blob([JSON.stringify({ settings: s, edits: loadEdits() }, null, 2)], { type: "application/json" }));
  const importAll = async (f: File) => {
    try {
      const j = JSON.parse(await f.text());
      if (j.settings) setS(() => ({ ...DEFAULT_SETTINGS, ...j.settings, capacity: { ...DEFAULT_SETTINGS.capacity, ...j.settings.capacity } }));
      if (j.edits) api.setEdits({ pins: j.edits.pins ?? [], names: j.edits.names ?? {} });
      setMsg("Settings imported.");
    } catch {
      setMsg("That file isn't a settings export.");
    }
  };

  return (
    <>
      <div class="card">
        <div class="card-head"><h2>Files</h2><span class="card-sub">Drop new exports to replace the matching reports. Each run needs the inventory summary, stock reordering report and sales.</span></div>
        <div class="card-body stack">
          <table class="data">
            <thead><tr><th>Report</th><th>File</th><th class="num">Rows</th><th>Notes</th></tr></thead>
            <tbody>
              {ds.files.map((f) => (
                <tr><td>{f.kind ? FILES[f.kind].label : <span class="badge bad">Not recognized</span>}</td><td class="small">{f.name}</td><td class="num">{fmt(f.rows)}</td><td class="small muted">{f.warnings.join(" ")}</td></tr>
              ))}
            </tbody>
          </table>
          <DropFiles base={ds} onLoaded={api.loadFiles} compact />
        </div>
      </div>

      <div class="grid-2-even">
        <div class="card">
          <div class="card-head"><h2>Daily capacity</h2><span class="card-sub">Each team works separately, so each lane has its own limit.</span></div>
          <div class="card-body stack">
            <div class="row" style={{ alignItems: "flex-end", gap: 16 }}>
              <NumField label="Standard blends / day" value={s.capacity.blendStd} onChange={(v) => setCap("blendStd", v)} suffix="batches" />
              <NumField label="Big-tank blends / day" value={s.capacity.blendBig} onChange={(v) => setCap("blendBig", v)} suffix="batches" />
              <NumField label="Big tank = batches of at least" value={s.capacity.bigThreshold} onChange={(v) => setCap("bigThreshold", v)} suffix="gal" />
              <NumField label="Fill" value={s.capacity.fillGal} onChange={(v) => setCap("fillGal", v)} suffix="gal / day" step={5} />
              <NumField label="Kits" value={s.capacity.kits} onChange={(v) => setCap("kits", v)} suffix="kits / day" step={5} />
            </div>
            <div class="small muted">
              Defaults from your completed MOs (Jun 1 – Oct 23, 2026): blends at a typical day (one 2,000-gal batch runs alongside about three others), fill and kits at a good (75th percentile) day.
              A single fill or kit batch bigger than a day's capacity gets a day to itself.
            </div>
            {learned && api.ds.moHistory.length > 0 && (
              <div class="notice">
                From the uploaded MO history: {learned.blendStd} standard + {learned.blendBig} big blends, {fmt(learned.fillGal)} gal filled, {fmt(learned.kits)} kits a day.
                <button class="btn small" onClick={() => setS((x) => ({ ...x, capacity: { ...learned, blendStd: Math.max(learned.blendStd, 1) } }))}>Use these</button>
              </div>
            )}
            <button class="btn small" style={{ alignSelf: "flex-start" }} onClick={() => set("capacity", { ...DEFAULT_SETTINGS.capacity })}>Reset to defaults</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Planning</h2></div>
          <div class="card-body stack">
            <div class="row" style={{ alignItems: "flex-end", gap: 16 }}>
              <NumField label="Demand: average sales over the last" value={s.demandWeeks} onChange={(v) => set("demandWeeks", Math.max(1, v))} suffix="weeks" />
              <NumField label="Cover" value={s.coverDays} onChange={(v) => set("coverDays", v)} suffix="workdays" />
              <NumField label="Safety stock" value={s.safetyDays} onChange={(v) => set("safetyDays", v)} suffix="workdays" />
              <NumField label="Schedule length" value={s.horizonDays} onChange={(v) => set("horizonDays", Math.min(30, Math.max(1, v)))} suffix="workdays" />
              <label class="field">
                Start on
                <input class="input" type="date" value={s.startDate} onChange={(e) => set("startDate", (e.target as HTMLInputElement).value)} />
                <span class="small muted">Blank = next workday</span>
              </label>
            </div>
            <label class="toggle"><input type="checkbox" checked={s.useReorderFloor} onChange={(e) => set("useReorderFloor", (e.target as HTMLInputElement).checked)} /> Use the inFlow reorder point as a minimum (items with demand)</label>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Raw materials on order</h2><span class="card-sub">From the Purchase order status report. Each open line counts from the day its material can be used.</span></div>
        <div class="card-body stack">
          <div class="row" style={{ alignItems: "flex-end", gap: 16 }}>
            <NumField label="Usable after the requested ship date" value={s.receiptLagDays} onChange={(v) => set("receiptLagDays", Math.round(v))} suffix="workdays" hint="0 = usable on the ship date" />
          </div>
          <label class="toggle"><input type="checkbox" checked={s.countPastDue} onChange={(e) => set("countPastDue", (e.target as HTMLInputElement).checked)} /> Count past-due PO lines as arriving on the first day (off = ignore them until they're received)</label>
          <label class="toggle"><input type="checkbox" checked={s.countOnOrder} onChange={(e) => set("countOnOrder", (e.target as HTMLInputElement).checked)} /> What-if: count every open PO as on hand from day one, ignoring ship dates</label>
          <div class="small muted">Lines without a requested ship date aren't counted; they show on the Shortages page so you can get a date from the vendor.</div>
        </div>
      </div>

      <div class="grid-2-even">
        <div class="card">
          <div class="card-head"><h2>Holidays and closures</h2></div>
          <div class="card-body stack">
            <div class="checklist">
              {HOLIDAY_RULES.map((r) => (
                <label class="toggle"><input type="checkbox" checked={s.holidayRules[r.id] !== false}
                  onChange={(e) => set("holidayRules", { ...s.holidayRules, [r.id]: (e.target as HTMLInputElement).checked })} /> {r.label}</label>
              ))}
            </div>
            <div class="small muted">Coming up: {upcoming.map((h) => `${h.name} ${longDate(h.date)}`).join(" · ")}. Weekend holidays are taken the Friday before or Monday after.</div>
            <div class="row">
              <input class="input" type="date" value={closure.date} onChange={(e) => setClosure({ ...closure, date: (e.target as HTMLInputElement).value })} />
              <input class="input" placeholder="Reason (e.g. inventory count)" value={closure.name} onInput={(e) => setClosure({ ...closure, name: (e.target as HTMLInputElement).value })} />
              <button class="btn" disabled={!closure.date} onClick={() => { set("extraClosures", [...s.extraClosures, closure].sort((a, b) => a.date.localeCompare(b.date))); setClosure({ date: "", name: "" }); }}>Add closure</button>
            </div>
            {s.extraClosures.map((c, i) => (
              <div class="row"><span>{longDate(c.date)} · {c.name || "Closed"}</span>
                <button class="btn small icon ghost" aria-label="Remove" onClick={() => set("extraClosures", s.extraClosures.filter((_, j) => j !== i))}><IconX /></button></div>
            ))}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>MO names</h2><span class="card-sub">TYPE-YYDDMM-NAME-LABEL. The name part is the one from your most recent MO for that SKU. Blends get no label.</span></div>
          <div class="card-body stack">
            <table class="data">
              <thead><tr><th>SKU ends with</th><th>Label</th><th /></tr></thead>
              <tbody>
                {s.labels.map((l, i) => (
                  <tr>
                    <td><input class="input" style={{ width: 100 }} value={l.ending} onChange={(e) => set("labels", s.labels.map((x, j) => (j === i ? { ...x, ending: (e.target as HTMLInputElement).value } : x)))} /></td>
                    <td><input class="input" value={l.label} onChange={(e) => set("labels", s.labels.map((x, j) => (j === i ? { ...x, label: (e.target as HTMLInputElement).value.toUpperCase() } : x)))} /></td>
                    <td><button class="btn small icon ghost" aria-label="Remove" onClick={() => set("labels", s.labels.filter((_, j) => j !== i))}><IconX /></button></td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3}><button class="btn small" onClick={() => set("labels", [...s.labels, { ending: "", label: "" }])}>Add label</button></td>
                </tr>
              </tbody>
            </table>
            <label class="field">Everything else (your own label)
              <input class="input" style={{ width: 160 }} value={s.defaultLabel} onChange={(e) => set("defaultLabel", (e.target as HTMLInputElement).value.toUpperCase())} />
            </label>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Batch sizes and item types</h2></div>
        <div class="card-body small">
          <p style={{ marginTop: 0 }}>
            Using <b>{base.source}</b>: {Object.keys(base.items).length} SKUs with a typical batch size and type, {base.auto.length} auto-built SKUs (MO-####) that are never scheduled.
            Products with a BOM but no MO history get their type from the BOM and are made in one MO of exactly what's needed.
          </p>
          <p class="muted" style={{ marginBottom: 0 }}>To re-learn from newer history, drop a completed MO export into Files above.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Move to another computer</h2><span class="card-sub">Settings, locked and manual MOs, and renamed MOs are saved in this browser.</span></div>
        <div class="card-body row">
          <button class="btn" onClick={exportAll}><IconDownload /> Export settings</button>
          <label class="btn"><IconUpload /> Import settings
            <input type="file" accept=".json" style={{ display: "none" }} onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) importAll(f); }} />
          </label>
          <button class="btn" onClick={() => { if (confirm("Clear all locked and manual MOs and renamed MOs?")) api.setEdits({ pins: [], names: {} }); }}>Clear schedule edits</button>
          <button class="btn" onClick={() => { if (confirm("Forget the loaded files in this browser?")) api.forget(); }}>Forget loaded files</button>
          {msg && <span class="small muted">{msg}</span>}
        </div>
      </div>
    </>
  );
}
