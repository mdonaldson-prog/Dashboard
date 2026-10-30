import type { Api } from "../App";
import { shortDate } from "../calc/dates";
import type { Receipt, Schedule } from "../calc/plan";
import { LANE_LABEL } from "../data/settings";
import { fmt } from "./format";

export function PoBadge(props: { onOrder: number }) {
  return props.onOrder > 0 ? <span class="badge info">PO on order · {fmt(props.onOrder)}</span> : <span class="badge bad">No PO</span>;
}

/** When a PO line's material can be used, relative to this schedule. */
export function arrival(r: Receipt, days: string[]): { text: string; cls: string } {
  if (r.day == null) return r.due ? { text: `Past due (ships ${shortDate(r.due)}), not counted`, cls: "bad" } : { text: "No ship date, not counted", cls: "bad" };
  if (r.day >= days.length) return { text: `Usable ${shortDate(r.usable)}, after this schedule`, cls: "warn" };
  if (r.pastDue) return { text: `Past due (shipped ${shortDate(r.due)}), counted from ${shortDate(days[0])}`, cls: "warn" };
  return { text: `Usable ${shortDate(r.usable < days[0] ? days[0] : r.usable)}`, cls: "info" };
}

function Incoming(props: { sched: Schedule; list: Receipt[]; onOrder: number }) {
  if (!props.sched.usesPoFile) return <PoBadge onOrder={props.onOrder} />;
  if (!props.list.length) return <span class="badge bad">No PO</span>;
  return (
    <div class="stack" style={{ gap: 4 }}>
      {props.list.map((r) => { const a = arrival(r, props.sched.days); return <div><span class={`badge ${a.cls}`}>{r.po} · {fmt(r.qty)}</span> <span class="small">{a.text}</span></div>; })}
    </div>
  );
}

export function ReceiptsTable(props: { sched: Schedule; onlyUsed?: boolean }) {
  const rows = props.sched.receipts.filter((r) => !props.onlyUsed || r.used > 0);
  return (
    <table class="data">
      <thead><tr><th>PO</th><th>Vendor</th><th>Raw material</th><th>Ships</th><th>When usable</th><th class="num">Remaining</th><th class="num">Used by this schedule</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const a = arrival(r, props.sched.days);
          return (
            <tr>
              <td><b>{r.po}</b></td>
              <td class="small">{r.vendor}</td>
              <td><b>{r.sku}</b><div class="small muted">{r.name}</div></td>
              <td class="nowrap">{r.due ? shortDate(r.due) : "—"}</td>
              <td><span class={`badge ${a.cls}`}>{a.text}</span></td>
              <td class="num">{fmt(r.qty)}</td>
              <td class="num"><b>{fmt(r.used)}</b>{r.toBackorders > 0 ? <div class="small muted">+{fmt(r.toBackorders)} to reserved orders</div> : null}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function MaterialsTable(props: { sched: Schedule }) {
  return (
    <table class="data">
      <thead><tr><th>Raw material</th><th class="num">Needed</th><th class="num">Available</th><th class="num">Short</th><th>Open POs</th><th>Holding up</th></tr></thead>
      <tbody>
        {props.sched.materials.map((m) => (
          <tr>
            <td><b>{m.sku}</b><div class="small muted">{m.name}</div></td>
            <td class="num">{fmt(m.needed)}</td>
            <td class="num">{fmt(m.available)}</td>
            <td class="num"><b>{fmt(m.short)}</b></td>
            <td><Incoming sched={props.sched} list={m.incoming} onOrder={m.onOrder} /></td>
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
      {s.countOnOrder && <div class="notice warn">What-if is on: raw materials on open POs are counted as on hand from day one, whatever their ship date (Data &amp; settings).</div>}
      {!sched.usesPoFile && <div class="notice">Load the <b>Purchase order status</b> report to schedule around raw material ship dates. Until then, material on order isn't counted.</div>}
      <div class="card">
        <div class="card-head">
          <h2>Raw materials short</h2>
          <span class="card-sub">What it would take to schedule everything below, after counting PO material that arrives in time. Raw materials go to the highest-priority items first.</span>
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
      {sched.usesPoFile && (
        <div class="card">
          <div class="card-head">
            <h2>POs this schedule counts on</h2>
            <span class="card-sub">MOs that use this material are placed on or after the day it can be used ({props.api.s.receiptLagDays} workday{props.api.s.receiptLagDays === 1 ? "" : "s"} after the ship date). If one slips, the MOs that use it slip too.</span>
          </div>
          <div class="card-body table-wrap">{sched.receipts.some((r) => r.used > 0) ? <ReceiptsTable sched={sched} onlyUsed /> : <div class="muted">The schedule only uses material already on hand.</div>}</div>
        </div>
      )}
      {!!sched.unplaced.length && (
        <div class="card">
          <div class="card-head"><h2>Didn't fit in these two weeks</h2><span class="card-sub">Materials are fine; there's no room left in the lane, or a component can't be made in time.</span></div>
          <div class="card-body table-wrap"><UnplacedTable sched={sched} /></div>
        </div>
      )}
    </>
  );
}
