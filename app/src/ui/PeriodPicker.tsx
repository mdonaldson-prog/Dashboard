// Global date filter: day / week / month / year / custom range, with previous/next stepping.

import { useMemo } from "preact/hooks";
import { addDays, periodAt, periodLabel, shiftPeriod, type Period, type PeriodKind } from "../calc/dates";
import { Seg } from "./components";

const KINDS: { value: PeriodKind; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
  { value: "custom", label: "Custom" },
];

const Chevron = (props: { dir: "left" | "right" }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={props.dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
  </svg>
);

export function PeriodPicker(props: { value: Period; onChange: (p: Period) => void; latest: string; dataMin: string; lastWeek: string }) {
  const { value: p, latest, dataMin } = props;

  // Switching kind keeps you near the dates you were looking at, preferring a complete period
  const switchKind = (kind: PeriodKind) => {
    if (kind === p.kind) return;
    if (kind === "custom") return props.onChange({ kind, from: p.from, to: p.to > latest ? latest : p.to });
    const anchor = p.to > latest ? latest : p.to;
    let next = periodAt(kind, anchor);
    if (kind !== "day" && next.to > latest) {
      const prev = shiftPeriod(next, -1);
      if (prev.to >= dataMin && kind !== "year") next = prev;
    }
    props.onChange(next);
  };

  // Every period of this kind that has data, newest first
  const options = useMemo(() => {
    if (p.kind === "custom") return [];
    const out: Period[] = [];
    for (let q = periodAt(p.kind, latest); q.to >= dataMin && out.length < 400; q = shiftPeriod(q, -1)) out.push(q);
    if (!out.some((q) => q.from === p.from)) out.push(p);
    return out;
  }, [p.kind, latest, dataMin, p.from]);

  const tag = (q: Period) => {
    if (q.kind === "week" && q.from === props.lastWeek) return "Last week · ";
    if (q.kind === "day" && q.from === latest) return "Latest day · ";
    return "";
  };
  const prev = shiftPeriod(p, -1);
  const next = shiftPeriod(p, 1);

  return (
    <div class="period-picker">
      <Seg label="Period" value={p.kind} onChange={switchKind} options={KINDS} />
      {p.kind === "custom" ? (
        <div class="row" style={{ gap: 6 }}>
          <input class="input" type="date" aria-label="From" value={p.from} max={p.to}
            onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v) props.onChange({ kind: "custom", from: v, to: v > p.to ? v : p.to }); }} />
          <span class="muted small">to</span>
          <input class="input" type="date" aria-label="To" value={p.to} min={p.from}
            onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v) props.onChange({ kind: "custom", from: p.from > v ? v : p.from, to: v }); }} />
          <div class="row" style={{ gap: 4 }}>
            {[{ l: "Last 30 days", d: 30 }, { l: "Last 90 days", d: 90 }].map((x) => (
              <button class="btn small" onClick={() => props.onChange({ kind: "custom", from: addDays(latest, -(x.d - 1)), to: latest })}>{x.l}</button>
            ))}
            <button class="btn small" onClick={() => props.onChange({ kind: "custom", from: latest.slice(0, 4) + "-01-01", to: latest })}>Year to date</button>
          </div>
        </div>
      ) : (
        <div class="stepper">
          <button class="btn ghost icon" aria-label={`Previous ${p.kind}`} disabled={prev.to < dataMin} onClick={() => props.onChange(prev)}><Chevron dir="left" /></button>
          <select class="select" aria-label={`Choose ${p.kind}`} value={p.from} onChange={(e) => { const q = options.find((o) => o.from === (e.target as HTMLSelectElement).value); if (q) props.onChange(q); }}>
            {options.map((q) => <option value={q.from}>{tag(q)}{periodLabel(q)}{q.to > latest ? " (partial)" : ""}</option>)}
          </select>
          <button class="btn ghost icon" aria-label={`Next ${p.kind}`} disabled={next.from > latest} onClick={() => props.onChange(next)}><Chevron dir="right" /></button>
        </div>
      )}
    </div>
  );
}
