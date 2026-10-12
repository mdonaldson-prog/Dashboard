import type { Ctx } from "../calc/context";
import { dowName, longDate, monthLabel, shortDate, weekLabel } from "../calc/dates";
import { bucketEnd, KPI_BY_ID, series, type Fact, type Grain, type KpiDef, type Point } from "../calc/kpis";
import { axisStyle, baseOption, Chart, esc, tipRow } from "./Chart";
import { compact, full } from "./format";

export const periodLabelShort = (grain: Grain, key: string) => (grain === "month" ? monthLabel(key) : shortDate(key));
export const periodLong = (grain: Grain, key: string) => (grain === "day" ? `${dowName(key)} ${longDate(key)}` : grain === "week" ? `Week of ${weekLabel(key)}` : monthLabel(key));
/** Bars outside the selected period are dimmed so it stands out in its context. */
const inSel = (grain: Grain, key: string, sel?: { from: string; to: string }) => !sel || (key <= sel.to && bucketEnd(grain, key) >= sel.from);

function movingAvg(vals: (number | null)[], n: number) {
  return vals.map((_, i) => {
    const win = vals.slice(Math.max(0, i - n + 1), i + 1).filter((v): v is number => v != null);
    return win.length === n ? win.reduce((a, b) => a + b, 0) / n : null;
  });
}

/** KPI over time: columns for totals, a line for rates; plus a 4-period moving average. */
export function TrendChart(props: { def: KpiDef; points: Point[]; grain: Grain; target?: number; selected?: string; highlight?: { from: string; to: string }; short?: boolean; onSelect?: (key: string) => void }) {
  const { def, points, grain } = props;
  const vals = points.map((p) => p.value);
  const ma = movingAvg(vals, 4);
  const asBars = def.agg === "sum";
  // Shade the selected period behind a line chart (bars dim instead)
  const hiIdx = props.highlight && !props.selected ? points.map((p, i) => (inSel(grain, p.key, props.highlight) ? i : -1)).filter((i) => i >= 0) : [];
  const shade = hiIdx.length && hiIdx.length < points.length ? [[{ xAxis: hiIdx[0] }, { xAxis: hiIdx[hiIdx.length - 1] }]] : null;
  return (
    <Chart
      class={props.short ? "" : "tall"}
      label={`${def.name} by ${grain}`}
      deps={[points, props.selected, props.target, props.highlight]}
      onClick={(p) => props.onSelect?.(points[p.dataIndex]?.key)}
      build={(t) => ({
        ...baseOption(t),
        tooltip: {
          ...(baseOption(t).tooltip as object),
          formatter: (ps: any[]) => {
            const i = ps[0]?.dataIndex ?? 0;
            const pt = points[i];
            let h = `<div style="font-weight:600">${esc(periodLong(grain, pt.key))}${pt.partial ? " (partial)" : ""}</div>`;
            h += tipRow(t.series[0], def.name, pt.value == null ? "No data" : full(pt.value, def.unit));
            if (ma[i] != null) h += tipRow(t.muted, "4-period average", full(ma[i]!, def.unit));
            return h;
          },
        },
        xAxis: { type: "category", data: points.map((p) => periodLabelShort(grain, p.key)), ...axisStyle(t), splitLine: { show: false }, axisPointer: { type: asBars ? "shadow" : "line" } },
        yAxis: {
          type: "value", ...axisStyle(t), axisLine: { show: false },
          axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => compact(v, def.unit) },
          ...(def.id === "inventory_accuracy" ? { min: (v: { min: number }) => Math.min(80, Math.floor(v.min / 5) * 5) } : {}),
        },
        series: [
          asBars
            ? {
                name: def.name, type: "bar", barMaxWidth: 24,
                data: points.map((p) => ({
                  value: p.value,
                  itemStyle: {
                    color: t.series[0],
                    opacity: p.partial ? 0.45 : props.selected ? (props.selected === p.key ? 1 : 0.5) : inSel(grain, p.key, props.highlight) ? 1 : 0.5,
                    borderRadius: [4, 4, 0, 0],
                  },
                })),
                emphasis: { itemStyle: { opacity: 1 } },
              }
            : {
                name: def.name, type: "line", data: vals, connectNulls: false, symbol: "circle", symbolSize: 8, showSymbol: true,
                lineStyle: { width: 2, color: t.series[0] }, itemStyle: { color: t.series[0], borderColor: t.surface, borderWidth: 2 },
                ...(shade ? { markArea: { silent: true, itemStyle: { color: t.grid, opacity: 0.7 }, data: shade } } : {}),
                ...(def.unit === "pct" && (def.id === "inventory_accuracy" || def.id === "freight_recovery")
                  ? { markLine: { silent: true, symbol: "none", label: { color: t.muted, fontSize: 10, formatter: "100%" }, lineStyle: { color: t.muted, type: "solid", width: 1, opacity: 0.6 }, data: [{ yAxis: 100 }] } }
                  : {}),
              },
          {
            name: "4-period average", type: "line", data: ma, symbol: "none", lineStyle: { width: 1.5, color: t.muted, opacity: 0.9 }, z: 3,
          },
          ...(props.target != null
            ? [{
                name: "Target", type: "line", data: [], silent: true,
                markLine: {
                  silent: true, symbol: "none",
                  label: { color: t.text2, fontSize: 11, position: "insideEndTop", formatter: `Target ${compact(props.target, def.unit)}` },
                  lineStyle: { color: t.text2, type: "solid", width: 1.5 },
                  data: [{ yAxis: props.target }],
                },
              }]
            : []),
        ],
      })}
    />
  );
}

