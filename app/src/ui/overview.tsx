// Overview visuals: tile meter, daily calendar heatmap, freight by flow, inventory by site, open-order aging.

import { useMemo, useRef, useState } from "preact/hooks";
import type { Ctx } from "../calc/context";
import { addDays, daysBetween, dowName, longDate, mondayOf, type Period } from "../calc/dates";
import { bucketEnd, bucketOf, KPI_BY_ID, series, stepOf, type Fact, type Grain } from "../calc/kpis";
import type { Status } from "../calc/targets";
import { axisStyle, baseOption, Chart, esc, tipRow } from "./Chart";
import { periodLabelShort, periodLong } from "./charts";
import { compact, full } from "./format";

/** Bullet meter: value bar against a target tick. The fill carries status; the track is a lighter step. */
export function Meter(props: { value: number; target: number; status: Status | null }) {
  const max = Math.max(props.value, props.target) * 1.15 || 1;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  return (
    <div class={`meter ${props.status ?? ""}`} aria-hidden="true">
      <div class="meter-fill" style={{ width: pct(props.value) }} />
      <div class="meter-target" style={{ left: pct(props.target) }} />
    </div>
  );
}

// ---------- Daily calendar heatmap ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One cell per day, weeks as columns. Sequential single-hue ramp in 5 steps; click a day to filter to it. */
export function CalendarHeatmap(props: {
  facts: Fact[];
  unit: "units" | "usd";
  from: string;
  to: string;
  latest: string;
  /** First day the report has data; earlier days are left blank. */
  dataFrom?: string;
  period: Period;
  label: string;
  onPick: (day: string) => void;
}) {
  const { from, to } = props;
  const [tip, setTip] = useState<{ x: number; y: number; d: string; v: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of props.facts) if (f.date >= from && f.date <= to) m.set(f.date, (m.get(f.date) ?? 0) + f.num);
    return m;
  }, [props.facts, from, to]);

  // Quantile breaks over days with activity, so a few huge days don't wash everything else out
  const breaks = useMemo(() => {
    const v = [...byDay.values()].filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) return [];
    return [0.2, 0.4, 0.6, 0.8].map((q) => v[Math.min(v.length - 1, Math.floor(q * v.length))]);
  }, [byDay]);
  const step = (v: number) => (v <= 0 ? 0 : 1 + breaks.filter((b) => v > b).length);

  // Outline the selected period only when it's a small part of the calendar
  const outline = daysBetween(props.period.from, props.period.to) < 62;
  const weeks: string[] = [];
  for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) weeks.push(w);
  const total = [...byDay.values()].reduce((a, b) => a + b, 0);
  const active = [...byDay.values()].filter((v) => v > 0).length;

  const show = (e: Event, d: string, v: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const box = wrap.current!.getBoundingClientRect();
    setTip({ x: r.left - box.left + r.width / 2, y: r.top - box.top, d, v });
  };

  return (
    <div class="heat-wrap" ref={wrap}>
      <div class="heat-scroll">
        <div class="heat" style={{ gridTemplateColumns: `28px repeat(${weeks.length}, minmax(var(--cell), 1fr))`, maxWidth: `${28 + weeks.length * 31}px` }} role="grid" aria-label={props.label}>
          <span />
          {weeks.map((w, i) => {
            const firstOfMonth = [0, 1, 2, 3, 4, 5, 6].map((k) => addDays(w, k)).find((d) => d.slice(8) === "01");
            const label = i === 0 ? MONTHS[+w.slice(5, 7) - 1] : firstOfMonth ? MONTHS[+firstOfMonth.slice(5, 7) - 1] : "";
            return <span class="heat-month">{label}</span>;
          })}
          {[0, 1, 2, 3, 4, 5, 6].map((r) => (
            <>
              <span class="heat-dow">{r % 2 === 0 ? dowName(addDays(weeks[0] ?? from, r)) : ""}</span>
              {weeks.map((w) => {
                const d = addDays(w, r);
                if (d < from || d > to || d > props.latest || (props.dataFrom && d < props.dataFrom)) return <span class="heat-cell empty" />;
                const v = byDay.get(d) ?? 0;
                const inSel = outline && d >= props.period.from && d <= props.period.to;
                return (
                  <button
                    class={`heat-cell s${step(v)} ${inSel ? "sel" : ""}`}
                    aria-label={`${longDate(d)}: ${full(v, props.unit)}`}
                    onPointerEnter={(e) => show(e, d, v)}
                    onFocus={(e) => show(e, d, v)}
                    onPointerLeave={() => setTip(null)}
                    onBlur={() => setTip(null)}
                    onClick={() => { setTip(null); props.onPick(d); }}
                  />
                );
              })}
            </>
          ))}
        </div>
      </div>
      {tip && (
        <div class="heat-tip" style={{ left: tip.x, top: tip.y }} role="status">
          <b>{full(tip.v, props.unit)}</b>
          <span>{dowName(tip.d)} {longDate(tip.d)}</span>
        </div>
      )}
      <div class="heat-foot">
        <span class="small muted">{full(total, props.unit)} over {active} active days {outline ? " · outlined: selected period" : ""} · click a day to filter to it</span>
        <div class="heat-legend" aria-label="Color scale">
          <span class="small muted">Less</span>
          {[0, 1, 2, 3, 4, 5].map((s) => <span class={`heat-cell s${s}`} title={s === 0 ? "None" : s === 1 ? `Up to ${compact(breaks[0] ?? 0, props.unit)}` : s === 5 ? `Over ${compact(breaks[3] ?? 0, props.unit)}` : `${compact(breaks[s - 2] ?? 0, props.unit)} – ${compact(breaks[s - 1] ?? 0, props.unit)}`} />)}
          <span class="small muted">More</span>
        </div>
      </div>
    </div>
  );
}

