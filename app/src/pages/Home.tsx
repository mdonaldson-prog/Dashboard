import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AppApi } from "../App";
import { addDays, longDate, periodAt, periodLabel, PERIOD_NOUN, shortDate } from "../calc/dates";
import { contextWindow, coverageOf, coveredWorkingDays, KPI_BY_ID, KPIS, periodValue, portalGap, series, type Grain, type KpiDef } from "../calc/kpis";
import { periodTarget, STATUS_LABEL, targetStatus } from "../calc/targets";
import { REPORTS, type ReportKind } from "../data/model";
import type { OverviewLayout } from "../data/settings";
import { ProductionChart } from "../ui/charts";
import { Card, Delta, Seg, Sparkline } from "../ui/components";
import { compact, full } from "../ui/format";
import { IconAlert, IconCheck, IconInfo, IconPrint } from "../ui/icons";
import { CalendarHeatmap, CountAdjustmentsChart, FreightFlowChart, InventoryBySite, Meter, OrderAging } from "../ui/overview";

function Tile(props: { api: AppApi; def: KpiDef; span?: number }) {
  const { api, def } = props;
  const span = props.span ?? 1;
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
    <button class={`tile ${status ? `tile-${status}` : ""} ${span > 1 ? "tile-wide" : ""}`} onClick={() => api.go(`kpi/${def.id}`)} aria-label={`${def.name}: ${value == null ? "no data" : full(value, def.unit)}${status ? `, ${STATUS_LABEL[status]}` : ""}. Open details.`}>
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
          {extras.slice(0, span > 1 ? 6 : 3).map((e) => <span>{e.label} <b>{compact(e.value, e.unit)}</b></span>)}
        </div>
      )}
      <div class="tile-foot">
        <span class="tile-note">{nonLoc ? "All locations" : note}</span>
        {!def.pointInTime && <Sparkline values={spark} w={span > 2 ? 300 : span > 1 ? 200 : 96} h={span > 1 ? 44 : 30} />}
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

const HEAT_METRICS = [
  { value: "units_shipped", label: "Units shipped" },
  { value: "units_sold", label: "Units sold" },
  { value: "total_sales", label: "Sales $" },
] as const;
type HeatMetric = (typeof HEAT_METRICS)[number]["value"];

/** Clicking a chart bucket makes it the selected period (a day, week or month). */
const pickBucket = (api: AppApi, grain: Grain, key?: string) => key && api.setPeriod(periodAt(grain, key));
const k = (id: string) => KPI_BY_ID.get(id)!;
const hasReports = (api: AppApi, ...ks: ReportKind[]) => ks.every((x) => api.c.ds.files.some((f) => f.kind === x));
const windowSub = (api: AppApi) => {
  const w = contextWindow(api.period, api.dataMin);
  return `${periodLabel({ kind: "custom", from: w.from, to: w.to })} · by ${w.grain} · selected ${PERIOD_NOUN[api.period.kind]} highlighted`;
};
const locNote = (api: AppApi) => (api.loc === "All" ? "all locations" : api.loc);

// ---------- Charts (each one a block on the Overview) ----------

function InventorySiteCard(props: { api: AppApi }) {
  const { api } = props;
  return (
    <Card title="Inventory value by site" sub={`Active vs dormant (no movement in ${api.s.dormantDays} days)`}>
      <InventoryBySite value={api.facts(k("inventory_value"), true)} dormant={hasReports(api, "salesOrders", "mfgOrders") ? api.facts(k("dormant_inventory"), true) : []} loc={api.loc} onPick={(l) => l && api.setLoc(api.loc === l ? "All" : l)} />
    </Card>
  );
}

function CountAdjCard(props: { api: AppApi }) {
  const { api } = props;
  const w = contextWindow(api.period, api.dataMin);
  return (
    <Card title="Count gains vs losses" sub={`${windowSub(api)} · ${locNote(api)}`}>
      <CountAdjustmentsChart facts={api.facts(k("count_adjustments"))} grain={w.grain} from={w.from} to={w.to} period={api.period} onSelect={(key) => pickBucket(api, w.grain, key)} />
    </Card>
  );
}

