import { LegendComponent } from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsCoreOption } from "echarts/core";
import { useEffect, useMemo, useState } from "preact/hooks";
import { axisStyle, baseOption, Chart, esc, type Tokens } from "../ui/Chart";
import { Card, Drawer, Seg } from "../ui/components";
import { downloadCsv } from "../ui/csv";
import { compact, full } from "../ui/format";
import { IconAlert, IconDownload, IconInfo, IconUpload } from "../ui/icons";
import {
  buildForecast, DEFAULT_FORECAST_SETTINGS, DEFAULT_SEASONALITY, LOCATIONS, MFG_LOCATION, monthLabel, rollupBySku, sumQA,
  type Forecast, type ForecastSettings, type Month, type Series,
} from "./engine";
import { addFiles, emptyForecastData, forecastStore, type ForecastData } from "./load";

type Loc = "All" | (typeof LOCATIONS)[number];
type Measure = "a" | "q";
type Grain = "quarter" | "month";
type CompMode = "planned" | "driven";

echarts.use([LegendComponent]);

const SETTINGS_KEY = "demand-forecast:settings";
function loadSettings(): ForecastSettings {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (v && Array.isArray(v.seasonality) && v.seasonality.length === 12) return { ...DEFAULT_FORECAST_SETTINGS, ...v };
  } catch { /* storage blocked: defaults */ }
  return DEFAULT_FORECAST_SETTINGS;
}
function saveSettings(s: ForecastSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* not persisted */ }
}

const LOC_COLOR: Record<string, number> = { Aurora: 0, DFW: 1, Houston: 2 };
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (v: number, m: Measure) => (m === "a" ? compact(v, "usd") : compact(v, "units"));
const fmtFull = (v: number, m: Measure) => (isNaN(v) ? "—" : m === "a" ? full(Math.round(v), "usd") : full(Math.round(v * 10) / 10, "units"));

export function ForecastApp() {
  const [data, setData] = useState<ForecastData | null>(null);
  const [booting, setBooting] = useState(true);
  const [settings, setSettingsRaw] = useState<ForecastSettings>(loadSettings);
  const setSettings = (s: ForecastSettings) => { setSettingsRaw(s); saveSettings(s); };

  useEffect(() => {
    forecastStore.load().then((d) => { if (d) setData(d); setBooting(false); });
  }, []);

  const ready = !!data && data.soLines.length > 0 && data.bom.length > 0;
  if (booting) return null;
  if (!ready) return <Welcome data={data ?? emptyForecastData()} onData={(d) => { setData(d); forecastStore.save(d); }} />;
  return (
    <Main
      data={data!}
      settings={settings}
      setSettings={setSettings}
      onData={(d) => { setData(d); forecastStore.save(d); }}
      onForget={async () => { await forecastStore.forget(); setData(null); }}
    />
  );
}

/* ---------------- Loading ---------------- */

