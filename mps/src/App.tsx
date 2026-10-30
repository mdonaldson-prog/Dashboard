import { useEffect, useMemo, useState } from "preact/hooks";
import type { Baselines } from "./calc/baselines";
import { shortDate } from "./calc/dates";
import type { Mo, Schedule } from "./calc/plan";
import { baselinesFrom, buildSchedule } from "./calc/plan";
import builtIn from "./data/baselines.json";
import type { Dataset } from "./data/model";
import type { Edits, Pin, Settings } from "./data/settings";
import { loadEdits, loadSettings, newId, saveEdits, saveSettings } from "./data/settings";
import { forgetDataset, loadDataset, saveDataset } from "./data/store";
import { Calendar } from "./ui/Calendar";
import { exportMos } from "./ui/exports";
import { IconAlert, IconCalendar, IconDownload, IconFlag, IconList, IconMoon, IconPrint, IconSettings, IconSun } from "./ui/icons";
import { PlanTable } from "./ui/PlanTable";
import { PrintView, type PrintKind } from "./ui/Print";
import { Review } from "./ui/Review";
import { SettingsPage } from "./ui/SettingsPage";
import { Shortages } from "./ui/Shortages";
import { Upload } from "./ui/Upload";

const BUILT_IN = builtIn as Baselines;
type Tab = "schedule" | "review" | "shortages" | "plan" | "settings";

/** Everything a page can do to the schedule. */
export interface Api {
  sched: Schedule;
  s: Settings;
  setS: (fn: (s: Settings) => Settings) => void;
  edits: Edits;
  base: Baselines;
  builtIn: Baselines;
  ds: Dataset;
  /** Move an MO to another day (locks it there). */
  move: (mo: Mo, date: string) => void;
  lock: (mo: Mo) => void;
  unlock: (mo: Mo) => void;
  setPinQty: (pinId: string, qty: number) => void;
  addManual: (sku: string, qty: number, date: string) => void;
  removePin: (pinId: string) => void;
  rename: (nameKey: string, name: string) => void;
  setEdits: (e: Edits) => void;
  loadFiles: (ds: Dataset) => void;
  forget: () => Promise<void>;
  go: (t: Tab) => void;
}

const pinIdOf = (mo: Mo) => (mo.id.startsWith("pin:") ? mo.id.slice(4) : null);