// ---------- Freight by flow ----------

const FLOWS = [
  { dir: "outbound", label: "To customers", kpi: "freight_net" },
  { dir: "dropship", label: "Drop-ship", kpi: "freight_net" },
  { dir: "inbound", label: "Inbound (POs)", kpi: "inbound_freight" },
  { dir: "transfer", label: "Transfers", kpi: "transfer_freight" },
] as const;

/** Freight spend stacked by flow, per bucket. The legend toggles flows and shows each flow's total for the selected period. */
export function FreightFlowChart(props: { c: Ctx; facts: Fact[]; period: Period; grain: Grain; from: string; to: string; onSelect: (key: string) => void; go: (r: string) => void }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const def = KPI_BY_ID.get("total_freight")!;
  const ser = FLOWS.map((f) => series(props.c, def, props.facts.filter((x) => x.ref.dir === f.dir), props.grain, props.from, props.to));
  const keys = ser[0].map((p) => p.key);
  const inPeriod = FLOWS.map((f) => props.facts.filter((x) => x.ref.dir === f.dir && x.date >= props.period.from && x.date <= props.period.to).reduce((a, x) => a + x.num, 0));
  const totalPeriod = inPeriod.reduce((a, b) => a + b, 0);
  return (
    <div>
      <div class="legend legend-toggle" style={{ marginBottom: 8 }}>
        {FLOWS.map((f, i) => (
          <button
            type="button"
            aria-pressed={!hidden.has(f.dir)}
            onClick={() => setHidden((h) => { const n = new Set(h); n.has(f.dir) ? n.delete(f.dir) : n.add(f.dir); return n; })}
            title={hidden.has(f.dir) ? "Show" : "Hide"}
          >
            <i class="box" style={{ background: `var(--series-${i + 1})` }} />
            {f.label} <b>{compact(inPeriod[i], "usd")}</b>
            <span class="muted">{totalPeriod ? ` ${Math.round((inPeriod[i] / totalPeriod) * 100)}%` : ""}</span>
          </button>
        ))}
      </div>
      <div class="flow-bar" aria-label="Share of freight spend in the selected period">
        {FLOWS.map((f, i) => inPeriod[i] > 0 && (
          <button
            type="button"
            style={{ flexGrow: inPeriod[i], background: `var(--series-${i + 1})` }}
            aria-label={`${f.label}: ${full(inPeriod[i], "usd")}. Open ${KPI_BY_ID.get(f.kpi)!.name}.`}
            title={`${f.label}: ${full(inPeriod[i], "usd")}`}
            onClick={() => props.go(`kpi/${f.kpi}`)}
          />
        ))}
      </div>
      <Chart
        label="Freight spend by flow"
        deps={[props.from, props.to, props.grain, props.facts, hidden, props.period]}
        onClick={(p) => props.onSelect(keys[p.dataIndex])}
        build={(t) => ({
          ...baseOption(t),
          tooltip: {
            ...(baseOption(t).tooltip as object),
            axisPointer: { type: "shadow" },
            formatter: (ps: any[]) => {
              const i = ps[0]?.dataIndex ?? 0;
              const tot = FLOWS.reduce((a, _, k) => a + (ser[k][i].value ?? 0), 0);
              return `<div style="font-weight:600">${esc(periodLong(props.grain, keys[i]))}</div>` +
                tipRow(t.text2, "Total", full(tot, "usd")) +
                FLOWS.map((f, k) => tipRow(t.series[k], f.label, ser[k][i].value == null ? "—" : full(ser[k][i].value!, "usd"))).join("");
            },
          },
          xAxis: { type: "category", data: keys.map((k) => periodLabelShort(props.grain, k)), ...axisStyle(t), splitLine: { show: false } },
          yAxis: { type: "value", ...axisStyle(t), axisLine: { show: false }, axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => compact(v, "usd") } },
          series: FLOWS.map((f, k) => ({
            name: f.label, type: "bar", stack: "f", barMaxWidth: 28,
            data: hidden.has(f.dir) ? [] : ser[k].map((p, i) => ({
              value: p.value,
              itemStyle: { opacity: inBucket(props.grain, keys[i], props.period) ? 1 : 0.5 },
            })),
            itemStyle: { color: t.series[k], borderColor: t.surface, borderWidth: 1 },
          })),
        })}
      />
      <div class="small muted">Brighter bars overlap the selected period. Click a bar to focus on it, a legend item to hide or show a flow, or the share bar to open that KPI.</div>
    </div>
  );
}