function ProductionCard(props: { api: AppApi }) {
  const { api } = props;
  const w = contextWindow(api.period, api.dataMin);
  return (
    <Card title="Production vs demand" sub={`Units · ${windowSub(api)} · production at ${api.s.mfgLocation}, demand all locations · click a bar to focus on it`}>
      <ProductionChart c={api.c} facts={(d) => api.facts(d, true)} from={w.from} to={w.to} grain={w.grain} highlight={api.period} onSelect={(key) => pickBucket(api, w.grain, key)} />
    </Card>
  );
}

function HeatmapCard(props: { api: AppApi }) {
  const { api } = props;
  const [metric, setMetric] = useState<HeatMetric>("units_shipped");
  const def = k(metric);
  // Half a year of days, extended to cover a longer selected period
  const to = api.period.to > api.c.latest ? api.c.latest : api.period.to;
  let from = addDays(to, -7 * 26 + 1);
  if (api.period.from < from) from = api.period.from < addDays(to, -370) ? addDays(to, -370) : api.period.from;
  const covMin = coverageOf(api.c, def)?.min;
  if (covMin && covMin > from && covMin <= api.period.from) from = covMin;
  return (
    <Card
      title="Daily activity"
      sub={`${periodLabel({ kind: "custom", from, to })} · ${def.locationAware ? locNote(api) : "all locations"}`}
      actions={<Seg label="Metric" value={metric} onChange={setMetric} options={HEAT_METRICS.map((m) => ({ value: m.value, label: m.label }))} />}
    >
      <CalendarHeatmap
        facts={api.facts(def)}
        unit={def.unit === "usd" ? "usd" : "units"}
        from={from}
        to={to}
        latest={api.c.latest}
        dataFrom={covMin}
        period={api.period}
        label={`${def.name} by day`}
        onPick={(d) => api.setPeriod(periodAt("day", d))}
      />
    </Card>
  );
}

function AgingCard(props: { api: AppApi }) {
  const { api } = props;
  return (
    <Card title="Open orders by age" sub={`${locNote(api)} · as of ${shortDate(api.c.latest)}`}>
      <OrderAging facts={api.facts(k("late_orders"))} lateDays={api.s.lateOrderDays} onOpen={() => api.go("kpi/late_orders")} />
    </Card>
  );
}

function FreightFlowCard(props: { api: AppApi }) {
  const { api } = props;
  const w = contextWindow(api.period, api.dataMin);
  return (
    <Card title="Freight spend by flow" sub={`${windowSub(api)} · ${locNote(api)}`}>
      <FreightFlowChart c={api.c} facts={api.facts(k("total_freight"))} period={api.period} grain={w.grain} from={w.from} to={w.to} onSelect={(key) => pickBucket(api, w.grain, key)} go={api.go} />
    </Card>
  );
}

// ---------- Overview blocks and layout ----------

interface Block {
  id: string;
  kind: "kpi" | "chart" | "head";
  label: string;
  span: number; // default width in grid columns (headings always take the full row)
  section: (typeof SECTIONS)[number];
  available: (api: AppApi) => boolean;
  render: (api: AppApi, span: number) => ComponentChildren;
}

const CHARTS: Record<(typeof SECTIONS)[number], Omit<Block, "kind" | "section">[]> = {
  Inventory: [
    { id: "chart:inventory_site", label: "Inventory value by site", span: 2, available: (a) => hasReports(a, "stockLevels", "products"), render: (a) => <InventorySiteCard api={a} /> },
    { id: "chart:count_adjustments", label: "Count gains vs losses", span: 2, available: (a) => hasReports(a, "stockCounts"), render: (a) => <CountAdjCard api={a} /> },
  ],
  Production: [
    { id: "chart:production", label: "Production vs demand", span: 4, available: (a) => hasReports(a, "mfgOrders"), render: (a) => <ProductionCard api={a} /> },
  ],
  "Sales & fulfillment": [
    { id: "chart:daily_activity", label: "Daily activity", span: 2, available: (a) => hasReports(a, "salesOrders"), render: (a) => <HeatmapCard api={a} /> },
    { id: "chart:order_aging", label: "Open orders by age", span: 2, available: (a) => hasReports(a, "salesOrders", "shipped"), render: (a) => <AgingCard api={a} /> },
  ],
  Freight: [
    { id: "chart:freight_flow", label: "Freight spend by flow", span: 4, available: (a) => hasReports(a, "shipments"), render: (a) => <FreightFlowCard api={a} /> },
  ],
};

