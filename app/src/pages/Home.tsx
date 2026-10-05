import type { ComponentChildren } from "preact";
import type { AppApi } from "../App";
import { addDays, longDate, shortDate, weekLabel } from "../calc/dates";
import { factsIn, KPIS, series, type KpiDef } from "../calc/kpis";
import { STATUS_LABEL, targetStatus } from "../calc/targets";
import { REPORTS, type ReportKind } from "../data/model";
import { ProductionChart } from "../ui/charts";
import { Card, Delta, Sparkline } from "../ui/components";
import { compact, full } from "../ui/format";
import { IconAlert, IconCheck, IconInfo, IconPrint } from "../ui/icons";

function Tile(props: { api: AppApi; def: KpiDef }) {
  const { api, def } = props;
  const facts = api.facts(def);
  const nonLoc = api.loc !== "All" && !def.locationAware;
  const missing = def.sources.filter((k) => !api.c.ds.files.some((f) => f.kind === k));
  if (missing.length) {
    return (
      <button class="tile" onClick={() => api.go("data")} aria-label={`${def.name}: needs ${missing.map((k) => REPORTS[k].label).join(", ")}`}>
        <div class="tile-label">{def.name}</div>
        <div class="tile-value muted">—</div>
        <div class="tile-note">Needs {missing.map((k) => REPORTS[k].label).join(" + ")}</div>
      </button>
    );
  }
  let value: number | null;
  let prev: number | null = null;
  let spark: (number | null)[] = [];
  let periodFacts = facts;
  let note: string;
  if (def.pointInTime) {
    value = facts.reduce((a, f) => a + f.num, 0);
    note = `As of ${shortDate(api.c.snapshotDate)}`;
  } else {
    const pts = series(api.c, def, facts, "week", addDays(api.week, -7 * 12), addDays(api.week, 6));
    value = pts[pts.length - 1]?.value ?? null;
    prev = pts[pts.length - 2]?.value ?? null;
    spark = pts.map((p) => p.value);
    periodFacts = factsIn(facts, api.week, addDays(api.week, 6));
    const partial = pts[pts.length - 1]?.partial;
    note = value == null ? "No data for this week" : partial ? "Partial week" : "";
  }
  const extras = def.extras && value != null ? def.extras(periodFacts) : [];
  const target = api.s.targets[def.id];
  const status = targetStatus(def, value, target);
  return (
    <button class={`tile ${status ? `tile-${status}` : ""}`} onClick={() => api.go(`kpi/${def.id}`)} aria-label={`${def.name}: ${value == null ? "no data" : full(value, def.unit)}${status ? `, ${STATUS_LABEL[status]}` : ""}. Open details.`}>
      <div class="tile-label">
        <span>{def.name}</span>
        <span class="tile-info" title={def.description} aria-hidden="true"><IconInfo /></span>
      </div>
      <div class="tile-value">{value == null ? "—" : compact(value, def.unit)}</div>
      {target && (
        <div class={`tile-target ${status ?? ""}`}>
          {status && <span class={`status-dot ${status}`}>{status === "good" ? <IconCheck /> : <IconAlert />}</span>}
          {status ? STATUS_LABEL[status] : "Target"} · target {compact(target.value, def.unit)}
        </div>
      )}
      {!def.pointInTime && <Delta cur={value} prev={prev} unit={def.unit} better={def.better} vs="vs prior wk" />}
      {extras.length > 0 && (
        <div class="tile-extras">
          {extras.slice(0, 3).map((e) => <span>{e.label} <b>{compact(e.value, e.unit)}</b></span>)}
        </div>
      )}
      <div class="tile-foot">
        <span class="tile-note">{nonLoc ? "All locations" : note}</span>
        {!def.pointInTime && <Sparkline values={spark} />}
      </div>
    </button>
  );
}

interface Attn { level: "bad" | "warn" | "info"; title: string; text: ComponentChildren; to?: string }

