import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Better, Unit } from "../calc/kpis";
import { downloadCsv } from "./csv";
import { longDate } from "../calc/dates";
import { full } from "./format";
import { IconDown, IconDownload, IconUp, IconX } from "./icons";

export function Card(props: { title?: ComponentChildren; sub?: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`card ${props.class ?? ""}`}>
      {(props.title || props.actions) && (
        <div class="card-head">
          <div>
            {props.title && <h2>{props.title}</h2>}
            {props.sub && <div class="card-sub">{props.sub}</div>}
          </div>
          <div class="spacer" />
          {props.actions}
        </div>
      )}
      <div class="card-body">{props.children}</div>
    </section>
  );
}

export function Seg<T extends string | number>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button type="button" aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Direction-aware change indicator: icon + signed value + comparison label, colored good/bad. */
export function Delta(props: { cur: number | null; prev: number | null; unit: Unit; better: Better; vs: string }) {
  const { cur, prev, unit, better } = props;
  if (cur == null || prev == null || isNaN(cur) || isNaN(prev)) return <span class="tile-delta delta-flat">No prior data</span>;
  const diff = cur - prev;
  const pctPts = unit === "pct" || unit === "days";
  const rel = prev !== 0 ? (diff / Math.abs(prev)) * 100 : NaN;
  const text = pctPts ? `${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(1)}${unit === "pct" ? " pts" : " d"}` : isNaN(rel) ? "new" : `${diff >= 0 ? "+" : "−"}${Math.abs(rel).toFixed(0)}%`;
  let good: boolean | null = null;
  if (Math.abs(diff) < 1e-9) good = null;
  else if (better === "up") good = diff > 0;
  else if (better === "down") good = diff < 0;
  else if (better === "near100") good = Math.abs(cur - 100) < Math.abs(prev - 100);
  const cls = good == null ? "delta-flat" : good ? "delta-good" : "delta-bad";
  return (
    <span class={`tile-delta ${cls}`}>
      {diff > 0 ? <IconUp /> : diff < 0 ? <IconDown /> : null}
      <span style={{ display: "contents" }}>{text}</span>
      <span class="muted" style={{ fontWeight: 400 }}>{props.vs}</span>
      {good != null && <span class="sr-only">{good ? "(better)" : "(worse)"}</span>}
    </span>
  );
}

/** 13-point sparkline: history in a recessive tone, the current period as an accent dot. */
export function Sparkline(props: { values: (number | null)[]; highlight?: number }) {
  const vals = props.values;
  const w = 96;
  const h = 30;
  const nums = vals.filter((v): v is number => v != null && !isNaN(v));
  if (nums.length < 2) return <svg width={w} height={h} aria-hidden="true" />;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const x = (i: number) => (i / (vals.length - 1)) * (w - 6) + 3;
  const y = (v: number) => (max === min ? h / 2 : h - 4 - ((v - min) / (max - min)) * (h - 8));
  let d = "";
  vals.forEach((v, i) => {
    if (v == null || isNaN(v)) return;
    d += `${d && vals[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  const hi = props.highlight ?? vals.length - 1;
  const hv = vals[hi];
  return (
    <svg width={w} height={h} aria-hidden="true" style={{ flex: "none" }}>
      <path d={d} fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.7" />
      {hv != null && !isNaN(hv) && <circle cx={x(hi)} cy={y(hv)} r="3.5" fill="var(--accent)" stroke="var(--surface-1)" stroke-width="2" />}
    </svg>
  );
}

export interface Col<R> { key: string; label: string; unit?: Unit; render?: (r: R) => ComponentChildren; sortValue?: (r: R) => number | string; num?: boolean }

export function DataTable<R extends Record<string, any>>(props: {
  cols: Col<R>[];
  rows: R[];
  csvName?: string;
  pageSize?: number;
  onRowClick?: (r: R) => void;
  isSelected?: (r: R) => boolean;
  empty?: string;
  initialSort?: { key: string; dir: 1 | -1 };
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(props.initialSort ?? null);
  const [limit, setLimit] = useState(props.pageSize ?? 50);
  useEffect(() => setLimit(props.pageSize ?? 50), [props.rows]);
  const sorted = useMemo(() => {
    if (!sort) return props.rows;
    const col = props.cols.find((c) => c.key === sort.key);
    const get = (r: R) => (col?.sortValue ? col.sortValue(r) : r[sort.key]);
    return [...props.rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * sort.dir;
      return String(va ?? "").localeCompare(String(vb ?? "")) * sort.dir;
    });
  }, [props.rows, sort]);
  const isNum = (c: Col<R>) => c.num ?? (c.unit !== undefined);
  const exportCsv = () =>
    downloadCsv(props.csvName ?? "export.csv", props.cols.map((c) => c.label), sorted.map((r) => props.cols.map((c) => (c.sortValue ? c.sortValue(r) : r[c.key]))));
  return (
    <div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              {props.cols.map((c) => (
                <th
                  class={isNum(c) ? "num" : ""}
                  aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                  onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key ? ((-s.dir) as 1 | -1) : isNum(c) ? -1 : 1 }))}
                >
                  {c.label}
                  {sort?.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((r) => (
              <tr class={`${props.onRowClick ? "clickable" : ""} ${props.isSelected?.(r) ? "selected" : ""}`} onClick={() => props.onRowClick?.(r)}>
                {props.cols.map((c) => (
                  <td class={isNum(c) ? "num nowrap" : ""}>{c.render ? c.render(r) : cell(r[c.key], c.unit)}</td>
                ))}
              </tr>
            ))}
            {!sorted.length && (
              <tr>
                <td colSpan={props.cols.length} class="muted" style={{ padding: "18px 10px" }}>{props.empty ?? "No records."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div class="table-foot">
        <span>
          {Math.min(limit, sorted.length).toLocaleString()} of {sorted.length.toLocaleString()} rows
        </span>
        {limit < sorted.length && (
          <button class="btn small" onClick={() => setLimit(limit + (props.pageSize ?? 50) * 4)}>Show more</button>
        )}
        <div class="spacer" />
        {props.csvName && sorted.length > 0 && (
          <button class="btn small" onClick={exportCsv}><IconDownload /> CSV</button>
        )}
      </div>
    </div>
  );
}

/** ISO dates in records read as "Sep 25, 2026"; everything else uses the unit formatter. */
const cell = (v: unknown, unit?: Unit) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? <span class="nowrap">{longDate(v)}</span> : full(v as any, unit));

export function Drawer(props: { title: ComponentChildren; actions?: ComponentChildren; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return (
    <div class="drawer-bg" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <div style={{ minWidth: 0 }}>{props.title}</div>
          <div class="spacer" />
          {props.actions}
          <button class="btn ghost" onClick={props.onClose} aria-label="Close"><IconX /></button>
        </div>
        <div class="drawer-body">{props.children}</div>
      </div>
    </div>
  );
}
