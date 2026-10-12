import { useEffect, useMemo, useState } from "preact/hooks";
import type { AppApi } from "../App";
import { addDays, periodLabel, PERIOD_NOUN, periodAt, shortDate } from "../calc/dates";
import { breakdown, bucketEnd, coveredWorkingDays, bucketOf, contextWindow, coverageOf, KPIS, periodValue, portalGap, series, type Grain, type KpiDef } from "../calc/kpis";
import { periodTarget, STATUS_LABEL, targetStatus } from "../calc/targets";
import { REPORTS } from "../data/model";
import { BreakdownChart, periodLong, ProductionChart, TrendChart } from "../ui/charts";
import { Card, DataTable, Delta, Seg, type Col } from "../ui/components";
import { compact, full } from "../ui/format";
import { IconAlert, IconCheck, IconX } from "../ui/icons";

const GROUPS = ["Inventory", "Production", "Sales & fulfillment", "Freight"] as const;

type Range = "auto" | "6m" | "1y" | "all";

export function Explorer(props: { api: AppApi; def: KpiDef }) {
  const { api, def } = props;
  const { c } = api;
  const ctx = contextWindow(api.period, api.dataMin);
  const [range, setRange] = useState<Range>("auto");
  const [grainSel, setGrain] = useState<Grain | null>(null);
  const grain = grainSel ?? ctx.grain;
  const [focus, setFocus] = useState<string | null>(null); // a clicked chart bucket
  const [dim, setDim] = useState(def.dims[0]?.key ?? "");
  const [dimValue, setDimValue] = useState<string | null>(null);

  useEffect(() => { setFocus(null); setDim(def.dims[0]?.key ?? ""); setDimValue(null); }, [def.id]);
  useEffect(() => { setFocus(null); }, [grain, range, api.period.from, api.period.to]);
  useEffect(() => { setGrain(null); }, [api.period.kind]);
  useEffect(() => { setDimValue(null); }, [dim, focus]);

  const facts = api.facts(def);
  const cov = coverageOf(c, def);
  const to = api.period.to;
  let from = range === "auto" ? ctx.from : range === "6m" ? addDays(to, -182) : range === "1y" ? addDays(to, -364) : cov?.min ?? addDays(to, -364);
  if (api.period.from < from) from = api.period.from;
  const points = useMemo(() => (def.pointInTime ? [] : series(c, def, facts, grain, from, to)), [def, facts, grain, from, to]);

  // Selection: a clicked bucket, or the global period
  const sel = focus ? { from: focus, to: bucketEnd(grain, focus) } : api.period;
  const selPrior = focus ? { from: bucketOf(grain)(addDays(focus, -1)), to: addDays(focus, -1) } : api.prior;
  const cur = periodValue(c, def, facts, sel);
  const selFacts = def.pointInTime ? facts : cur.facts;
  const selValue = cur.value;
  const prevValue = def.pointInTime ? null : periodValue(c, def, facts, selPrior).value;
  const target = periodTarget(def, api.s.targets[def.id], coveredWorkingDays(c, def, sel));
  const status = targetStatus(def, selValue, target);
  const extras = def.extras && selValue != null ? def.extras(selFacts) : [];
  const rows = useMemo(() => (dim ? breakdown(def, selFacts, dim) : []), [def, selFacts, dim]);
  const records = useMemo(() => (dimValue ? selFacts.filter((f) => (f.dims[dim] ?? "(none)") === dimValue) : selFacts).map((f) => f.ref), [selFacts, dim, dimValue]);

  const selLabel = def.pointInTime ? `As of ${shortDate(c.snapshotDate)}` : focus ? periodLong(grain, focus) : periodLabel(api.period);
  // Per-week unit targets drawn per bucket: a day gets a fifth, a month is too uneven to draw
  const wt = api.s.targets[def.id]?.value;
  const chartTarget = wt == null ? undefined : def.agg !== "sum" ? wt : grain === "week" ? wt : grain === "day" ? wt / 5 : undefined;

  const showProduction = def.group === "Production" || def.id === "units_sold" || def.id === "units_shipped";
  const cols: Col<Record<string, any>>[] = def.refCols.map((rc) => ({ key: rc.key, label: rc.label, unit: rc.unit }));

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
              <Seg label="Chart range" value={range} onChange={setRange} options={[{ value: "auto", label: "Around period" }, { value: "6m", label: "6 mo" }, { value: "1y", label: "1 yr" }, { value: "all", label: "All" }]} />
              <Seg label="Grain" value={grain} onChange={setGrain} options={[{ value: "day", label: "Daily" }, { value: "week", label: "Weekly" }, { value: "month", label: "Monthly" }]} />
            </div>
          )}
        >
          <p class="definition" style={{ marginTop: 0 }}>{def.description}</p>
          {portalGap(c, def, api.loc) && <p class="badge warn" style={{ whiteSpace: "normal", marginTop: 0 }}>{portalGap(c, def, api.loc)} Choose "All locations" to see freight for DFW and Houston.</p>}
          <div class="row" style={{ marginBottom: 12 }}>
            <span class="chip" style={{ cursor: "default" }}>{selLabel}</span>
            {focus && <button class="btn small" onClick={() => setFocus(null)}><IconX /> Back to {periodLabel(api.period)}</button>}
            {focus && <button class="btn small" onClick={() => api.setPeriod(periodAt(grain, focus))}>Make this the dashboard period</button>}
            {!focus && !def.pointInTime && <span class="small muted">Highlighted in the chart. Click a {grain} to focus on it.</span>}
          </div>
          <div class="stat-row" style={{ marginBottom: 8 }}>
            <div class="stat hero">
              <div class="v">{selValue == null ? "—" : full(selValue, def.unit === "units" || def.unit === "usd" ? def.unit : def.unit)}</div>
              <div class="l">{def.agg === "sum" ? "Total" : def.agg === "ratio" ? "Overall rate" : "Average"} for selection</div>
              {!def.pointInTime && <Delta cur={selValue} prev={prevValue} unit={def.unit} better={def.better} vs={`vs prior ${focus ? grain : PERIOD_NOUN[api.period.kind]}`} />}
              {target && status && (
                <div class={`tile-target ${status}`}>
                  <span class={`status-dot ${status}`}>{status === "good" ? <IconCheck /> : <IconAlert />}</span>
                  {STATUS_LABEL[status]} · target {compact(target.value, def.unit)}
                </div>
              )}
              {cur.partial && <div class="small muted">Partial: the reports don't cover the whole selection</div>}
            </div>
            {extras.map((e) => (
              <div class="stat"><div class="v">{compact(e.value, e.unit)}</div><div class="l">{e.label}</div></div>
            ))}
          </div>
          {!def.pointInTime && <TrendChart def={def} points={points} grain={grain} target={chartTarget} selected={focus ?? undefined} highlight={api.period} onSelect={(k) => k && setFocus(k === focus ? null : k)} />}
          {!def.pointInTime && points.some((p) => p.partial) && <div class="small muted">Faded or last points are partial: the reports end on {shortDate(cov?.max ?? "")}.</div>}
        </Card>

        <div>
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
        </div>

        {showProduction && !def.pointInTime && (
          <Card title="Production vs demand" sub={`Units by ${grain} · all locations · click a bar to focus on it`}>
            <ProductionChart c={c} facts={(d) => api.facts(d, true)} from={from} to={to} grain={grain} highlight={focus ? sel : api.period} onSelect={(k) => k && setFocus(k)} />
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
