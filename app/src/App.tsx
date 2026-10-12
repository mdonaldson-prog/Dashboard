import { useEffect, useMemo, useState } from "preact/hooks";
import { buildContext, type Ctx } from "./calc/context";
import { planCounts, type LocationPlan } from "./calc/counts";
import { addDays, dayOfWeek, longDate, periodAt, periodLabel, shiftPeriod, type Period } from "./calc/dates";
import { filterLoc, KPI_BY_ID, type Fact, type KpiDef } from "./calc/kpis";
import type { Dataset } from "./data/model";
import { loadSettings, saveSettings, type Settings } from "./data/settings";
import { forgetDataset, loadDataset, saveDataset } from "./data/store";
import { Counts } from "./pages/Counts";
import { DataPage } from "./pages/DataPage";
import { Explorer } from "./pages/Explorer";
import { Home } from "./pages/Home";
import { Welcome } from "./pages/Welcome";
import { PeriodPicker } from "./ui/PeriodPicker";
import { IconChart, IconClipboard, IconDatabase, IconHome } from "./ui/icons";

export interface AppApi {
  c: Ctx;
  s: Settings;
  setS: (fn: (s: Settings) => Settings) => void;
  facts: (def: KpiDef, ignoreLoc?: boolean) => Fact[];
  /** The global date filter, and the same-length period before it (for comparisons). */
  period: Period;
  prior: Period;
  setPeriod: (p: Period) => void;
  /** First date any dated report covers. */
  dataMin: string;
  loc: string;
  setLoc: (l: string) => void;
  plans: LocationPlan[];
  go: (route: string) => void;
  reload: () => void;
  forget: () => Promise<void>;
  savedLocally: boolean;
}

/** The period to compare against: the same-length period before, or for a day, the previous working day. */
function priorOf(p: Period, holidays: Set<string>): Period {
  if (p.kind !== "day") return shiftPeriod(p, -1);
  let d = addDays(p.from, -1);
  for (let i = 0; i < 10 && (dayOfWeek(d) === 0 || dayOfWeek(d) === 6 || holidays.has(d)); i++) d = addDays(d, -1);
  return periodAt("day", d);
}