export function App() {
  const [ds, setDs] = useState<Dataset | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [s, setSRaw] = useState<Settings>(loadSettings);
  const [edits, setEditsRaw] = useState<Edits>(loadEdits);
  const [tab, setTab] = useState<Tab>("schedule");
  const [print, setPrint] = useState<PrintKind | null>(null);
  const [theme, setTheme] = useState<string>(() => {
    try { return localStorage.getItem("mps.theme") ?? "auto"; } catch { return "auto"; }
  });

  useEffect(() => { loadDataset().then((d) => { if (d) setDs(d); setRestoring(false); }); }, []);
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("mps.theme", theme); } catch { /* not saved */ }
  }, [theme]);
  useEffect(() => {
    if (!print) return;
    const done = () => setPrint(null);
    window.addEventListener("afterprint", done, { once: true });
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); };
  }, [print]);

  const setS = (fn: (s: Settings) => Settings) => setSRaw((cur) => { const n = fn(cur); saveSettings(n); return n; });
  const setEdits = (e: Edits) => { setEditsRaw(e); saveEdits(e); };
  const editPins = (fn: (pins: Pin[]) => Pin[]) => setEditsRaw((cur) => { const n = { ...cur, pins: fn(cur.pins) }; saveEdits(n); return n; });

  const base = useMemo(() => (ds ? baselinesFrom(ds, BUILT_IN) : BUILT_IN), [ds]);
  const sched = useMemo(() => (ds ? buildSchedule(ds, base, s, edits) : null), [ds, base, s, edits]);

  if (restoring) return <div class="welcome"><div class="muted">Loading…</div></div>;
  if (!ds || !sched) {
    return <Upload onLoaded={(d) => { setDs(d); saveDataset(d); }} />;
  }

  const api: Api = {
    sched, s, setS, edits, base, builtIn: BUILT_IN, ds,
    move: (mo, date) => {
      const id = pinIdOf(mo);
      if (id) editPins((p) => p.map((x) => (x.id === id ? { ...x, date } : x)));
      else editPins((p) => [...p, { id: newId(), sku: mo.sku, qty: mo.qty, date, manual: false }]);
    },
    lock: (mo) => editPins((p) => [...p, { id: newId(), sku: mo.sku, qty: mo.qty, date: mo.date, manual: false }]),
    unlock: (mo) => { const id = pinIdOf(mo); if (id) editPins((p) => p.filter((x) => x.id !== id)); },
    setPinQty: (id, qty) => editPins((p) => p.map((x) => (x.id === id ? { ...x, qty } : x))),
    addManual: (sku, qty, date) => editPins((p) => [...p, { id: newId(), sku, qty, date, manual: true }]),
    removePin: (id) => editPins((p) => p.filter((x) => x.id !== id)),
    rename: (key, name) => setEditsRaw((cur) => {
      const names = { ...cur.names };
      if (name.trim()) names[key] = name.trim(); else delete names[key];
      const n = { ...cur, names };
      saveEdits(n);
      return n;
    }),
    setEdits,
    loadFiles: (d) => { setDs(d); saveDataset(d); },
    forget: async () => { await forgetDataset(); setDs(null); },
    go: setTab,
  };

  const nReview = sched.flags.filter((f) => f.kind === "noSales" && !f.added).length;
  const nShort = sched.shortages.length + sched.unplaced.length;
  const NAV: { id: Tab; label: string; icon: () => preact.JSX.Element; count?: number; bad?: boolean }[] = [
    { id: "schedule", label: "Schedule", icon: IconCalendar },
    { id: "review", label: "Needs review", icon: IconFlag, count: nReview },
    { id: "shortages", label: "Shortages", icon: IconAlert, count: nShort, bad: true },
    { id: "plan", label: "Plan details", icon: IconList },
    { id: "settings", label: "Data & settings", icon: IconSettings },
  ];
  const range = `${shortDate(sched.days[0])} – ${shortDate(sched.days[sched.days.length - 1])}`;

  return (
    <>
      <div class={`shell ${print ? "printing" : ""}`}>
        <nav class="sidenav">
          <div class="brand"><span class="brand-mark"><IconCalendar /></span>Production Schedule</div>
          {NAV.map((n) => (
            <a class="navlink" href="#" aria-current={tab === n.id ? "page" : undefined} onClick={(e) => { e.preventDefault(); setTab(n.id); }}>
              <n.icon /> {n.label}
              {!!n.count && <span class={`badge ${n.bad ? "bad" : "warn"}`} style={{ marginLeft: "auto" }}>{n.count}</span>}
            </a>
          ))}
          <div class="nav-foot">
            <span>Files loaded {new Date(ds.loadedAt).toLocaleString()}</span>
            <span>Saved in this browser only.</span>
          </div>
        </nav>
        <div class="main">
          <header class="topbar">
            <div class="title">
              <h1>{NAV.find((n) => n.id === tab)!.label}</h1>
              <span class="small muted">{range} · {sched.days.length} workdays{sched.closures.length ? ` · closed ${sched.closures.map((c) => `${shortDate(c.date)} (${c.name})`).join(", ")}` : ""}</span>
            </div>
            <div class="filters">
              <button class="btn" onClick={() => setPrint({ kind: "master" })}><IconPrint /> Master overview</button>
              <div class="seg" role="group" aria-label="Print team sheets">
                <button onClick={() => setPrint({ kind: "team", lane: "BLEND" })} title="Print Blend team sheets">Blend sheets</button>
                <button onClick={() => setPrint({ kind: "team", lane: "FILL" })} title="Print Fill team sheets">Fill sheets</button>
                <button onClick={() => setPrint({ kind: "team", lane: "KIT" })} title="Print Kit team sheets">Kit sheets</button>
              </div>
              <button class="btn" onClick={() => exportMos(sched)}><IconDownload /> MOs (CSV)</button>
              <button class="btn icon ghost" title="Light / dark" aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "auto" : "dark")}>
                {theme === "dark" ? <IconMoon /> : <IconSun />}
              </button>
            </div>
          </header>
          <main class="content">
            {sched.warnings.map((w) => <div class="notice warn"><IconAlert /> {w}</div>)}
            {tab === "schedule" && <Calendar api={api} />}
            {tab === "review" && <Review api={api} />}
            {tab === "shortages" && <Shortages api={api} />}
            {tab === "plan" && <PlanTable api={api} />}
            {tab === "settings" && <SettingsPage api={api} />}
          </main>
        </div>
        <nav class="bottomnav">
          {NAV.map((n) => (
            <a class="navlink" href="#" aria-current={tab === n.id ? "page" : undefined} onClick={(e) => { e.preventDefault(); setTab(n.id); }}>
              <n.icon /><span>{n.label.split(" ")[0]}</span>
            </a>
          ))}
        </nav>
      </div>
      {print && <PrintView kind={print} sched={sched} ds={ds} />}
    </>
  );
}
