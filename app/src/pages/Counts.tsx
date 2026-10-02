import { useMemo, useState } from "preact/hooks";
import type { AppApi } from "../App";
import { CLASS_LABEL, CLASSES, type LocationPlan, type ScheduledCount } from "../calc/counts";
import { addDays, dowName, longDate, shortDate, weekLabel } from "../calc/dates";
import type { LocationSettings, VelocityClass } from "../data/settings";
import { Card, DataTable, Drawer, Seg } from "../ui/components";
import { downloadCsv } from "../ui/csv";
import { IconAlert, IconDownload, IconPrint } from "../ui/icons";

const CADENCE_OPTS: Record<VelocityClass, number[]> = { fast: [1, 2], medium: [2, 3, 4], slow: [4, 6, 8], dormant: [26, 52] };
const cadenceLabel = (w: number) => (w === 1 ? "Weekly" : w === 2 ? "Every 2 weeks" : w === 4 ? "Monthly (4 wk)" : w === 52 ? "Yearly" : `Every ${w} weeks`);

function ClassDot(props: { cls: VelocityClass }) {
  return <span class={`dot cls-dot cls-${props.cls}`} aria-hidden="true" />;
}

export function Counts(props: { api: AppApi }) {
  const { api } = props;
  const { s } = api;
  const [locSel, setLoc] = useState(() => api.plans.find((p) => p.active)?.location ?? api.plans[0]?.location ?? "");
  const [day, setDay] = useState<string | null>(null);
  const [printDays, setPrintDays] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [clsFilter, setClsFilter] = useState<"all" | VelocityClass>("all");
  const plan = api.plans.find((p) => p.location === locSel) ?? api.plans[0];

  const weeks = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const d of plan?.days ?? []) {
      const wk = addDays(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));
      m.set(wk, [...(m.get(wk) ?? []), d]);
    }
    return [...m.entries()];
  }, [plan]);
  const dows = s.counts.workingDays;
  if (!plan) return <Card title="No stock levels loaded">Load the Stock Levels report to build a count schedule.</Card>;
  const ls = s.locations[plan.location] ?? { countingActive: false, capacityPerDay: 50, portalCity: "" };

  const setLoc2 = (patch: Partial<LocationSettings>) =>
    api.setS((x) => ({ ...x, locations: { ...x.locations, [plan.location]: { ...ls, ...patch } } }));

  const print = (days: string[]) => {
    setPrintDays(days);
    setTimeout(() => window.print(), 50);
  };
  const exportDay = (d: string) => {
    const list = plan.byDay.get(d) ?? [];
    downloadCsv(`count-${plan.location}-${d}.csv`, ["SKU", "ProductName", "Location", "Sublocations", "Class"], list.map((x) => [x.sku, x.product, plan.location, x.sublocations.join("; "), CLASS_LABEL[x.cls]]));
  };


  const over = plan.requiredPerDay > plan.capacity;
  const pct = Math.min(100, (plan.requiredPerDay / Math.max(plan.capacity, 1)) * 100);
  const skus = plan.skus.filter((k) => (clsFilter === "all" || k.cls === clsFilter) && (!q || `${k.sku} ${k.product}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <>
      <PrintSheets plan={plan} days={printDays} />
      <div class="stack no-print">
        <div class="row">
          <Seg label="Location" value={plan.location} onChange={setLoc} options={api.plans.map((p) => ({ value: p.location, label: p.location }))} />
          <div class="spacer" />
          <label class="toggle">
            <input type="checkbox" checked={ls.countingActive} onChange={(e) => setLoc2({ countingActive: (e.target as HTMLInputElement).checked })} />
            <span>Counting active at {plan.location}</span>
          </label>
        </div>
        {!plan.active && (
          <div class="card" style={{ padding: "12px 16px" }}>
            <span class="badge info">Preview</span> <span class="secondary">Counting hasn't started at {plan.location}. This is the schedule it would follow. Turn on "Counting active" when counts begin.</span>
          </div>
        )}

        <div class="grid-2">
          <Card title="Capacity check" sub={`Starting ${longDate(plan.start)} · ${plan.days.length} counting days`}>
            <div class="stat-row" style={{ marginBottom: 12 }}>
              <div class="stat hero"><div class="v">{plan.requiredPerDay.toFixed(1)}</div><div class="l">SKUs/day needed</div></div>
              <div class="stat"><div class="v">{plan.capacity}</div><div class="l">SKUs/day capacity</div></div>
              <div class="stat"><div class="v">{plan.atRisk.toLocaleString()}</div><div class="l">Counts at risk ({s.counts.horizonWeeks} wk)</div></div>
            </div>
            <div class="meter" role="meter" aria-valuenow={plan.requiredPerDay} aria-valuemax={plan.capacity} aria-label="Needed vs capacity">
              <span style={{ width: `${pct}%`, background: over ? "var(--critical)" : pct > 90 ? "var(--warning)" : "var(--good)" }} />
            </div>
            <div class="row small" style={{ marginTop: 8 }}>
              {over ? <span class="badge bad"><IconAlert /> Over capacity by {(plan.requiredPerDay - plan.capacity).toFixed(1)}/day</span> : <span class="badge good">Fits within capacity</span>}
              {plan.unplaced.length > 0 && <span class="muted">{plan.unplaced.length.toLocaleString()} counts don't fit anywhere in the next {s.counts.horizonWeeks} weeks.</span>}
            </div>
            {over && (
              <div style={{ marginTop: 14 }}>
                <div class="small secondary" style={{ marginBottom: 6 }}>Ways to close the gap:</div>
                {plan.levers.map((l) => (
                  <div class="row small" style={{ padding: "4px 0", borderTop: "1px solid var(--border)" }}>
                    <span>{l.label}</span><div class="spacer" />
                    <b>{l.perDay.toFixed(1)}/day</b>
                    {l.perDay <= plan.capacity ? <span class="badge good">fits</span> : <span class="badge warn">short</span>}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Settings" sub="Changes apply immediately and are saved in this browser">
            <div class="stack" style={{ gap: 12 }}>
              <label class="field">
                Daily capacity at {plan.location}: <b style={{ color: "var(--text-primary)" }}>{ls.capacityPerDay} SKUs</b>
                <input type="range" min={20} max={100} step={5} value={ls.capacityPerDay} onInput={(e) => setLoc2({ capacityPerDay: +(e.target as HTMLInputElement).value })} />
              </label>
              <label class="field">
                Fast movers = SKUs making up the top
                <select class="select" value={s.counts.fastCutoff} onChange={(e) => api.setS((x) => ({ ...x, counts: { ...x.counts, fastCutoff: +(e.target as HTMLSelectElement).value } }))}>
                  {[60, 65, 70, 75, 80, 85].map((v) => <option value={v}>{v}% of transactions</option>)}
                </select>
              </label>
              <div class="class-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                {CLASSES.map((k) => (
                  <label class="field">
                    <span><ClassDot cls={k} /> {CLASS_LABEL[k]} cadence</span>
                    <select class="select" value={s.counts.cadenceWeeks[k]} onChange={(e) => api.setS((x) => ({ ...x, counts: { ...x.counts, cadenceWeeks: { ...x.counts.cadenceWeeks, [k]: +(e.target as HTMLSelectElement).value } } }))}>
                      {CADENCE_OPTS[k].map((w) => <option value={w}>{cadenceLabel(w)}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          </Card>
        </div>

        <div class="class-grid">
          {CLASSES.map((k) => {
            const wc = plan.withinCadence[k];
            return (
              <div class="class-card card">
                <div class="row small secondary"><ClassDot cls={k} /> {CLASS_LABEL[k]} · {cadenceLabel(s.counts.cadenceWeeks[k]).toLowerCase()}</div>
                <div style={{ fontSize: 22, fontWeight: 650 }}>{plan.classCounts[k].toLocaleString()} <span class="small muted" style={{ fontWeight: 400 }}>SKUs</span></div>
                <div class="small muted">{wc.total ? `${Math.round((wc.ok / wc.total) * 100)}% counted within cadence` : "—"}</div>
              </div>
            );
          })}
        </div>

        <Card
          title="Schedule"
          sub="Click a day to see its count list. Faded segments show the mix of fast, medium, slow and dormant SKUs."
          actions={weeks[0] && <button class="btn" onClick={() => print(weeks[0][1])}><IconPrint /> Print first week</button>}
        >
          <div class="cal" style={{ ["--cols" as any]: dows.length }}>
            <div class="cal-row">
              <span />
              {dows.map((d) => <div class="cal-head">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]}</div>)}
            </div>
            {weeks.map(([wk, days]) => (
              <div class="cal-row">
                <div class="cal-week">{shortDate(wk)}</div>
                {dows.map((dw) => {
                  const d = days.find((x) => new Date(x + "T00:00:00Z").getUTCDay() === dw);
                  if (!d) return <div class="cal-cell empty" title="Holiday or blackout" />;
                  const list = plan.byDay.get(d) ?? [];
                  const risk = list.filter((x) => x.atRisk).length;
                  return (
                    <button class={`cal-cell ${day === d ? "selected" : ""}`} onClick={() => setDay(d)} aria-label={`${longDate(d)}: ${list.length} counts`}>
                      <div class="row" style={{ gap: 4 }}>
                        <span class="n">{list.length}</span>
                        <span class="small muted lbl">/ {plan.capacity}</span>
                        {risk > 0 && <span class="badge warn lbl" style={{ marginLeft: "auto", padding: "0 6px" }} title={`${risk} at risk`}>{risk}</span>}
                      </div>
                      <div class="cal-bar" aria-hidden="true">
                        {CLASSES.map((k) => {
                          const n = list.filter((x) => x.cls === k).length;
                          return n ? <span class={`cls-${k}`} style={{ width: `${(n / Math.max(plan.capacity, list.length)) * 100}%`, background: "var(--c)" }} /> : null;
                        })}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div class="legend" style={{ marginTop: 12 }}>
            {CLASSES.map((k) => <span><i class={`box cls-${k}`} style={{ background: "var(--c)" }} />{CLASS_LABEL[k]}</span>)}
            <span><span class="badge warn" style={{ padding: "0 6px" }}>n</span> counts placed outside their window</span>
          </div>
        </Card>

        <Card title="Velocity classes" sub={`Transactions in the last ${s.counts.lookbackDays} days: sales lines, manufacturing, BOM components and inter-site transfers. Override a class to pin a SKU.`}>
          <div class="row" style={{ marginBottom: 10 }}>
            <input class="input" placeholder="Search SKU or product" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ flex: "1 1 220px" }} />
            <Seg label="Class" value={clsFilter} onChange={setClsFilter} options={[{ value: "all", label: "All" }, ...CLASSES.map((k) => ({ value: k, label: CLASS_LABEL[k] }))]} />
          </div>
          <DataTable
            rows={skus}
            pageSize={25}
            csvName={`velocity-${plan.location}.csv`}
            cols={[
              { key: "sku", label: "SKU" },
              { key: "product", label: "Product" },
              { key: "transactions", label: "Transactions", unit: "count" },
              { key: "cumulativePct", label: "Cumulative %", unit: "pct" },
              {
                key: "cls", label: "Class", sortValue: (r) => CLASSES.indexOf(r.cls),
                render: (r) => (
                  <select class="select" style={{ height: 28 }} value={r.cls} aria-label={`Class for ${r.sku}`} onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = (e.target as HTMLSelectElement).value as VelocityClass;
                      api.setS((x) => {
                        const o = { ...x.velocityOverrides };
                        if (v === r.computedClass) delete o[`${plan.location}|${r.sku}`];
                        else o[`${plan.location}|${r.sku}`] = v;
                        return { ...x, velocityOverrides: o };
                      });
                    }}>
                    {CLASSES.map((k) => <option value={k}>{CLASS_LABEL[k]}{k === r.computedClass ? " (calculated)" : ""}</option>)}
                  </select>
                ),
              },
              { key: "lastCounted", label: "Last counted", render: (r) => (r.lastCounted ? shortDate(r.lastCounted) : <span class="muted">Never</span>) },
              { key: "onHand", label: "On hand", unit: "units" },
            ]}
          />
        </Card>
      </div>

      {day && (
        <Drawer
          title={<><h2>{dowName(day)} {longDate(day)}</h2><div class="small muted">{plan.location} · {(plan.byDay.get(day) ?? []).length} SKUs in walk order</div></>}
          actions={<>
            <button class="btn" onClick={() => exportDay(day)}><IconDownload /> CSV</button>
            <button class="btn primary" onClick={() => print([day])}><IconPrint /> Print sheet</button>
          </>}
          onClose={() => setDay(null)}
        >
          <DataTable<ScheduledCount & Record<string, any>>
            rows={(plan.byDay.get(day) ?? []) as any}
            pageSize={100}
            cols={[
              { key: "sku", label: "SKU" },
              { key: "product", label: "Product" },
              { key: "cls", label: "Class", render: (r) => <span class="nowrap"><ClassDot cls={r.cls} /> {CLASS_LABEL[r.cls]}</span> },
              { key: "subs", label: "Bins", render: (r) => r.sublocations.join(", ") || <span class="muted">No bin</span> },
              { key: "due", label: "Due", render: (r) => <span class="nowrap">{shortDate(r.due)}{r.atRisk && <span class="badge warn" style={{ marginLeft: 6 }}>outside window</span>}</span> },
              { key: "lastCounted", label: "Last counted", render: (r) => (r.lastCounted ? shortDate(r.lastCounted) : <span class="muted">Never</span>) },
            ]}
          />
        </Drawer>
      )}
    </>
  );
}

/** Printable blind count sheets: no system quantity, blank column for the count. */
function PrintSheets(props: { plan: LocationPlan; days: string[] }) {
  return (
    <div class="print-only">
      {props.days.map((d) => {
        const list = props.plan.byDay.get(d) ?? [];
        return (
          <div class="sheet">
            <h1>Cycle count · {props.plan.location}</h1>
            <div class="meta"><span>{dowName(d)} {longDate(d)} · week of {weekLabel(addDays(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7)))}</span><span>{list.length} SKUs · count every bin listed</span></div>
            <div class="meta"><span>Counted by: ____________________</span><span>Entered in inFlow stock count #: ____________</span></div>
            <table>
              <thead><tr><th>#</th><th>SKU</th><th>Product</th><th>Bins</th><th>Counted qty</th><th>Notes</th></tr></thead>
              <tbody>
                {list.map((x, i) => (
                  <tr><td>{i + 1}</td><td>{x.sku}</td><td>{x.product}</td><td>{x.sublocations.join(", ")}</td><td class="blank" /><td class="blank" /></tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