/** Horizontal bars of a breakdown, top N. */
export function BreakdownChart(props: { def: KpiDef; rows: { key: string; value: number | null; num: number; den: number }[]; selected?: string; onSelect?: (k: string) => void }) {
  const rows = props.rows.filter((r) => r.value != null).slice(0, 12).reverse();
  const h = Math.max(160, rows.length * 30 + 30);
  return (
    <div style={{ height: h }}>
      <Chart
        label={`${props.def.name} breakdown`}
        class=""
        deps={[props.rows, props.selected]}
        onClick={(p) => props.onSelect?.(rows[p.dataIndex]?.key)}
        build={(t) => ({
          ...baseOption(t),
          grid: { left: 8, right: 64, top: 4, bottom: 4, containLabel: true },
          tooltip: {
            ...(baseOption(t).tooltip as object), trigger: "item",
            formatter: (p: any) => `<div style="font-weight:600">${esc(rows[p.dataIndex].key)}</div>${tipRow(t.series[0], props.def.name, full(rows[p.dataIndex].value!, props.def.unit))}`,
          },
          xAxis: { type: "value", show: false },
          yAxis: {
            type: "category", data: rows.map((r) => r.key), axisLine: { show: false }, axisTick: { show: false },
            axisLabel: { color: t.text2, fontSize: 12, width: 170, overflow: "truncate" },
          },
          series: [{
            type: "bar", barMaxWidth: 18,
            data: rows.map((r) => ({ value: r.value, itemStyle: { color: t.series[0], borderRadius: [0, 4, 4, 0], opacity: props.selected && props.selected !== r.key ? 0.45 : 1 } })),
            label: { show: true, position: "right", color: t.text2, fontSize: 11, formatter: (p: any) => compact(p.value, props.def.unit) },
          }],
        })}
      />
    </div>
  );
}

/** Production (stacked: blended, filled, kitted) vs demand (sold, shipped) in units — one axis, same unit. */
export function ProductionChart(props: { c: Ctx; facts: (d: KpiDef) => Fact[]; from: string; to: string; grain: Grain; highlight?: { from: string; to: string }; onSelect?: (k: string) => void }) {
  const ids = ["units_blended", "units_filled", "units_kitted", "units_sold", "units_shipped"];
  const names = ["Blended", "Filled", "Kitted", "Sold", "Shipped"];
  const ser = ids.map((id) => {
    const d = KPI_BY_ID.get(id)!;
    return series(props.c, d, props.facts(d), props.grain, props.from, props.to);
  });
  const keys = ser[0].map((p) => p.key);
  return (
    <div>
      <div class="legend" style={{ marginBottom: 8 }}>
        {names.map((n, i) => (
          <span><i class={i < 3 ? "box" : ""} style={{ background: `var(--series-${i + 1})` }} />{n}</span>
        ))}
      </div>
      <Chart
        label="Production versus demand, units"
        deps={[props.from, props.to, props.grain, props.facts, props.highlight]}
        onClick={(p) => props.onSelect?.(keys[p.dataIndex])}
        build={(t) => ({
          ...baseOption(t),
          tooltip: {
            ...(baseOption(t).tooltip as object),
            formatter: (ps: any[]) => {
              const i = ps[0]?.dataIndex ?? 0;
              return `<div style="font-weight:600">${esc(periodLong(props.grain, keys[i]))}</div>` +
                names.map((n, k) => tipRow(t.series[k], n, ser[k][i].value == null ? "—" : full(ser[k][i].value!, "units"))).join("");
            },
          },
          xAxis: { type: "category", data: keys.map((k) => periodLabelShort(props.grain, k)), ...axisStyle(t), splitLine: { show: false } },
          yAxis: { type: "value", ...axisStyle(t), axisLine: { show: false }, axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => compact(v, "units") } },
          series: [
            ...[0, 1, 2].map((k) => ({
              name: names[k], type: "bar", stack: "prod", barMaxWidth: 24,
              data: ser[k].map((p) => ({ value: p.value, itemStyle: { opacity: inSel(props.grain, p.key, props.highlight) ? 1 : 0.5 } })),
              itemStyle: { color: t.series[k], borderColor: t.surface, borderWidth: 1, borderRadius: k === 2 ? [4, 4, 0, 0] : 0 },
            })),
            ...[3, 4].map((k) => ({
              name: names[k], type: "line", data: ser[k].map((p) => p.value), symbol: "circle", symbolSize: 7,
              lineStyle: { width: 2, color: t.series[k] }, itemStyle: { color: t.series[k], borderColor: t.surface, borderWidth: 2 },
            })),
          ],
        })}
      />
    </div>
  );
}