function FileDrop(props: { data: ForecastData; onData: (d: ForecastData) => void; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState("");
  const take = async (list: FileList | null) => {
    if (!list?.length) return;
    setMsg("Reading…");
    try {
      const { data, ignored } = await addFiles(props.data, [...list]);
      props.onData(data);
      setMsg(ignored.length ? `Not recognized: ${ignored.join(", ")}` : "");
    } catch (e) {
      setMsg(`Couldn't read the file: ${(e as Error).message}`);
    }
  };
  const f = props.data.files;
  const item = (ok: boolean, label: string, sub: string) => (
    <li class={ok ? "ok" : ""}><span class="fc-dot" aria-hidden="true">{ok ? "✓" : ""}</span><div><b>{label}</b><div class="muted small">{sub}</div></div></li>
  );
  return (
    <div class="stack">
      <label
        class={`drop ${over ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer?.files ?? null); }}
      >
        <IconUpload />
        <div><b>Drop the inFlow exports here</b> or click to choose</div>
        <div class="muted small">CSV or Excel. Files are read in this browser and are never uploaded.</div>
        <input type="file" multiple accept=".csv,.xlsx,.xls" class="sr-only" onChange={(e) => take((e.target as HTMLInputElement).files)} />
      </label>
      {msg && <div class="muted small">{msg}</div>}
      <ul class="fc-files">
        {item(!!f.salesOrders, "Sales Orders", f.salesOrders ? `${f.salesOrders.name} · ${f.salesOrders.rows.toLocaleString()} lines` : "Required: inFlow Sales Order export (all line items)")}
        {item(!!f.bom, "Bill of Materials", f.bom ? `${f.bom.name} · ${f.bom.rows.toLocaleString()} lines` : "Required: inFlow BOM export")}
        {item(!!f.products, "Product Details (cost)", f.products ? `${f.products.name} · ${props.data.products.filter((p) => p.cost > 0).length.toLocaleString()} SKUs with cost` : "Optional: gives component $. inFlow Product Details export, or any SKU + Cost sheet")}
      </ul>
    </div>
  );
}

function Welcome(props: { data: ForecastData; onData: (d: ForecastData) => void }) {
  return (
    <div class="welcome">
      <div class="welcome-card">
        <div>
          <h1>Demand Forecast</h1>
          <p class="secondary">Finished-goods and BOM-component demand through December 2027, by location.</p>
        </div>
        <FileDrop data={props.data} onData={props.onData} />
      </div>
    </div>
  );
}

/* ---------------- Main ---------------- */

function Main(props: { data: ForecastData; settings: ForecastSettings; setSettings: (s: ForecastSettings) => void; onData: (d: ForecastData) => void; onForget: () => void }) {
  const { data, settings } = props;
  const [loc, setLoc] = useState<Loc>("All");
  const [measure, setMeasure] = useState<Measure>("a");
  const [tab, setTab] = useState<"fg" | "comp">("fg");
  const [compMode, setCompMode] = useState<CompMode>("planned");
  const [drawer, setDrawer] = useState<"assumptions" | "files" | null>(null);

  const fc = useMemo<Forecast | Error>(() => {
    try { return buildForecast(data, settings); } catch (e) { return e as Error; }
  }, [data, settings]);
  if (fc instanceof Error) {
    return (
      <div class="welcome"><div class="welcome-card">
        <h1>Couldn't build the forecast</h1><p>{fc.message}</p>
        <FileDrop data={data} onData={props.onData} />
      </div></div>
    );
  }

  const fgRows = fc.fg.filter((r) => loc === "All" || r.location === loc);
  const compRows = fc.components.filter((r) =>
    loc === "All" ? true : compMode === "planned" ? r.location === loc : r.drivenBy === loc,
  );
  const compMeasure: Measure = fc.hasPrices ? measure : "q";
  const growthYear = String(+fc.latest.slice(0, 4) + 1);
  const idx = (pred: (m: Month) => boolean) => fc.months.flatMap((m, i) => (pred(m) ? [i] : []));
  const yNext = idx((m) => m.key.startsWith(growthYear));
  const restCur = idx((m) => m.kind !== "actual" && !m.key.startsWith(growthYear));
  const actualCur = idx((m) => m.kind === "actual" && m.key.startsWith(fc.latest.slice(0, 4)));
  const raw = compRows.filter((r) => r.type === "Raw");
  const fgBase = fgRows.reduce((a, r) => a + r.baseline[measure], 0);
  const baseLabel = `${monthLabel(fc.baselineMonths[0])}–${monthLabel(fc.baselineMonths.at(-1)!)}`;
  const locNote = loc === "All" ? "all locations" : loc;

  return (
    <div class="main fc-main">
      <header class="topbar">
        <div class="title">
          <h1>Demand Forecast</h1>
          <div class="muted small">Actuals to {fc.latest} · forecast through Dec {growthYear}</div>
        </div>
        <div class="filters">
          <Seg label="Location" value={loc} onChange={setLoc} options={(["All", ...LOCATIONS] as Loc[]).map((l) => ({ value: l, label: l === "All" ? "All locations" : l }))} />
          <Seg label="Measure" value={measure} onChange={setMeasure} options={[{ value: "a", label: "$" }, { value: "q", label: "Qty" }]} />
          <button class="btn" onClick={() => setDrawer("assumptions")}>Assumptions</button>
          <button class="btn" onClick={() => setDrawer("files")}><IconUpload /> Data</button>
        </div>
      </header>

      <div class="content">
        <div class="fc-assume">
          <span><b>Baseline</b> {baseLabel} avg</span>
          <span><b>Growth {growthYear}</b> +{settings.growthPct}%</span>
          <span><b>Seasonality</b> {settings.seasonality.every((v) => v === settings.seasonality[0]) ? "flat" : "applied"}</span>
          <span><b>Blank location</b> → Aurora</span>
          <span><b>Components</b> planned at {MFG_LOCATION}</span>
          <button class="btn small ghost" onClick={() => setDrawer("assumptions")}>Edit</button>
        </div>

        <section class="tiles">
          <Tile label={`Finished goods ${growthYear}`} value={fmt(sumQA(fgRows, yNext)[measure], measure)} note={`${locNote} · incl. +${settings.growthPct}% growth`} />
          <Tile label={`Finished goods, rest of ${fc.latest.slice(0, 4)}`} value={fmt(sumQA(fgRows, restCur)[measure], measure)} note={actualCur.length ? `${fmt(sumQA(fgRows, actualCur)[measure], measure)} actual through ${fc.months[actualCur.at(-1)!].label}` : undefined} />
          <Tile label="Baseline run-rate / month" value={fmt(fgBase, measure)} note={`${baseLabel} average`} />
          <Tile
            label={`Raw materials ${growthYear}`}
            value={compMeasure === "a" ? fmt(sumQA(raw, yNext).a, "a") : fmt(sumQA(raw, yNext).q, "q")}
            note={!fc.hasPrices && measure === "a" ? "Qty: load Product Details for $" : loc !== "All" && loc !== MFG_LOCATION && compMode === "planned" ? "Planned at Aurora (none here)" : `${new Set(raw.map((r) => r.sku)).size} SKUs · planned at ${MFG_LOCATION}`}
          />
          <Tile label="SKUs forecast" value={`${new Set(fgRows.map((r) => r.sku)).size}`} note={`finished goods · ${new Set(compRows.map((r) => r.sku)).size} components`} />
        </section>

        <div class="grid-2-even">
          <Card title="Finished goods by month" sub={`${measure === "a" ? "Sales $" : "Units"} by selling location · shaded months are forecast`}>
            <MonthlyChart fc={fc} rows={fgRows} measure={measure} groupBy="location" />
          </Card>
          <Card
            title="Raw-material demand by month"
            sub={`${compMeasure === "a" ? "Cost $" : "Qty"} planned at ${MFG_LOCATION}, split by the location whose sales drive it`}
          >
            {raw.length ? <MonthlyChart fc={fc} rows={raw} measure={compMeasure} groupBy="drivenBy" /> : <EmptyComp loc={loc} onSwitch={() => setCompMode("driven")} />}
          </Card>
        </div>

        <Card
          title={
            <div class="seg fc-tabs" role="tablist">
              <button role="tab" aria-pressed={tab === "fg"} aria-selected={tab === "fg"} onClick={() => setTab("fg")}>Finished goods</button>
              <button role="tab" aria-pressed={tab === "comp"} aria-selected={tab === "comp"} onClick={() => setTab("comp")}>BOM components</button>
            </div>
          }
        >
          {tab === "fg" ? (
            <ForecastTable key="fg" kind="fg" fc={fc} rows={loc === "All" ? rollupBySku(fgRows, "All") : fgRows} measure={measure} loc={loc} />
          ) : (
            <div class="stack">
              {loc !== "All" && (
                <div class="row">
                  <Seg label="Component location" value={compMode} onChange={setCompMode} options={[{ value: "planned", label: `Planned at ${loc}` }, { value: "driven", label: `Driven by ${loc} sales` }]} />
                  <span class="muted small">All components are made and stocked at {MFG_LOCATION}.</span>
                </div>
              )}
              {!fc.hasPrices && measure === "a" && (
                <div class="fc-callout"><IconInfo /> Component $ needs costs. Load an inFlow Product Details export under <b>Data</b>; quantities are shown until then.</div>
              )}
              {compRows.length ? (
                <ForecastTable key="comp" kind="comp" fc={fc} rows={rollupBySku(compRows, MFG_LOCATION)} measure={compMeasure} loc={loc} />
              ) : (
                <EmptyComp loc={loc} onSwitch={() => setCompMode("driven")} />
              )}
            </div>
          )}
        </Card>

        <Card title="How this forecast is built">
          <ul class="fc-method">
            <li><b>Finished goods</b> are every product sold on a sales order, by order date and selling location. Open (unfulfilled) orders count; quotes, cancelled orders, tax/adjustment lines, fees ({fc.excluded.fees.lines} lines, {full(Math.round(fc.excluded.fees.amount), "usd")}) and Torginol drop-ships ({fc.excluded.dropship.lines} lines, {full(Math.round(fc.excluded.dropship.amount), "usd")}) don't. <i>Manufactured</i> = has a BOM; <i>Resale</i> = no BOM.</li>
            <li><b>Baseline</b> = the average month over {baseLabel}. {fc.blankLocationLines.toLocaleString()} lines with no location count for Aurora; "- Deactivated" SKUs are merged into the active SKU.</li>
            <li><b>Forecast month</b> = baseline × seasonality × growth. Growth is +{settings.growthPct}% for {growthYear} and 0% for the rest of {fc.latest.slice(0, 4)}. Seasonality only moves volume between months{settings.deseasonalizeBaseline ? `; the baseline is divided by its own months' seasonality (${(fc.baselineSeason * 100).toFixed(0)}%) first` : `, so ${growthYear} totals baseline × 12 × ${(1 + settings.growthPct / 100).toFixed(2)}`}. The current month = actual to date + forecast for its remaining {Math.round(fc.partialFraction * 100)}%.</li>
            <li><b>BOM components</b> = each month's finished-good quantity exploded through every BOM level (active BOM lines only). <i>Intermediate</i> = a component with its own BOM (blends, sub-assemblies); <i>Raw</i> = purchased material and packaging. Raw-material $ already includes what intermediates are made of, so don't add the two.</li>
            <li><b>Locations:</b> DFW started selling in Jul 2026 and Houston in Aug 2026, so their {baseLabel} baseline includes ramp-up months and is likely understated. Use a shorter baseline under Assumptions to check.</li>
            {fc.notes.map((n) => <li>{n}</li>)}
          </ul>
        </Card>
      </div>

      {drawer === "assumptions" && <AssumptionsDrawer fc={fc} settings={settings} onChange={props.setSettings} onClose={() => setDrawer(null)} />}
      {drawer === "files" && (
        <Drawer title={<h2>Data</h2>} onClose={() => setDrawer(null)}>
          <div class="stack">
            <p class="secondary small">Drop newer exports to refresh. Each one replaces the file of the same kind. Loaded data stays in this browser only.</p>
            <FileDrop data={data} onData={props.onData} />
            <div><button class="btn" onClick={props.onForget}>Forget loaded data</button></div>
          </div>
        </Drawer>
      )}
    </div>
  );
}

function EmptyComp(props: { loc: string; onSwitch: () => void }) {
  return (
    <div class="fc-empty">
      <p>Components are planned at {MFG_LOCATION}, so {props.loc} has no component demand of its own.</p>
      <button class="btn" onClick={props.onSwitch}>Show {MFG_LOCATION} components driven by {props.loc} sales</button>
    </div>
  );
}

function Tile(props: { label: string; value: string; note?: string }) {
  return (
    <div class="tile fc-tile">
      <div class="tile-label">{props.label}</div>
      <div class="tile-value">{props.value}</div>
      {props.note && <div class="tile-note">{props.note}</div>}
    </div>
  );
}

/* ---------------- Chart ---------------- */

function MonthlyChart(props: { fc: Forecast; rows: Series[]; measure: Measure; groupBy: "location" | "drivenBy" }) {
  const { fc, rows, measure, groupBy } = props;
  const groups = LOCATIONS.filter((l) => rows.some((r) => r[groupBy] === l));
  const values = groups.map((g) => fc.months.map((_, i) => rows.reduce((a, r) => (r[groupBy] === g ? a + r.m[i][measure] : a), 0)));
  const firstFc = fc.months.findIndex((m) => m.kind !== "actual");
  const build = (t: Tokens): EChartsCoreOption => ({
    ...baseOption(t),
    grid: { left: 8, right: 12, top: 28, bottom: groups.length > 1 ? 34 : 8, containLabel: true },
    legend: groups.length > 1 ? { bottom: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: t.text2 } } : undefined,
    tooltip: {
      ...(baseOption(t).tooltip as object),
      axisPointer: { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.5 } },
      formatter: (ps: any[]) => {
        const i = ps[0].dataIndex;
        const m = fc.months[i];
        const tag = m.kind === "actual" ? "Actual" : m.kind === "partial" ? "Actual to date + forecast" : "Forecast";
        const total = ps.reduce((a, p) => a + (p.value || 0), 0);
        const rowsHtml = ps.map((p) => `<div style="display:flex;align-items:center;gap:8px;margin-top:3px"><span style="width:10px;height:10px;border-radius:3px;background:${p.color}"></span><b>${esc(fmtFull(p.value, measure))}</b><span style="opacity:.75">${esc(p.seriesName)}</span></div>`).join("");
        return `<div><b>${esc(m.label)}</b> <span style="opacity:.7">${tag}</span>${rowsHtml}${ps.length > 1 ? `<div style="margin-top:5px;border-top:1px solid ${t.grid};padding-top:4px"><b>${esc(fmtFull(total, measure))}</b> <span style="opacity:.75">Total</span></div>` : ""}</div>`;
      },
    },
    xAxis: { type: "category", data: fc.months.map((m) => m.label), ...axisStyle(t), splitLine: { show: false }, axisLabel: { ...axisStyle(t).axisLabel, interval: 2 } },
    yAxis: { type: "value", ...axisStyle(t), axisLabel: { ...axisStyle(t).axisLabel, formatter: (v: number) => fmt(v, measure) } },
    series: groups.map((g, gi) => ({
      name: g,
      type: "bar",
      stack: "total",
      barMaxWidth: 22,
      data: values[gi],
      itemStyle: { color: t.series[LOC_COLOR[g] ?? 3], borderColor: t.surface, borderWidth: 1, borderRadius: gi === groups.length - 1 ? [4, 4, 0, 0] : 0 },
      emphasis: { focus: "series" },
      markArea: gi === 0 && firstFc >= 0
        ? { silent: true, itemStyle: { color: t.grid, opacity: 0.45 }, label: { show: true, position: "insideTopLeft", color: t.muted, fontSize: 11, formatter: "Forecast" }, data: [[{ xAxis: firstFc }, { xAxis: fc.months.length - 1 }]] }
        : undefined,
    })),
  });
  return <Chart build={build} deps={[fc, rows, measure, groupBy]} class="fc-chart" label={`Monthly ${measure === "a" ? "dollars" : "quantity"} by ${groupBy === "location" ? "location" : "driving location"}`} />;
}