function attention(api: AppApi): Attn[] {
  const { c } = api;
  const out: Attn[] = [];
  const weekly = (Object.keys(REPORTS) as ReportKind[]).filter((k) => REPORTS[k].weekly);
  const loaded = new Set(c.ds.files.map((f) => f.kind));
  const missing = weekly.filter((k) => !loaded.has(k));
  if (missing.length) out.push({ level: "bad", title: `${missing.length} weekly report${missing.length > 1 ? "s" : ""} missing`, text: missing.map((k) => REPORTS[k].label).join(", "), to: "data" });
  for (const f of c.ds.files) {
    if (f.kind && REPORTS[f.kind].dated && f.maxDate && f.maxDate < addDays(c.latest, -8)) {
      out.push({ level: "warn", title: `${REPORTS[f.kind].label} looks stale`, text: `Newest date is ${longDate(f.maxDate)}, but other reports run to ${longDate(c.latest)}.`, to: "data" });
    }
  }
  for (const p of api.plans.filter((p) => p.active)) {
    if (p.requiredPerDay > p.capacity) {
      out.push({ level: "bad", title: `${p.location}: count load over capacity`, text: `${p.requiredPerDay.toFixed(0)} SKUs/day needed vs ${p.capacity} available. ${p.atRisk.toLocaleString()} counts in the next ${api.s.counts.horizonWeeks} weeks are at risk.`, to: "counts" });
    }
    const f = p.withinCadence.fast;
    if (f.total && f.ok < f.total) out.push({ level: "warn", title: `${p.location}: ${f.total - f.ok} fast movers overdue`, text: `Not counted within the last week (${f.ok} of ${f.total} are current).`, to: "counts" });
  }
  const late = KPIS.find((k) => k.id === "late_orders")!;
  if (c.coverage.salesOrders && c.coverage.shipped) {
    const open = api.facts(late, true);
    const lateOnes = open.filter((f) => f.num);
    if (lateOnes.length) {
      const oldest = Math.max(...lateOnes.map((f) => Number(f.ref.age)));
      out.push({ level: "bad", title: `${lateOnes.length} late order${lateOnes.length > 1 ? "s" : ""}`, text: `Open more than ${api.s.lateOrderDays} business days. Oldest: ${oldest} business days. ${compact(lateOnes.reduce((a, f) => a + Number(f.ref.value), 0), "usd")} waiting to ship.`, to: "kpi/late_orders" });
    }
  }
  const neg = c.ds.stockLevels.filter((x) => x.qty < 0).length;
  if (neg) out.push({ level: "warn", title: `${neg} stock rows are negative`, text: "Good candidates for a count. Excluded from inventory value.", to: "data" });
  const zero = c.ds.stockLevels.filter((x) => x.qty > 0 && !(c.product(x.sku, x.product)?.cost)).length;
  if (zero) out.push({ level: "warn", title: `${zero} stocked items have $0 cost`, text: "Inventory value is understated until costs are filled in inFlow.", to: "data" });
  if (c.unclassifiedCarriers.length) out.push({ level: "warn", title: `${c.unclassifiedCarriers.length} new carrier value${c.unclassifiedCarriers.length > 1 ? "s" : ""}`, text: `Classify as ground or freight: ${c.unclassifiedCarriers.slice(0, 4).join(", ")}`, to: "data" });
  const otherMo = c.ds.mfgOrders.filter((m) => m.type === "other").length;
  if (otherMo) out.push({ level: "info", title: `${otherMo} manufacturing orders unclassified`, text: "No Blend/Fill/Kit prefix, so they're not in any production KPI.", to: "data" });
  return out;
}

const SECTIONS = ["Inventory", "Production", "Sales & fulfillment", "Freight"] as const;

export function Home(props: { api: AppApi }) {
  const { api } = props;
  const items = attention(api);
  return (
    <>
      <div class="print-only print-header">
        <h1>Operations summary · week of {weekLabel(api.week)}</h1>
        <div class="meta">
          <span>{api.loc === "All" ? "All locations" : api.loc} · data through {longDate(api.c.latest)}</span>
          <span>Printed {longDate(new Date().toISOString().slice(0, 10))}</span>
        </div>
      </div>
      <div class="row no-print">
        <span class="small muted">Click any tile for trends, breakdowns and the records behind it. Hover the ⓘ for its definition.</span>
        <div class="spacer" />
        <button class="btn" onClick={() => window.print()}><IconPrint /> Print summary</button>
      </div>
      {SECTIONS.map((g) => {
        const tiles = KPIS.filter((k) => k.tile && k.group === g);
        return tiles.length ? (
          <section class="tile-section">
            <h2 class="section-title">{g}</h2>
            <div class="tiles">{tiles.map((d) => <Tile api={api} def={d} />)}</div>
          </section>
        ) : null;
      })}
      <div class="grid-2 summary-bottom">
        <Card title="Production vs demand" sub={`Units by week, 13 weeks to ${weekLabel(api.week)} · all locations`}>
          <ProductionChart c={api.c} facts={(d) => api.facts(d, true)} from={addDays(api.week, -7 * 12)} to={addDays(api.week, 6)} grain="week" onSelect={(k) => { api.setWeek(k); }} />
        </Card>
        <Card title="Attention" sub={items.length ? `${items.length} item${items.length > 1 ? "s" : ""}` : "Nothing needs attention"}>
          <div class="attn">
            {items.map((a) => (
              <div class="attn-item">
                <span class={`attn-icon ${a.level}`}>{a.level === "info" ? <IconInfo /> : <IconAlert />}</span>
                <div style={{ minWidth: 0 }}>
                  <div class="attn-title">{a.title}</div>
                  <div class="attn-text">{a.text}</div>
                  {a.to && <a class="small no-print" href={`#/${a.to}`}>Review →</a>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