/** Every block in the default order: each section's heading, its KPI tiles, then its charts. */
const BLOCKS: Block[] = SECTIONS.flatMap((g) => [
  { id: `head:${g}`, kind: "head" as const, label: `${g} heading`, span: 4, section: g, available: () => true, render: () => <h2 class="section-title">{g}</h2> },
  ...KPIS.filter((d) => d.tile && d.group === g).map((d) => ({
    id: `kpi:${d.id}`, kind: "kpi" as const, label: d.name, span: 1, section: g, available: () => true,
    render: (a: AppApi, span: number) => <Tile api={a} def={d} span={span} />,
  })),
  ...CHARTS[g].map((c) => ({ ...c, kind: "chart" as const, section: g })),
]);
const BLOCK_BY_ID = new Map(BLOCKS.map((b) => [b.id, b]));
const DEFAULT_ORDER = BLOCKS.map((b) => b.id);

/** The saved layout, with any blocks added since it was saved slotted in after their default neighbour.
 *  A tile arrangement from the earlier per-section version is converted the first time. */
function resolveLayout(s: AppApi["s"]): OverviewLayout {
  let saved = s.overviewLayout;
  if (!saved && s.tileLayout && Object.keys(s.tileLayout).length) {
    const tl = s.tileLayout;
    const order = SECTIONS.flatMap((g) => {
      const ids = BLOCKS.filter((b) => b.section === g);
      const tiles = ids.filter((b) => b.kind === "kpi").map((b, i) => ({ id: b.id, o: tl[b.id.slice(4)]?.order ?? i })).sort((a, b) => a.o - b.o).map((x) => x.id);
      return [`head:${g}`, ...tiles, ...ids.filter((b) => b.kind === "chart").map((b) => b.id)];
    });
    const spans: Record<string, number> = {};
    for (const [id, v] of Object.entries(tl)) if (v.span > 1) spans[`kpi:${id}`] = v.span;
    saved = { order, spans, hidden: [] };
  }
  if (!saved) return { order: [...DEFAULT_ORDER], spans: {}, hidden: [] };
  const order = saved.order.filter((id) => BLOCK_BY_ID.has(id));
  DEFAULT_ORDER.forEach((id, i) => {
    if (order.includes(id)) return;
    const prev = DEFAULT_ORDER.slice(0, i).reverse().find((x) => order.includes(x));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id);
  });
  return { order, spans: { ...saved.spans }, hidden: saved.hidden.filter((id) => BLOCK_BY_ID.has(id)) };
}