/* ---------------- Table ---------------- */

interface Period { label: string; idx: number[]; total?: boolean }

function periods(fc: Forecast, grain: Grain): Period[] {
  const fcIdx = fc.months.flatMap((m, i) => (m.kind !== "actual" ? [i] : []));
  const out: Period[] = [];
  if (grain === "month") {
    for (const i of fcIdx) out.push({ label: fc.months[i].label + (fc.months[i].kind === "partial" ? "*" : ""), idx: [i] });
  } else {
    const byQ = new Map<string, number[]>();
    for (const i of fcIdx) {
      const k = fc.months[i].key;
      const q = `Q${Math.ceil(+k.slice(5, 7) / 3)} ${k.slice(0, 4)}`;
      byQ.set(q, [...(byQ.get(q) ?? []), i]);
    }
    for (const [label, idx] of byQ) out.push({ label: idx.some((i) => fc.months[i].kind === "partial") ? label + "*" : label, idx });
  }
  const years = [...new Set(fcIdx.map((i) => fc.months[i].key.slice(0, 4)))];
  const y = years.at(-1)!;
  out.push({ label: `${y} total`, idx: fc.months.flatMap((m, i) => (m.key.startsWith(y) ? [i] : [])), total: true });
  return out;
}

function ForecastTable(props: { kind: "fg" | "comp"; fc: Forecast; rows: Series[]; measure: Measure; loc: Loc }) {
  const { fc, measure, kind } = props;
  const [grain, setGrain] = useState<Grain>("quarter");
  const [type, setType] = useState<string>(kind === "fg" ? "All" : "Raw");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "total", dir: -1 });
  const [limit, setLimit] = useState(100);
  const ps = periods(fc, grain);
  const types = kind === "fg" ? ["All", "Manufactured", "Resale"] : ["Raw", "Intermediate", "All"];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return props.rows.filter((r) => (type === "All" || r.type === type) && (!needle || r.sku.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)));
  }, [props.rows, type, q]);
  const val = (r: Series, p: Period) => p.idx.reduce((a, i) => a + r.m[i][measure], 0);
  const sorted = useMemo(() => {
    const get = (r: Series): number | string => {
      if (sort.key === "sku") return r.sku;
      if (sort.key === "name") return r.name;
      if (sort.key === "type") return r.type;
      if (sort.key === "price") return isNaN(r.unitPrice) ? -1 : r.unitPrice;
      if (sort.key === "base") return r.baseline[measure];
      if (sort.key === "level") return r.level ?? 0;
      const p = sort.key === "total" ? ps.at(-1)! : ps[+sort.key.slice(1)];
      return p ? val(r, p) : 0;
    };
    return [...filtered].sort((a, b) => {
      const va = get(a), vb = get(b);
      return (typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb))) * sort.dir;
    });
  }, [filtered, sort, measure, grain]);
  useEffect(() => setLimit(100), [filtered]);

  const th = (key: string, label: string, num = false) => (
    <th class={num ? "num" : ""} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"} onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : num ? -1 : 1 }))}>
      {label}{sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
    </th>
  );
  const doubleCount = kind === "comp" && type === "All" && measure === "a";

  const exportCsv = () => {
    const fcMonths = fc.months.map((m, i) => ({ m, i }));
    const head = ["Section", "Location", "Driven by", "SKU", "Product", "Type", ...(kind === "comp" ? ["BOM level"] : []), kind === "fg" ? "Avg sales price" : "Unit cost", "Baseline qty/mo", "Baseline $/mo",
      ...fcMonths.flatMap(({ m }) => [`${m.label} qty (${m.kind})`, `${m.label} $ (${m.kind})`])];
    const rows = sorted.map((r) => [
      kind === "fg" ? "Finished good" : "BOM component", r.location, r.drivenBy, r.sku, r.name, r.type, ...(kind === "comp" ? [r.level ?? ""] : []),
      isNaN(r.unitPrice) ? "" : +r.unitPrice.toFixed(4), +r.baseline.q.toFixed(3), +r.baseline.a.toFixed(2),
      ...fcMonths.flatMap(({ i }) => [+r.m[i].q.toFixed(3), kind === "comp" && isNaN(r.unitPrice) ? "" : +r.m[i].a.toFixed(2)]),
    ]);
    downloadCsv(`forecast-${kind === "fg" ? "finished-goods" : "components"}-${props.loc.toLowerCase()}.csv`, head, rows);
  };

  return (
    <div class="stack">
      <div class="row">
        <Seg label="Type" value={type} onChange={setType} options={types.map((t) => ({ value: t, label: t === "All" ? (kind === "fg" ? "All" : "All levels") : t === "Raw" ? "Raw materials" : t === "Intermediate" ? "Intermediates" : t }))} />
        <Seg label="Columns" value={grain} onChange={setGrain} options={[{ value: "quarter", label: "Quarters" }, { value: "month", label: "Months" }]} />
        <input class="input" type="search" placeholder="Search SKU or product" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search" />
        <div class="spacer" />
        <button class="btn small" onClick={exportCsv}><IconDownload /> CSV (all months)</button>
      </div>
      {doubleCount && <div class="fc-callout"><IconAlert /> All levels: the total counts intermediates and the raw materials inside them, so $ is double-counted. Use Raw materials for spend.</div>}
      <div class="table-wrap fc-table">
        <table class="data">
          <thead>
            <tr>
              {th("sku", "SKU")}
              {th("name", "Product")}
              {th("type", "Type")}
              {kind === "comp" && th("level", "Level", true)}
              {th("price", kind === "fg" ? "Avg price" : "Unit cost", true)}
              {th("base", `Baseline/mo`, true)}
              {ps.map((p, i) => th(p.total ? "total" : `p${i}`, p.label, true))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((r) => (
              <tr>
                <td class="nowrap mono">{r.sku}</td>
                <td>{r.name}</td>
                <td class="nowrap"><span class={`fc-type fc-type-${r.type.toLowerCase()}`}>{r.type}</span></td>
                {kind === "comp" && <td class="num">{r.level}</td>}
                <td class="num nowrap">{isNaN(r.unitPrice) ? "—" : full(r.unitPrice, "usd")}</td>
                <td class="num nowrap">{kind === "comp" && measure === "a" && isNaN(r.unitPrice) ? "—" : fmtFull(r.baseline[measure], measure)}</td>
                {ps.map((p) => <td class={`num nowrap ${p.total ? "fc-total" : ""}`}>{kind === "comp" && measure === "a" && isNaN(r.unitPrice) ? "—" : fmtFull(val(r, p), measure)}</td>)}
              </tr>
            ))}
            {!sorted.length && <tr><td colSpan={7 + ps.length} class="muted" style={{ padding: "18px 10px" }}>No rows match.</td></tr>}
          </tbody>
          {sorted.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={kind === "comp" ? 5 : 4}><b>Total</b> <span class="muted small">{sorted.length.toLocaleString()} SKUs{measure === "q" ? " · mixed units" : ""}</span></td>
                <td class="num nowrap"><b>{fmtFull(sorted.reduce((a, r) => a + r.baseline[measure], 0), measure)}</b></td>
                {ps.map((p) => <td class={`num nowrap ${p.total ? "fc-total" : ""}`}><b>{fmtFull(sorted.reduce((a, r) => a + val(r, p), 0), measure)}</b></td>)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <div class="table-foot">
        <span>{Math.min(limit, sorted.length).toLocaleString()} of {sorted.length.toLocaleString()} rows · totals include all {sorted.length.toLocaleString()}</span>
        {limit < sorted.length && <button class="btn small" onClick={() => setLimit(limit + 400)}>Show more</button>}
        <div class="spacer" />
        {ps.some((p) => p.label.endsWith("*")) && <span>* includes actual sales to {fc.latest}</span>}
      </div>
    </div>
  );
}

/* ---------------- Assumptions ---------------- */

function AssumptionsDrawer(props: { fc: Forecast; settings: ForecastSettings; onChange: (s: ForecastSettings) => void; onClose: () => void }) {
  const s = props.settings;
  const set = (p: Partial<ForecastSettings>) => props.onChange({ ...s, ...p });
  const max = Math.max(...s.seasonality, 1);
  const growthYear = String(+props.fc.latest.slice(0, 4) + 1);
  return (
    <Drawer title={<h2>Assumptions</h2>} onClose={props.onClose}>
      <div class="stack">
        <label class="fc-field">
          <span><b>Growth for {growthYear}</b><span class="muted small">Applied to every month of {growthYear}, all locations.</span></span>
          <span class="row"><input class="input fc-num" type="number" step="1" value={s.growthPct} onInput={(e) => set({ growthPct: +(e.target as HTMLInputElement).value || 0 })} /> %</span>
        </label>
        <label class="fc-field">
          <span><b>Baseline window</b><span class="muted small">Full months averaged for the run-rate: {props.fc.baselineMonths.map(monthLabel).join(", ")}.</span></span>
          <select class="select" value={s.baselineMonths} onChange={(e) => set({ baselineMonths: +(e.target as HTMLSelectElement).value })}>
            {[1, 2, 3, 4, 5, 6].map((n) => <option value={n}>Last {n} full month{n > 1 ? "s" : ""}</option>)}
          </select>
        </label>
        <div>
          <div class="row"><b>Seasonality</b><div class="spacer" />
            <button class="btn small" onClick={() => set({ seasonality: Array(12).fill(100) })}>Flat</button>
            <button class="btn small" onClick={() => set({ seasonality: DEFAULT_SEASONALITY })}>Reset</button>
          </div>
          <p class="muted small">Relative volume per month (100 = an average month). It's normalized, so it only shifts volume between months. The default is a starting guess with a slower winter; replace it with what you see.</p>
          <div class="fc-season">
            {s.seasonality.map((v, i) => (
              <label>
                <span class="fc-bar" style={{ height: `${(v / max) * 56}px` }} aria-hidden="true" />
                <input class="input fc-num" type="number" min="0" step="5" value={v} aria-label={`${MONTH_NAMES[i]} seasonality`}
                  onInput={(e) => { const next = [...s.seasonality]; next[i] = Math.max(0, +(e.target as HTMLInputElement).value || 0); set({ seasonality: next }); }} />
                <span class="small muted">{MONTH_NAMES[i]}</span>
              </label>
            ))}
          </div>
        </div>
        <label class="toggle">
          <input type="checkbox" checked={s.deseasonalizeBaseline} onChange={(e) => set({ deseasonalizeBaseline: (e.target as HTMLInputElement).checked })} />
          <span><b>Adjust the baseline for its own season</b><br /><span class="muted small">
            The baseline months average {(props.fc.baselineSeason * 100).toFixed(0)}% of a normal month on this index. On: the run-rate is divided by that first, so a peak-season baseline isn't carried into slow months (more conservative). Off: {growthYear} totals exactly baseline × 12 × {(1 + s.growthPct / 100).toFixed(2)}.
          </span></span>
        </label>
        <div><button class="btn" onClick={() => props.onChange(DEFAULT_FORECAST_SETTINGS)}>Restore all defaults</button></div>
      </div>
    </Drawer>
  );
}
