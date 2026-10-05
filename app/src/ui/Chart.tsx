// Thin ECharts wrapper: themed from CSS tokens, resizes with its container,
// re-renders when the light/dark theme changes.

import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { useEffect, useRef } from "preact/hooks";

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer]);

export interface Tokens {
  text: string;
  text2: string;
  muted: string;
  grid: string;
  surface: string;
  series: string[];
  good: string;
  critical: string;
}

export function tokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    text: v("--text-primary"),
    text2: v("--text-secondary"),
    muted: v("--text-muted"),
    grid: v("--grid"),
    surface: v("--surface-1"),
    series: [1, 2, 3, 4, 5].map((i) => v(`--series-${i}`)),
    good: v("--good"),
    critical: v("--critical"),
  };
}

/** Escape text before it goes into tooltip HTML (product and customer names are data, not markup). */
export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Shared axis/grid styling: hairline solid gridlines, recessive axes. */
export function baseOption(t: Tokens): EChartsCoreOption {
  return {
    animationDuration: 300,
    textStyle: { fontFamily: getComputedStyle(document.body).fontFamily, color: t.text2 },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: t.surface,
      borderColor: t.grid,
      textStyle: { color: t.text, fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 } },
      extraCssText: "border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);",
    },
  };
}

export const axisStyle = (t: Tokens) => ({
  axisLine: { lineStyle: { color: t.grid } },
  axisTick: { show: false },
  axisLabel: { color: t.muted, fontSize: 11 },
  splitLine: { lineStyle: { color: t.grid, type: "solid" as const, width: 1 } },
});

/** Tooltip row: value first (strong), then a line key and the series name. */
export const tipRow = (color: string, name: string, value: string) =>
  `<div style="display:flex;align-items:center;gap:8px;margin-top:3px"><span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${color}"></span><b>${esc(value)}</b><span style="opacity:.75">${esc(name)}</span></div>`;

export function Chart(props: {
  build: (t: Tokens) => EChartsCoreOption;
  deps: unknown[];
  class?: string;
  onClick?: (p: { dataIndex: number; seriesIndex: number; name: string }) => void;
  label: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(props.onClick);
  clickRef.current = props.onClick;
  const buildRef = useRef(props.build);
  buildRef.current = props.build;

  useEffect(() => {
    const c = echarts.init(el.current!, undefined, { renderer: "canvas" });
    chart.current = c;
    c.on("click", (p: any) => clickRef.current?.({ dataIndex: p.dataIndex, seriesIndex: p.seriesIndex, name: p.name }));
    const ro = new ResizeObserver(() => { if (el.current?.clientWidth) c.resize(); }); // ignore while hidden (print)
    ro.observe(el.current!);
    const render = () => c.setOption(buildRef.current(tokens()), true);
    // Re-fit to the page when printing (the print layout is narrower than the screen)
    // Canvas prints at its screen size, so print uses a full-width image snapshot instead
    const refit = () => {
      if (img.current && el.current?.clientWidth) img.current.src = c.getDataURL({ pixelRatio: 2, backgroundColor: tokens().surface });
    };
    window.addEventListener("beforeprint", refit);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const mo = new MutationObserver(render);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    mq.addEventListener("change", render);
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", render);
      window.removeEventListener("beforeprint", refit);
      c.dispose();
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(props.build(tokens()), true);
  }, props.deps);

  return (
    <div class="chart-wrap">
      <div ref={el} class={`chart ${props.class ?? ""}`} role="img" aria-label={props.label} />
      <img ref={img} class="print-img" alt={props.label} />
    </div>
  );
}