/** Whether a chart bucket overlaps the selected period. */
export function inBucket(grain: Grain, key: string, p: { from: string; to: string }) {
  return key <= p.to && bucketEnd(grain, key) >= p.from;
}

// ---------- Inventory by site ----------

/** Active vs dormant inventory value per site (stacked). Click a site to filter the dashboard to it. */
export function InventoryBySite(props: { value: Fact[]; dormant: Fact[]; loc: string; onPick: (loc: string) => void }) {
  const rows = useMemo(() => {
    const m = new Map<string, { total: number; dormant: number }>();
    for (const f of props.value) { const r = m.get(f.dims.location) ?? { total: 0, dormant: 0 }; r.total += f.num; m.set(f.dims.location, r); }
    for (const f of props.dormant) { const r = m.get(f.dims.location) ?? { total: 0, dormant: 0 }; r.dormant += f.num; m.set(f.dims.location, r); }
    return [...m.entries()].map(([loc, r]) => ({ loc, active: Math.max(0, r.total - r.dormant), dormant: r.dormant, total: r.total })).filter((r) => r.total > 0).sort((a, b) => a.total - b.total);
  }, [props.value, props.dormant]);
  const names = ["Active", `Dormant`];
  return (
    <div>
      <div class="legend" style={{ marginBottom: 4 }}>
        {names.map((n, i) => <span><i class="box" style={{ background: `var(--series-${i + 1})` }} />{n}</span>)}
      </div>
      <div style={{ height: Math.max(150, rows.length * 44 + 20) }}>
        <Chart
          label="Inventory value by site, active and dormant"
          deps={[rows, props.loc]}
          onClick={(p) => props.onPick(rows[p.dataIndex]?.loc)}
          build={(t) => ({
            ...baseOption(t),
            grid: { left: 8, right: 70, top: 4, bottom: 4, containLabel: true },
            tooltip: {
              ...(baseOption(t).tooltip as object), axisPointer: { type: "shadow" },
              formatter: (ps: any[]) => {
                const r = rows[ps[0]?.dataIndex ?? 0];
                return `<div style="font-weight:600">${esc(r.loc)}</div>` + tipRow(t.text2, "Total", full(r.total, "usd")) +
                  tipRow(t.series[0], "Active", full(r.active, "usd")) + tipRow(t.series[1], `Dormant (${Math.round((r.dormant / r.total) * 100)}%)`, full(r.dormant, "usd"));
              },
            },
            xAxis: { type: "value", show: false },
            yAxis: { type: "category", data: rows.map((r) => r.loc), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.text2, fontSize: 12 } },
            series: [
              {
                name: "Active", type: "bar", stack: "v", barMaxWidth: 22,
                data: rows.map((r) => ({ value: r.active, itemStyle: { opacity: props.loc !== "All" && props.loc !== r.loc ? 0.4 : 1 } })),
                itemStyle: { color: t.series[0], borderColor: t.surface, borderWidth: 1 },
              },
              {
                name: "Dormant", type: "bar", stack: "v", barMaxWidth: 22,
                data: rows.map((r) => ({ value: r.dormant, itemStyle: { opacity: props.loc !== "All" && props.loc !== r.loc ? 0.4 : 1 } })),
                itemStyle: { color: t.series[1], borderColor: t.surface, borderWidth: 1, borderRadius: [0, 4, 4, 0] },
                label: { show: true, position: "right", color: t.text2, fontSize: 11, formatter: (p: any) => compact(rows[p.dataIndex].total, "usd") },
              },
            ],
          })}
        />
      </div>
      <div class="small muted">As of the latest Stock Levels upload. Click a site to filter the whole dashboard to it.</div>
    </div>
  );
}

