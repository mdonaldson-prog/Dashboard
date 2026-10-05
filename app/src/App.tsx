import { useEffect, useMemo, useState } from "preact/hooks";
import { buildContext, type Ctx } from "./calc/context";
import { planCounts, type LocationPlan } from "./calc/counts";
import { addDays, longDate, weekLabel } from "./calc/dates";
import { filterLoc, KPI_BY_ID, type Fact, type KpiDef } from "./calc/kpis";
import type { Dataset } from "./data/model";
import { loadSettings, saveSettings, type Settings } from "./data/settings";
import { forgetDataset, loadDataset, saveDataset } from "./data/store";
import { Counts } from "./pages/Counts";
import { DataPage } from "./pages/DataPage";
import { Explorer } from "./pages/Explorer";
import { Home } from "./pages/Home";
import { Welcome } from "./pages/Welcome";
import { IconChart, IconClipboard, IconDatabase, IconHome } from "./ui/icons";

export interface AppApi {
  c: Ctx;
  s: Settings;
  setS: (fn: (s: Settings) => Settings) => void;
  facts: (def: KpiDef, ignoreLoc?: boolean) => Fact[];
  week: string;
  setWeek: (w: string) => void;
  weeks: string[];
  loc: string;
  plans: LocationPlan[];
  go: (route: string) => void;
  reload: () => void;
  forget: () => Promise<void>;
  savedLocally: boolean;
}

const parseRoute = () => (location.hash.replace(/^#\/?/, "") || "home").split("/");

export function App(props: { demo: Dataset | null }) {
  const [ds, setDs] = useState<Dataset | null>(props.demo);
  const [restoring, setRestoring] = useState(!props.demo);
  const [savedLocally, setSavedLocally] = useState(false);
  const [s, setSRaw] = useState<Settings>(loadSettings);
  const [route, setRoute] = useState(parseRoute);
  const [loc, setLoc] = useState("All");
  const [weekSel, setWeek] = useState("");
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
          setWeek("");
          location.hash = "#/home";
          if (d !== props.demo) saveDataset(d).then(setSavedLocally);
        }}
      />
    );

  const weeks: string[] = [];
  const firstWeek = c.coverage.salesOrders?.min ?? addDays(c.defaultWeek, -7 * 26);
  for (let w = c.currentWeek; w >= firstWeek.slice(0, 10) && weeks.length < 60; w = addDays(w, -7)) weeks.push(w);
  const week = weekSel || c.defaultWeek;

  const allFacts = (def: KpiDef) => {
    let f = factCache.get(def.id);
    if (!f) { f = def.facts(c); factCache.set(def.id, f); }
    return f;
  };
  const api: AppApi = {
    c, s, setS, week, setWeek, weeks, loc, plans,
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
    home: ["Operations overview", `Week of ${weekLabel(week)}`],
    kpi: [kpi?.name ?? "KPIs", "KPI explorer"],
    counts: ["Cycle count schedule", `Next ${s.counts.horizonWeeks} weeks · counting ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].filter((_, i) => s.counts.workingDays.includes(i)).join(", ")}`],
    data: ["Data & settings", `Data through ${longDate(c.latest)}`],
  };
  const [title, sub] = titles[page] ?? titles.home;
  const showWeek = page === "home" || page === "kpi";
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
          <div class="filters">
            {showWeek && (
              <select class="select" aria-label="Week" value={week} onChange={(e) => setWeek((e.target as HTMLSelectElement).value)}>
                {weeks.map((w) => (
                  <option value={w}>
                    {w === c.currentWeek ? `This week (partial) · ${weekLabel(w)}` : w === c.defaultWeek ? `Last week · ${weekLabel(w)}` : weekLabel(w)}
                  </option>
                ))}
              </select>
            )}
            {showLoc && (
              <select class="select" aria-label="Location" value={loc} onChange={(e) => setLoc((e.target as HTMLSelectElement).value)}>
                <option value="All">All locations</option>
                {c.locations.map((l) => <option value={l}>{l}</option>)}
              </select>
            )}
          </div>
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
