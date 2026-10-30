import type { Api } from "../App";
import type { Schedule } from "../calc/plan";
import { LANE_LABEL } from "../data/settings";
import { fmt } from "./format";

export function PoBadge(props: { onOrder: number }) {
  return props.onOrder > 0 ? <span class="badge info">PO on order · {fmt(props.onOrder)}</span> : <span class="badge bad">No PO</span>;
}

export function MaterialsTable(props: { sched: Schedule }) {
  return (
    <table class="data">
      <thead><tr><th>Raw material</th><th class="num">Needed</th><th class="num">Available</th><th class="num">Short</th><th>Purchase order</th><th>Holding up</th></tr></thead>
      <tbody>
        {props.sched.materials.map((m) => (
          <tr>
            <td><b>{m.sku}</b><div class="small muted">{m.name}</div></td>
            <td class="num">{fmt(m.needed)}</td>
            <td class="num">{fmt(m.available)}</td>
            <td class="num"><b>{fmt(m.short)}</b></td>
            <td><PoBadge onOrder={m.onOrder} /></td>
            <td class="small">{m.items.join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BlockedTable(props: { sched: Schedule }) {
  return (
    <table class="data">
      <thead><tr><th>Item</th><th>Type</th><th class="num">Qty not scheduled</th><th>Missing</th></tr></thead>
      <tbody>
        {props.sched.shortages.map((x) => (
          <tr>
            <td><b>{x.sku}</b><div class="small muted">{x.product}</div></td>
            <td>{LANE_LABEL[x.type]}</td>
            <td class="num">{fmt(x.qtyBlocked)}</td>
            <td class="small">
              {x.missing.map((m) => (
                <div>
                  {m.component ? "Waiting on " : ""}<b>{m.sku}</b> {m.name !== m.sku ? <span class="muted">{m.name}</span> : null}: needs {fmt(m.need)}, has {fmt(Math.max(0, m.have))}
                  {m.component ? <span class="muted"> (itself short on materials)</span> : null}
                </div>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UnplacedTable(props: { sched: Schedule }) {
  return (
    <table class="data">
      <thead><tr><th>Item</th><th>Type</th><th class="num">Quantity</th><th>Reason</th></tr></thead>
      <tbody>
        {props.sched.unplaced.map((u) => (
          <tr><td><b>{u.sku}</b><div class="small muted">{u.product}</div></td><td>{LANE_LABEL[u.type]}</td><td class="num">{fmt(u.qty)}</td><td class="small">{u.reason}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export function Shortages(props: { api: Api }) {
  const { sched, s } = props.api;
  return (
    <>
      {s.countOnOrder && <div class="notice warn">What-if is on: raw materials on open POs are counted as on hand (Data &amp; settings).</div>}
      <div class="card">
        <div class="card-head">
          <h2>Raw materials short</h2>
          <span class="card-sub">What it would take to schedule everything below. Raw materials go to the highest-priority items first.</span>
        </div>
        <div class="card-body table-wrap">{sched.materials.length ? <MaterialsTable sched={sched} /> : <div class="muted">No raw material shortages.</div>}</div>
      </div>
      <div class="card">
        <div class="card-head">
          <h2>Needs scheduling, but materials are missing</h2>
          <span class="card-sub">{sched.shortages.length} items, most urgent first. "Waiting on" means a fill or blend it needs is itself short.</span>
        </div>
        <div class="card-body table-wrap">{sched.shortages.length ? <BlockedTable sched={sched} /> : <div class="muted">Nothing is held up by materials.</div>}</div>
      </div>
      {!!sched.unplaced.length && (
        <div class="card">
          <div class="card-head"><h2>Didn't fit in these two weeks</h2><span class="card-sub">Materials are fine; there's no room left in the lane, or a component can't be made in time.</span></div>
          <div class="card-body table-wrap"><UnplacedTable sched={sched} /></div>
        </div>
      )}
    </>
  );
}