// ---------- Open-order aging ----------

const AGE_BUCKETS = [
  { label: "0–3 days", min: 0, max: 3 },
  { label: "4–5", min: 4, max: 5 },
  { label: "6–10", min: 6, max: 10 },
  { label: "11–20", min: 11, max: 20 },
  { label: "21–30", min: 21, max: 30 },
  { label: "Over 30", min: 31, max: Infinity },
];

/** Open orders by age in business days. On-time orders in the accent, late ones in the critical status color. */
export function OrderAging(props: { facts: Fact[]; lateDays: number; onOpen: () => void }) {
  const rows = AGE_BUCKETS.map((b) => {
    const fs = props.facts.filter((f) => Number(f.ref.age) >= b.min && Number(f.ref.age) <= b.max);
    return { ...b, n: fs.length, value: fs.reduce((a, f) => a + Number(f.ref.value), 0), late: b.min > props.lateDays };
  });
  return (
    <div>
      <div class="legend" style={{ marginBottom: 4 }}>
        <span><i class="box" style={{ background: "var(--series-1)" }} />On time</span>
        <span><i class="box" style={{ background: "var(--critical)" }} />Late (over {props.lateDays} business days)</span>
      </div>
      <Chart
        label="Open orders by age"
        deps={[rows]}
        onClick={() => props.onOpen()}
        build={(t) => ({
          ...baseOption(t),
          tooltip: {
            ...(baseOption(t).tooltip as object), axisPointer: { type: "shadow" },
            formatter: (ps: any[]) => {
              const r = rows[ps[0]?.dataIndex ?? 0];
              return `<div style="font-weight:600">${esc(r.label)} open${r.label.includes("days") ? "" : " business days"}</div>` +
                tipRow(r.late ? t.critical : t.series[0], "Orders", String(r.n)) + tipRow(t.muted, "Value waiting", full(r.value, "usd"));
            },
          },
          xAxis: { type: "category", data: rows.map((r) => r.label), ...axisStyle(t), splitLine: { show: false } },
          yAxis: { type: "value", minInterval: 1, ...axisStyle(t), axisLine: { show: false } },
          series: [{
            type: "bar", barMaxWidth: 36,
            data: rows.map((r) => ({ value: r.n, itemStyle: { color: r.late ? t.critical : t.series[0], borderRadius: [4, 4, 0, 0] } })),
            label: { show: true, position: "top", color: t.text2, fontSize: 11 },
          }],
        })}
      />
      <div class="small muted">Open orders as of the latest upload, by business days since ordered. Click for the list.</div>
    </div>
  );
}


