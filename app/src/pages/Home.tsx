import type { ComponentChildren } from "preact";
import type { AppApi } from "../App";
import { addDays, longDate, shortDate, weekLabel } from "../calc/dates";
import { factsIn, KPIS, series, type KpiDef } from "../calc/kpis";
import { REPORTS, type ReportKind } from "../data/model";
import { ProductionChart } from "../ui/charts";
import { Card, Delta, Sparkline } from "../ui/components";
import { compact, full } from "../ui/format";
import { IconAlert, IconInfo } from "../ui/icons";

function Tile(props: { api: AppApi; def: KpiDef }) {
  const { api, def } = props;
  const facts = api.facts(def);
  const nonLoc = api.loc !== "All" && !def.locationAware;
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
  return (
    <button class="tile" onClick={() => api.go(`kpi/${def.id}`)} aria-label={`${def.name}: ${value == null ? "no data" : full(value, def.unit)}. Open details.`}>
      <div class="tile-label">{def.name}</div>
      <div class="tile-value">{value == null ? "—" : compact(value, def.unit)}</div>
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
  const inTransit = c.transfers.filter((t) => t.sent && !t.received);
  if (inTransit.length) {
    out.push({ level: "info", title: `${inTransit.length} transfer${inTransit.length > 1 ? "s" : ""} in transit`, text: inTransit.slice(0, 3).map((t) => `${t.transfer} (${t.lane}, ${compact(t.value, "usd")})`).join(" · "), to: "kpi/stock_transfers" });
  }
  const neg = c.ds.stockLevels.filter((x) => x.qty < 0).length;
  if (neg) out.push({ level: "warn", title: `${neg} stock rows are negative`, text: "Good candidates for a count. Excluded from inventory value.", to: "data" });
  const zero = c.ds.stockLevels.filter((x) => x.qty > 0 && !(c.product(x.sku, x.product)?.cost)).length;
  if (zero) out.push({ level: "warn", title: `${zero} stocked items have $0 cost`, text: "Inventory value is understated until costs are filled in inFlow.", to: "data" });
  if (c.unclassifiedCarriers.length) out.push({ level: "warn", title: `${c.unclassifiedCarriers.length} new carrier value${c.unclassifiedCarriers.length > 1 ? "s" : ""}`, text: `Classify as ground or freight: ${c.unclassifiedCarriers.slice(0, 4).join(", ")}`, to: "data" });
  const otherMo = c.ds.mfgOrders.filter((m) => m.type === "other").length;
  if (otherMo) out.push({ level: "info", title: `${otherMo} manufacturing orders unclassified`, text: "No Blend/Fill/Kit prefix, so they're not in any production KPI.", to: "data" });
  const ownNoMatch = c.shipments.filter((s) => s.ownSites && !s.transfer).length;
  if (ownNoMatch) out.push({ level: "info", title: `${ownNoMatch} portal shipments between your sites`, text: "No matching stock transfer, so they're counted as outbound freight.", to: "kpi/total_freight" });
  return out;
}

export function Home(props: { api: AppApi }) {
  const { api } = props;
  const tiles = KPIS.filter((k) => k.tile);
  const items = attention(api);
  return (
    <>
      <div class="tiles">{tiles.map((d) => <Tile api={api} def={d} />)}</div>
      <div class="grid-2">
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
                  {a.to && <a class="small" href={`#/${a.to}`}>Review →</a>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