const parseRoute = () => (location.hash.replace(/^#\/?/, "") || "home").split("/");

export function App(props: { demo: Dataset | null }) {
  const [ds, setDs] = useState<Dataset | null>(props.demo);
  const [restoring, setRestoring] = useState(!props.demo);
  const [savedLocally, setSavedLocally] = useState(false);
  const [s, setSRaw] = useState<Settings>(loadSettings);
  const [route, setRoute] = useState(parseRoute);
  const [loc, setLoc] = useState("All");
  const [periodSel, setPeriod] = useState<Period | null>(null);
  const [theme, setTheme] = useState<string>(() => {
    try { return localStorage.getItem("execdash.theme") ?? "auto"; } catch { return "auto"; }
  });

  // Reopen with the last upload saved in this browser
  useEffect(() => {
    if (props.demo) return;
    loadDataset().then((d) => {
      if (d) { setDs(d); setSavedLocally(true); }
      setRestoring(false);
    });
  }, []);
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("execdash.theme", theme); } catch { /* ignore */ }
  }, [theme]);

  const setS = (fn: (s: Settings) => Settings) =>
    setSRaw((prev) => {
      const next = fn(structuredClone(prev));
      saveSettings(next);
      return next;
    });

  const c = useMemo(() => (ds ? buildContext(ds, s) : null), [ds, s]);
  const factCache = useMemo(() => new Map<string, Fact[]>(), [c]);
  const plans = useMemo(() => (c ? planCounts(c, s) : []), [c]);

  if (restoring) return <div class="welcome"><span class="muted">Opening saved data…</span></div>;
  if (!ds || !c)
    return (
      <Welcome
        demo={props.demo}
        onLoaded={(d) => {
          setDs(d);
          setPeriod(null);
          location.hash = "#/home";
          if (d !== props.demo) saveDataset(d).then(setSavedLocally);
        }}
      />
    );

  const dataMin = Object.values(c.coverage).reduce((m, cv) => (cv && cv.min < m ? cv.min : m), c.latest);
  const period = periodSel ?? periodAt("week", c.defaultWeek);

  const allFacts = (def: KpiDef) => {
    let f = factCache.get(def.id);
    if (!f) { f = def.facts(c); factCache.set(def.id, f); }
    return f;
  };
  const api: AppApi = {
    c, s, setS, period, prior: priorOf(period, c.holidays), setPeriod, dataMin, loc, setLoc, plans,
    facts: (def, ignoreLoc) => (ignoreLoc ? allFacts(def) : filterLoc(def, allFacts(def), loc)),
    go: (r) => { location.hash = `#/${r}`; window.scrollTo(0, 0); },
    reload: () => { setDs(null); },
    forget: async () => { await forgetDataset(); setSavedLocally(false); },
    savedLocally,
  };

  const page = route[0];
  const kpi = page === "kpi" ? KPI_BY_ID.get(route[1] ?? "") ?? KPI_BY_ID.get("inventory_accuracy")! : null;
  const nav = [
    { id: "home", label: "Overview", icon: <IconHome /> },
    { id: "kpi", label: "KPIs", icon: <IconChart /> },
    { id: "counts", label: "Cycle counts", icon: <IconClipboard /> },
    { id: "data", label: "Data", icon: <IconDatabase /> },
  ];
  const titles: Record<string, [string, string]> = {
    home: ["Operations overview", periodLabel(period)],
    kpi: [kpi?.name ?? "KPIs", "KPI explorer"],
    counts: ["Cycle count schedule", `Next ${s.counts.horizonWeeks} weeks · counting ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].filter((_, i) => s.counts.workingDays.includes(i)).join(", ")}`],
    data: ["Data & settings", `Data through ${longDate(c.latest)}`],
  };
  const [title, sub] = titles[page] ?? titles.home;
  const showPeriod = page === "home" || page === "kpi";
  const showLoc = page !== "data" && page !== "counts";

  const navLinks = (cls: string) =>
    nav.map((n) => (
      <a class={`navlink ${cls}`} href={`#/${n.id === "kpi" ? `kpi/${kpi?.id ?? "inventory_accuracy"}` : n.id}`} aria-current={page === n.id ? "page" : undefined}>
        {n.icon}
        <span>{n.label}</span>
      </a>
    ));

  return (
    <div class="shell">
      <nav class="sidenav" aria-label="Main">
        <div class="brand"><span class="brand-mark"><IconChart /></span> Operations</div>
        {navLinks("")}
        <div class="nav-foot">
          <span>Data through {longDate(c.latest)}</span>
          {savedLocally && <span>Loaded {new Date(c.ds.loadedAt).toLocaleDateString()} · saved in this browser</span>}
        </div>
      </nav>
      <div class="main">
        <header class="topbar">
          <div class="title">
            <h1>{title}</h1>
            <span class="small muted">{sub}</span>
          </div>
          {(showPeriod || showLoc) && (
            <div class="filters" role="group" aria-label="Filters">
              {showPeriod && <PeriodPicker value={period} onChange={setPeriod} latest={c.latest} dataMin={dataMin} lastWeek={c.defaultWeek} />}
              {showLoc && (
                <select class="select" aria-label="Location" value={loc} onChange={(e) => setLoc((e.target as HTMLSelectElement).value)}>
                  <option value="All">All locations</option>
                  {c.locations.map((l) => <option value={l}>{l}</option>)}
                </select>
              )}
            </div>
          )}
        </header>
        <main class="content">
          {page === "home" && <Home api={api} />}
          {page === "kpi" && kpi && <Explorer api={api} def={kpi} />}
          {page === "counts" && <Counts api={api} />}
          {page === "data" && <DataPage api={api} theme={theme} setTheme={setTheme} />}
        </main>
      </div>
      <nav class="bottomnav" aria-label="Main">{navLinks("")}</nav>
    </div>
  );
}