// ---------- Count gains vs losses ----------

/** Count adjustments per bucket: gains above the axis, losses below, net as a line. One axis, same unit. */
export function CountAdjustmentsChart(props: { facts: Fact[]; grain: Grain; from: string; to: string; period: Period; onSelect: (key: string) => void }) {
  const keys: string[] = [];
  for (let k = bucketOf(props.grain)(props.from); k <= props.to; k = stepOf(props.grain)(k)) keys.push(k);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const gains = keys.map(() => 0), losses = keys.map(() => 0), n = keys.map(() => 0);
  for (const f of props.facts) {
    if (f.date < props.from || f.date > props.to) continue;
    const i = idx.get(bucketOf(props.grain)(f.date));
    if (i == null) continue;
    if (f.num >= 0) gains[i] += f.num; else losses[i] += f.num;
    n[i]++;
  }
  const net = keys.map((_, i) => (n[i] ? gains[i] + losses[i] : null));
  return (
    <div>
      <div class="legend" style={{ marginBottom: 4 }}>
        <span><i class="box" style={{ background: "var(--series-1)" }} />Gains</span>
        <span><i class="box" style={{ background: "var(--series-2)" }} />Losses</span>
        <span><i style={{ background: "var(--text-primary)" }} />Net</span>
      </div>
      <Chart
        label="Count adjustments, gains and losses"
        deps={[props.facts, props.grain, props.from, props.to, props.period]}
        onClick={(p) => props.onSelect(keys[p.dataIndex])}
        build={(t) => ({
          ...baseOption(t),
          tooltip: {
            ...(baseOption(t).tooltip as object), axisPointer: { type: "shadow" },
            formatter: (ps: any[]) => {
              const i = ps[0]?.dataIndex ?? 0;
              if (!n[i]) return `<div style="font-weight:600">${esc(periodLong(props.grain, keys[i]))}</div><div>No completed counts</div>`;
              return `<div style="font-weight:600">${esc(periodLong(props.grain, keys[i]))}</div>` +
                tipRow(t.text, "Net", full(net[i]!, "usd")) + tipRow(t.series[0], "Gains", full(gains[i], "usd")) + tipRow(t.series[1], "Losses", full(losses[i], "usd")) + tipRow(t.muted, "Count lines", String(n[i]));
            },
          },
          xAxis: { type: "category", data: keys.map((k) => periodLabelShort(props.grain, k)), ...axisStyle(t), splitLine: { show: false } },
          yAxis: { type: "value", ...axisStyle(t), axisLine: { show: false }, axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => compact(v, "usd") } },
          series: [
            { name: "Gains", type: "bar", stack: "a", barMaxWidth: 24, data: gains.map((v, i) => ({ value: v, itemStyle: { opacity: inBucket(props.grain, keys[i], props.period) ? 1 : 0.5 } })), itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] } },
            { name: "Losses", type: "bar", stack: "a", barMaxWidth: 24, data: losses.map((v, i) => ({ value: v, itemStyle: { opacity: inBucket(props.grain, keys[i], props.period) ? 1 : 0.5 } })), itemStyle: { color: t.series[1], borderRadius: [0, 0, 4, 4] } },
            { name: "Net", type: "line", data: net, symbol: "circle", symbolSize: 7, connectNulls: false, lineStyle: { width: 2, color: t.text }, itemStyle: { color: t.text, borderColor: t.surface, borderWidth: 2 } },
          ],
        })}
      />
      <div class="small muted">Dollar value of completed stock-count adjustments. Click a bar to focus on it.</div>
    </div>
  );
}
