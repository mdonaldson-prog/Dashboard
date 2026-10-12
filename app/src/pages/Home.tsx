import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { AppApi } from "../App";
import { addDays, longDate, periodAt, periodLabel, PERIOD_NOUN, shortDate } from "../calc/dates";
import { contextWindow, coverageOf, coveredWorkingDays, KPI_BY_ID, KPIS, periodValue, portalGap, series, type Grain, type KpiDef } from "../calc/kpis";
import { periodTarget, STATUS_LABEL, targetStatus } from "../calc/targets";
import { REPORTS, type ReportKind } from "../data/model";
import { ProductionChart } from "../ui/charts";
import { Card, Delta, Seg, Sparkline } from "../ui/components";
import { compact, full } from "../ui/format";
import { IconAlert, IconCheck, IconInfo, IconPrint } from "../ui/icons";
import { CalendarHeatmap, CountAdjustmentsChart, FreightFlowChart, InventoryBySite, Meter, OrderAging } from "../ui/overview";

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
  const gap = portalGap(api.c, def, api.loc);
  if (gap) {
    return (
      <button class="tile" onClick={() => api.go(`kpi/${def.id}`)} aria-label={`${def.name}: ${gap}`}>
        <div class="tile-label"><span>{def.name}</span></div>
        <div class="tile-value muted">—</div>
        <div class="tile-note">{gap}</div>
      </button>
    );
  }
  const cur = periodValue(api.c, def, facts, api.period);
  const value = cur.value;
  let prev: number | null = null;
  let spark: (number | null)[] = [];
  let note: string;
  if (def.pointInTime) {
    note = `As of ${shortDate(api.c.snapshotDate)}`;
  } else {
    prev = periodValue(api.c, def, facts, api.prior).value;
    const w = contextWindow(api.period, api.dataMin);
    const pts = series(api.c, def, facts, w.grain, w.from, w.to);
    spark = pts.map((p) => p.value);
    note = value == null ? `No data for this ${PERIOD_NOUN[api.period.kind]}` : cur.partial ? "Partial: reports don't cover all of it" : "";
  }
  const extras = def.extras && value != null ? def.extras(cur.facts) : [];
  const wd = coveredWorkingDays(api.c, def, api.period);
  const target = periodTarget(def, api.s.targets[def.id], wd);
  const status = targetStatus(def, value, target);
  return (
    <button class={`tile ${status ? `tile-${status}` : ""}`} onClick={() => api.go(`kpi/${def.id}`)} aria-label={`${def.name}: ${value == null ? "no data" : full(value, def.unit)}${status ? `, ${STATUS_LABEL[status]}` : ""}. Open details.`}>
      <div class="tile-label">
        <span>{def.name}</span>
        <span class="tile-info" title={def.description} aria-hidden="true"><IconInfo /></span>
      </div>
      <div class="tile-value">{value == null ? "—" : compact(value, def.unit)}</div>
      {target && (
        <>
          {value != null && <Meter value={value} target={target.value} status={status} />}
          <div class={`tile-target ${status ?? ""}`}>
            {status && <span class={`status-dot ${status}`}>{status === "good" ? <IconCheck /> : <IconAlert />}</span>}
            {status ? STATUS_LABEL[status] : "Target"} · target {compact(target.value, def.unit)}{def.agg === "sum" && (api.period.kind !== "week" || cur.partial) ? ` (${wd} work day${wd === 1 ? "" : "s"})` : ""}
          </div>
        </>
      )}
      {!def.pointInTime && <Delta cur={value} prev={prev} unit={def.unit} better={def.better} vs={`vs prior ${PERIOD_NOUN[api.period.kind]}`} />}
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
type Section = (typeof SECTIONS)[number];

const HEAT_METRICS = [
  { value: "units_shipped", label: "Units shipped" },
  { value: "units_sold", label: "Units sold" },
  { value: "total_sales", label: "Sales $" },
] as const;
type HeatMetric = (typeof HEAT_METRICS)[number]["value"];

/** Clicking a chart bucket makes it the selected period (a day, week or month). */
const pickBucket = (api: AppApi, grain: Grain, key?: string) => key && api.setPeriod(periodAt(grain, key));
const k = (id: string) => KPI_BY_ID.get(id)!;

/** The charts that sit under each section's tiles. All follow the period and location filters. */
function SectionVisuals(props: { api: AppApi; group: Section }) {
  const { api } = props;
  const [metric, setMetric] = useState<HeatMetric>("units_shipped");
  const w = contextWindow(api.period, api.dataMin);
  const has = (...ks: ReportKind[]) => ks.every((x) => api.c.ds.files.some((f) => f.kind === x));
  const wsub = `${periodLabel({ kind: "custom", from: w.from, to: w.to })} · by ${w.grain} · selected ${PERIOD_NOUN[api.period.kind]} highlighted`;
  const locNote = api.loc === "All" ? "all locations" : api.loc;

  if (props.group === "Inventory") {
    if (!has("stockLevels", "products")) return null;
    return (
      <div class="grid-2-even">
        <Card title="Inventory value by site" sub={`Active vs dormant (no movement in ${api.s.dormantDays} days)`}>
          <InventoryBySite value={api.facts(k("inventory_value"), true)} dormant={has("salesOrders", "mfgOrders") ? api.facts(k("dormant_inventory"), true) : []} loc={api.loc} onPick={(l) => l && api.setLoc(api.loc === l ? "All" : l)} />
        </Card>
        {has("stockCounts") && (
          <Card title="Count gains vs losses" sub={`${wsub} · ${locNote}`}>
            <CountAdjustmentsChart facts={api.facts(k("count_adjustments"))} grain={w.grain} from={w.from} to={w.to} period={api.period} onSelect={(key) => pickBucket(api, w.grain, key)} />
          </Card>
        )}
      </div>
    );
  }
  if (props.group === "Production") {
    if (!has("mfgOrders")) return null;
    return (
      <Card title="Production vs demand" sub={`Units · ${wsub} · production at ${api.s.mfgLocation}, demand all locations · click a bar to focus on it`}>
        <ProductionChart c={api.c} facts={(d) => api.facts(d, true)} from={w.from} to={w.to} grain={w.grain} highlight={api.period} onSelect={(key) => pickBucket(api, w.grain, key)} />
      </Card>
    );
  }
  if (props.group === "Sales & fulfillment") {
    if (!has("salesOrders")) return null;
    const def = k(metric);
    // Half a year of days, extended to cover a longer selected period
    const to = api.period.to > api.c.latest ? api.c.latest : api.period.to;
    let from = addDays(to, -7 * 26 + 1);
    if (api.period.from < from) from = api.period.from < addDays(to, -370) ? addDays(to, -370) : api.period.from;
    const covMin = coverageOf(api.c, def)?.min;
    if (covMin && covMin > from && covMin <= api.period.from) from = covMin;
    return (
      <div class="grid-2">
        <Card
          title="Daily activity"
          sub={`${periodLabel({ kind: "custom", from, to })} · ${def.locationAware ? locNote : "all locations"}`}
          actions={<Seg label="Metric" value={metric} onChange={setMetric} options={HEAT_METRICS.map((m) => ({ value: m.value, label: m.label }))} />}
        >
          <CalendarHeatmap
            facts={api.facts(def)}
            unit={def.unit === "usd" ? "usd" : "units"}
            from={from}
            to={to}
            latest={api.c.latest}
            dataFrom={coverageOf(api.c, def)?.min}
            period={api.period}
            label={`${def.name} by day`}
            onPick={(d) => api.setPeriod(periodAt("day", d))}
          />
        </Card>
        {has("shipped") && (
          <Card title="Open orders by age" sub={`${locNote} · as of ${shortDate(api.c.latest)}`}>
            <OrderAging facts={api.facts(k("late_orders"))} lateDays={api.s.lateOrderDays} onOpen={() => api.go("kpi/late_orders")} />
          </Card>
        )}
      </div>
    );
  }
  if (props.group === "Freight") {
    if (!has("shipments")) return null;
    return (
      <Card title="Freight spend by flow" sub={`${wsub} · ${locNote}`}>
        <FreightFlowChart c={api.c} facts={api.facts(k("total_freight"))} period={api.period} grain={w.grain} from={w.from} to={w.to} onSelect={(key) => pickBucket(api, w.grain, key)} go={api.go} />
      </Card>
    );
  }
  return null;
}

export function Home(props: { api: AppApi }) {
  const { api } = props;
  const items = attention(api);
  const [showAll, setShowAll] = useState(false);
  return (
    <>
      <div class="print-only print-header">
        <h1>Operations summary · {periodLabel(api.period)}</h1>
        <div class="meta">
          <span>{api.loc === "All" ? "All locations" : api.loc} · data through {longDate(api.c.latest)}</span>
          <span>Printed {longDate(new Date().toISOString().slice(0, 10))}</span>
        </div>
      </div>
      <div class="row no-print">
        <span class="small muted">Click any tile for trends, breakdowns and records. Click chart bars or calendar days to change the period, and sites to filter by location.</span>
        <div class="spacer" />
        <button class="btn" onClick={() => window.print()}><IconPrint /> Print summary</button>
      </div>
      {items.length > 0 && (
        <Card
          title="Needs attention"
          sub={`${items.length} item${items.length > 1 ? "s" : ""}`}
          actions={items.length > 3 && <button class="btn small no-print" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${items.length}`}</button>}
        >
          <div class="attn attn-grid">
            {items.map((a, i) => (
              <div class={`attn-item ${a.level} ${i >= 3 && !showAll ? "attn-more" : ""}`}>
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
      )}
      {SECTIONS.map((g) => {
        const tiles = KPIS.filter((d) => d.tile && d.group === g);
        return tiles.length ? (
          <section class="tile-section">
            <h2 class="section-title">{g}</h2>
            <div class="tiles">{tiles.map((d) => <Tile api={api} def={d} />)}</div>
            <SectionVisuals api={api} group={g} />
          </section>
        ) : null;
      })}
    </>
  );
}
