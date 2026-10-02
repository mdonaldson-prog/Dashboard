import { useEffect, useMemo, useState } from "preact/hooks";
import type { AppApi } from "../App";
import { addDays, monthLabel, monthOf, shortDate, weekLabel } from "../calc/dates";
import { breakdown, coverageOf, KPIS, series, valueOf, type Grain, type KpiDef } from "../calc/kpis";
import { REPORTS } from "../data/model";
import { BreakdownChart, CompareChart, ProductionChart, TrendChart } from "../ui/charts";
import { Card, DataTable, Seg, type Col } from "../ui/components";
import { compact, full } from "../ui/format";
import { IconX } from "../ui/icons";

const GROUPS = ["Inventory", "Production", "Sales & fulfillment", "Freight", "Transfers"] as const;

export function Explorer(props: { api: AppApi; def: KpiDef }) {
  const { api, def } = props;
  const { c } = api;
  const [range, setRange] = useState(13);
  const [grain, setGrain] = useState<Grain>("week");
  const [period, setPeriod] = useState<string | null>(null);
  const [dim, setDim] = useState(def.dims[0]?.key ?? "");
  const [dimValue, setDimValue] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);

  useEffect(() => { setPeriod(null); setDim(def.dims[0]?.key ?? ""); setDimValue(null); setCompare([]); }, [def.id]);
  useEffect(() => { setPeriod(null); }, [grain, range, api.week]);
  useEffect(() => { setDimValue(null); }, [dim, period]);

  const facts = api.facts(def);
  const to = addDays(api.week, 6);
  const cov = coverageOf(c, def);
  let from = range ? addDays(api.week, -7 * (range - 1)) : cov?.min ?? addDays(api.week, -7 * 52);
  if (grain === "month") from = monthOf(from);
  const points = useMemo(() => (def.pointInTime ? [] : series(c, def, facts, grain, from, to)), [def, facts, grain, from, to]);

  // Selected slice: a clicked period, or the whole visible range
  const step = (k: string) => (grain === "week" ? addDays(k, 6) : addDays(monthOf(addDays(k, 32)), -1));
  const [selFrom, selTo] = def.pointInTime ? ["0000-01-01", "9999-12-31"] : period ? [period, step(period)] : [from, to];
  const selFacts = useMemo(() => facts.filter((f) => f.date >= selFrom && f.date <= selTo), [facts, selFrom, selTo]);
  const selValue = valueOf(def, selFacts.reduce((a, f) => a + f.num, 0), selFacts.reduce((a, f) => a + f.den, 0), selFacts.length);
  const extras = def.extras ? def.extras(selFacts) : [];
  const rows = useMemo(() => (dim ? breakdown(def, selFacts, dim) : []), [def, selFacts, dim]);
  const records = useMemo(() => (dimValue ? selFacts.filter((f) => (f.dims[dim] ?? "(none)") === dimValue) : selFacts).map((f) => f.ref), [selFacts, dim, dimValue]);

  const selLabel = def.pointInTime
    ? `As of ${shortDate(c.snapshotDate)}`
    : period
      ? grain === "week" ? `Week of ${weekLabel(period)}` : monthLabel(period)
      : `${range ? `Last ${range} weeks` : "All data"} · ${shortDate(from)} – ${shortDate(to)}`;

  const showProduction = def.group === "Production" || def.id === "units_sold" || def.id === "units_shipped";
  const cols: Col<Record<string, any>>[] = def.refCols.map((rc) => ({ key: rc.key, label: rc.label, unit: rc.unit }));
  const compareDefs = [def, ...compare.map((id) => KPIS.find((k) => k.id === id)!)].filter(Boolean);

  return (
    <div class="explorer">
      <nav class="card kpi-list" aria-label="KPIs">
        {GROUPS.map((g) => (
          <>
            <div class="kpi-group">{g}</div>
            {KPIS.filter((k) => k.group === g).map((k) => (
              <a class="navlink" href={`#/kpi/${k.id}`} aria-current={k.id === def.id ? "page" : undefined}>{k.name}</a>
            ))}
          </>
        ))}
      </nav>

      <div class="stack" style={{ minWidth: 0 }}>
        <select class="select explorer-pick" aria-label="KPI" value={def.id} onChange={(e) => api.go(`kpi/${(e.target as HTMLSelectElement).value}`)}>
          {GROUPS.map((g) => <optgroup label={g}>{KPIS.filter((k) => k.group === g).map((k) => <option value={k.id}>{k.name}</option>)}</optgroup>)}
        </select>

        <Card
          title={def.name}
          sub={`${def.group} · sources: ${def.sources.map((s) => REPORTS[s].label).join(", ")}${!def.locationAware && api.loc !== "All" ? " · no location in this report, showing all locations" : ""}`}
          actions={!def.pointInTime && (
            <div class="row">
              <Seg label="Range" value={range} onChange={setRange} options={[{ value: 13, label: "13 wk" }, { value: 26, label: "26 wk" }, { value: 52, label: "52 wk" }, { value: 0, label: "All" }]} />
              <Seg label="Grain" value={grain} onChange={setGrain} options={[{ value: "week", label: "Weekly" }, { value: "month", label: "Monthly" }]} />
            </div>
          )}
        >
          <p class="definition" style={{ marginTop: 0 }}>{def.description}</p>
          <div class="row" style={{ marginBottom: 12 }}>
            <span class="chip" style={{ cursor: "default" }}>{selLabel}</span>
            {period && <button class="btn small" onClick={() => setPeriod(null)}><IconX /> Show whole range</button>}
            {!period && !def.pointInTime && <span class="small muted">Click a {grain} in the chart to focus on it.</span>}
          </div>
          <div class="stat-row" style={{ marginBottom: 8 }}>
            <div class="stat hero">
              <div class="v">{selValue == null ? "—" : full(selValue, def.unit === "units" || def.unit === "usd" ? def.unit : def.unit)}</div>
              <div class="l">{def.agg === "sum" ? "Total" : def.agg === "ratio" ? "Overall rate" : "Average"} for selection</div>
            </div>
            {extras.map((e) => (
              <div class="stat"><div class="v">{compact(e.value, e.unit)}</div><div class="l">{e.label}</div></div>
            ))}
          </div>
          {!def.pointInTime && <TrendChart def={def} points={points} grain={grain} selected={period ?? undefined} onSelect={(k) => k && setPeriod(k === period ? null : k)} />}
          {!def.pointInTime && points.some((p) => p.partial) && <div class="small muted">Faded or last points are partial: the reports end on {shortDate(cov?.max ?? "")}.</div>}
        </Card>

        <div class="grid-2-even">
          {def.dims.length > 0 && (
            <Card
              title="Breakdown"
              sub={`${selLabel} · click a bar to filter the records`}
              actions={<Seg label="Breakdown by" value={dim} onChange={setDim} options={def.dims.map((d) => ({ value: d.key, label: d.label }))} />}
            >
              <BreakdownChart def={def} rows={rows} selected={dimValue ?? undefined} onSelect={(k) => k && setDimValue(k === dimValue ? null : k)} />
              {rows.length > 12 && <div class="small muted">Top 12 of {rows.length}. Full list in the table below.</div>}
            </Card>
          )}
          {!def.pointInTime && (
            <Card title="Compare" sub="Up to 3 KPIs, indexed to 100 at the first period so different units share one axis">
              <div class="row" style={{ marginBottom: 10 }}>
                {compare.map((id) => (
                  <button class="chip" onClick={() => setCompare(compare.filter((x) => x !== id))}>{KPIS.find((k) => k.id === id)?.name} <IconX /></button>
                ))}
                {compare.length < 2 && (
                  <select class="select" aria-label="Add KPI to compare" value="" onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) setCompare([...compare, v]); }}>
                    <option value="">Add a KPI…</option>
                    {KPIS.filter((k) => !k.pointInTime && k.id !== def.id && !compare.includes(k.id)).map((k) => <option value={k.id}>{k.name}</option>)}
                  </select>
                )}
              </div>
              <CompareChart c={c} defs={compareDefs} facts={(d) => api.facts(d)} from={from} to={to} grain={grain} />
            </Card>
          )}
        </div>

        {showProduction && !def.pointInTime && (
          <Card title="Production vs demand" sub={`Units, ${range ? `last ${range} weeks` : "all data"} · all locations`}>
            <ProductionChart c={c} facts={(d) => api.facts(d, true)} from={from} to={to} grain={grain} onSelect={(k) => k && setPeriod(k)} />
          </Card>
        )}

        {def.dims.length > 0 && (
          <Card title={`By ${def.dims.find((d) => d.key === dim)?.label.toLowerCase()}`} sub={selLabel}>
            <DataTable
              cols={[
                { key: "key", label: def.dims.find((d) => d.key === dim)?.label ?? "" },
                { key: "value", label: def.name, unit: def.unit },
                ...(def.agg === "ratio" ? [{ key: "num", label: def.id === "inventory_accuracy" ? "Counted" : "Numerator", unit: "units" as const }, { key: "den", label: def.id === "inventory_accuracy" ? "Reported" : "Denominator", unit: "units" as const }] : []),
                { key: "n", label: "Records", unit: "count" as const },
              ]}
              rows={rows}
              pageSize={15}
              csvName={`${def.id}-by-${dim}.csv`}
              onRowClick={(r) => setDimValue(r.key === dimValue ? null : r.key)}
              isSelected={(r) => r.key === dimValue}
            />
          </Card>
        )}

        <Card
          title="Records"
          sub={`${selLabel}${dimValue ? ` · ${def.dims.find((d) => d.key === dim)?.label}: ${dimValue}` : ""}`}
          actions={dimValue && <button class="btn small" onClick={() => setDimValue(null)}><IconX /> Clear filter</button>}
        >
          <DataTable cols={cols} rows={records} csvName={`${def.id}-records.csv`} initialSort={{ key: def.refCols[0].key, dir: -1 }} />
        </Card>
      </div>
    </div>
  );
}