/** Number of columns the grid currently has (it reflows with the window). */
function useCols(ref: { current: HTMLElement | null }) {
  const [cols, setCols] = useState(4);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const n = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
      if (n && el.clientWidth) setCols(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return cols;
}

/** The whole Overview as one grid of blocks. In edit mode any block can be dragged anywhere (so sections
 *  can be reordered or mixed), resized by dragging its right edge, hidden, or moved and resized with buttons. */
function OverviewGrid(props: { api: AppApi; editing: boolean }) {
  const { api, editing } = props;
  const ref = useRef<HTMLDivElement>(null);
  const cols = useCols(ref);
  const layout = resolveLayout(api.s);
  const visible = layout.order.filter((id) => !layout.hidden.includes(id) && BLOCK_BY_ID.get(id)!.available(api));
  const spanOf = (id: string) => {
    const b = BLOCK_BY_ID.get(id)!;
    return b.kind === "head" ? cols : Math.max(1, Math.min(layout.spans[id] ?? b.span, 4, cols));
  };
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [live, setLive] = useState<{ id: string; span: number } | null>(null); // span while resizing
  const resizing = useRef(false); // a resize in progress must not start a block drag

  const save = (l: OverviewLayout) => api.setS((s) => ({ ...s, overviewLayout: l, tileLayout: undefined }));
  // A heading carries its section: itself and every block up to the next heading
  const isHead = (id: string) => id.startsWith("head:");
  const runOf = (order: string[], id: string) => {
    const i = order.indexOf(id);
    let j = i + 1;
    while (j < order.length && !isHead(order[j])) j++;
    return order.slice(i, j);
  };
  const place = (id: string, target: string | null, after: boolean) => {
    const moving = isHead(id) ? runOf(layout.order, id) : [id];
    if (target && moving.includes(target)) return;
    const o = layout.order.filter((x) => !moving.includes(x));
    if (target == null) o.push(...moving);
    else {
      let at = o.indexOf(target);
      // Dropping a section after another section's heading lands after that whole section
      if (after) at += isHead(id) && isHead(target) ? runOf(o, target).length : 1;
      o.splice(at, 0, ...moving);
    }
    save({ ...layout, order: o });
  };
  // Buttons move a block past its visible neighbour, or a section past the neighbouring section
  const heads = visible.filter(isHead);
  const neighbour = (id: string, by: number) => {
    const list = isHead(id) ? heads : visible;
    return list[list.indexOf(id) + by] ?? null;
  };
  const move = (id: string, by: number) => {
    const n = neighbour(id, by);
    if (n) place(id, n, by > 0);
  };
  const resize = (id: string, span: number) => save({ ...layout, spans: { ...layout.spans, [id]: Math.max(1, Math.min(4, span)) } });
  const hide = (id: string) => save({ ...layout, hidden: [...layout.hidden, id] });
  const show = (id: string) => save({ ...layout, hidden: layout.hidden.filter((x) => x !== id) });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (drag && (!drop || drop.id !== drag)) place(drag, drop?.id ?? null, drop?.after ?? true);
    setDrag(null);
    setDrop(null);
  };

  // Right-edge handle: each grid column crossed adds or removes one column of width
  const startResize = (e: PointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const slot = (e.currentTarget as HTMLElement).parentElement!;
    const grid = ref.current!;
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const colW = (grid.clientWidth - gap * (cols - 1)) / cols;
    const left = slot.getBoundingClientRect().left;
    let span = spanOf(id);
    resizing.current = true;
    const onMove = (ev: PointerEvent) => {
      span = Math.max(1, Math.min(cols, Math.round((ev.clientX - left + gap) / (colW + gap))));
      setLive({ id, span });
    };
    const onUp = () => {
      resizing.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setLive(null);
      resize(id, span);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const hidden = layout.hidden.filter((id) => BLOCK_BY_ID.get(id)!.available(api));
  return (
    <>
      {editing && hidden.length > 0 && (
        <div class="hidden-tray">
          <span class="small muted">Hidden:</span>
          {hidden.map((id) => (
            <button class="chip" onClick={() => show(id)} aria-label={`Show ${BLOCK_BY_ID.get(id)!.label}`}>+ {BLOCK_BY_ID.get(id)!.label}</button>
          ))}
        </div>
      )}
      <div
        class={`ov-grid ${editing ? "editing" : ""}`}
        ref={ref}
        onDragOver={(e) => { if (editing && drag) { e.preventDefault(); if (e.target === e.currentTarget && drop) setDrop(null); } }}
        onDrop={onDrop}
      >
        {visible.map((id, i) => {
          const b = BLOCK_BY_ID.get(id)!;
          const span = b.kind === "head" ? cols : Math.min(live?.id === id ? live.span : spanOf(id), cols);
          return (
            <div
              class={`ov-slot ov-${b.kind} ${drag === id ? "dragging" : ""} ${drop?.id === id ? (drop.after ? "drop-after" : "drop-before") : ""}`}
              style={{ gridColumn: b.kind === "head" ? "1 / -1" : `span ${span}` }}
              draggable={editing}
              onDragStart={(e) => {
                if (resizing.current) { e.preventDefault(); return; }
                setDrag(id);
                e.dataTransfer?.setData("text/plain", id);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => { setDrag(null); setDrop(null); }}
              onDragOver={(e) => {
                if (!editing || !drag) return;
                e.preventDefault();
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                // Headings span the row, so above/below; other blocks left/right
                const after = b.kind === "head" ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
                if (drop?.id !== id || drop.after !== after) setDrop({ id, after });
              }}
            >
              {b.render(api, span)}
              {editing && (
                <>
                  <div class="tile-tools" role="group" aria-label={`Arrange ${b.label}`}>
                    {b.kind === "head" ? (
                      <>
                        <button class="btn small icon" aria-label={`Move ${b.section} section up`} disabled={!neighbour(id, -1)} onClick={() => move(id, -1)}>↑</button>
                        <button class="btn small icon" aria-label={`Move ${b.section} section down`} disabled={!neighbour(id, 1)} onClick={() => move(id, 1)}>↓</button>
                      </>
                    ) : (
                      <>
                        <button class="btn small icon" aria-label={`Move ${b.label} earlier`} disabled={i === 0} onClick={() => move(id, -1)}>←</button>
                        <button class="btn small icon" aria-label={`Move ${b.label} later`} disabled={i === visible.length - 1} onClick={() => move(id, 1)}>→</button>
                      </>
                    )}
                    {b.kind !== "head" && (
                      <>
                        <span class="tile-size" aria-live="polite">{span}/{cols}</span>
                        <button class="btn small icon" aria-label={`Make ${b.label} narrower`} disabled={span <= 1} onClick={() => resize(id, span - 1)}>−</button>
                        <button class="btn small icon" aria-label={`Make ${b.label} wider`} disabled={span >= cols} onClick={() => resize(id, span + 1)}>+</button>
                      </>
                    )}
                    <button class="btn small icon" aria-label={`Hide ${b.label}`} title="Hide" onClick={() => hide(id)}>×</button>
                  </div>
                  {b.kind !== "head" && <div class="tile-resize" title="Drag to resize" aria-hidden="true" onPointerDown={(e) => startResize(e as unknown as PointerEvent, id)} />}
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** The headline KPIs on the printed summary, in this order. */
const PRINT_KPIS = ["inventory_accuracy", "units_blended", "units_filled", "units_kitted", "fulfillment_speed", "freight_net"];

export function Home(props: { api: AppApi }) {
  const { api } = props;
  const items = attention(api);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState(false);
  const customized = !!api.s.overviewLayout || !!(api.s.tileLayout && Object.keys(api.s.tileLayout).length);
  return (
    <>
      <div class="print-only print-header">
        <h1>Operations summary · {periodLabel(api.period)}</h1>
        <div class="meta">
          <span>{api.loc === "All" ? "All locations" : api.loc} · data through {longDate(api.c.latest)}</span>
          <span>Printed {longDate(new Date().toISOString().slice(0, 10))}</span>
        </div>
      </div>
      <div class="print-only">
        <div class="tiles print-tiles">{PRINT_KPIS.map((id) => <Tile api={api} def={k(id)} />)}</div>
      </div>
      <div class="row no-print">
        {editing ? (
          <span class="small secondary"><b>Customizing layout.</b> Drag a section heading to move the whole section. Drag tiles and charts anywhere, including into another section's row, or drag a right edge to resize. × hides a block. On touch screens, use the buttons. Changes save automatically.</span>
        ) : (
          <span class="small muted">Click any tile for trends, breakdowns and records. Click chart bars or calendar days to change the period, and sites to filter by location.</span>
        )}
        <div class="spacer" />
        {editing && customized && <button class="btn" onClick={() => api.setS((s) => ({ ...s, overviewLayout: null, tileLayout: undefined }))}>Reset layout</button>}
        <button class={`btn ${editing ? "primary" : ""}`} aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? "Done" : "Customize layout"}</button>
        {!editing && <button class="btn" onClick={() => window.print()} title={`Prints ${PRINT_KPIS.length} headline KPIs`}><IconPrint /> Print summary</button>}
      </div>
      {items.length > 0 && (
        <Card
          class="no-print"
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
      <div class="no-print">
        <OverviewGrid api={api} editing={editing} />
      </div>
    </>
  );
}
