import { useState } from "preact/hooks";
import type { Api } from "../App";
import { shortDate } from "../calc/dates";
import type { Flag } from "../calc/plan";
import { LANE_LABEL } from "../data/settings";
import { fmt } from "./format";
import { IconCheck, IconPlus } from "./icons";

function DaySelect(props: { api: Api; value: string; onChange: (d: string) => void }) {
  return (
    <select class="select" value={props.value} onChange={(e) => props.onChange((e.target as HTMLSelectElement).value)}>
      <option value="">Planner picks the day</option>
      {props.api.sched.days.map((d) => <option value={d}>{shortDate(d)}</option>)}
    </select>
  );
}

function FlagRow(props: { api: Api; f: Flag }) {
  const { api, f } = props;
  const [qty, setQty] = useState(f.suggestQty);
  const [day, setDay] = useState("");
  const manual = api.edits.pins.filter((p) => p.manual && p.sku === f.sku);
  return (
    <tr>
      <td><b>{f.sku}</b><div class="small muted">{f.product}</div></td>
      <td class="num">{fmt(f.available)}</td>
      <td class="num">{fmt(f.reorderPoint)}</td>
      <td class="num">{fmt(f.suggested)}</td>
      <td>
        {manual.length ? (
          <div class="row">
            <span class="badge good"><IconCheck /> Added {manual.map((p) => `${fmt(p.qty)}${p.date ? ` on ${shortDate(p.date)}` : ""}`).join(", ")}</span>
            {manual.map((p) => <button class="btn small" onClick={() => api.removePin(p.id)}>Remove</button>)}
          </div>
        ) : (
          <div class="row">
            <input class="input" type="number" min={1} style={{ width: 90 }} value={qty} aria-label="Quantity" onInput={(e) => setQty(+(e.target as HTMLInputElement).value)} />
            <DaySelect api={api} value={day} onChange={setDay} />
            <button class="btn small primary" disabled={!(qty > 0)} onClick={() => api.addManual(f.sku, qty, day)}><IconPlus /> Add to schedule</button>
          </div>
        )}
      </td>
    </tr>
  );
}

export function Review(props: { api: Api }) {
  const { api } = props;
  const { sched } = api;
  const noSales = sched.flags.filter((f) => f.kind === "noSales");
  const other = sched.flags.filter((f) => f.kind !== "noSales");
  const choices = [...sched.model.items.values()].filter((i) => !i.auto).sort((a, b) => a.sku.localeCompare(b.sku));
  const [pick, setPick] = useState("");
  const [qty, setQty] = useState(0);
  const [day, setDay] = useState("");
  const picked = choices.find((i) => pick.startsWith(i.sku + " — ") || pick === i.sku);
  const manual = api.edits.pins.filter((p) => p.manual);

  return (
    <>
      <div class="card">
        <div class="card-head">
          <h2>Below reorder point, but no recent sales</h2>
          <span class="card-sub">{noSales.length} items. The reorder report wants these, but nothing sold in the last {api.s.demandWeeks} weeks, so the planner doesn't schedule them on its own.</span>
        </div>
        <div class="card-body table-wrap">
          {noSales.length ? (
            <table class="data">
              <thead><tr><th>Product</th><th class="num">Available</th><th class="num">Reorder point</th><th class="num">Reorder report suggests</th><th>Add (quantity rounded up to its typical batch)</th></tr></thead>
              <tbody>{noSales.map((f) => <FlagRow api={api} f={f} key={f.sku} />)}</tbody>
            </table>
          ) : <div class="muted">Nothing to review.</div>}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Add an MO manually</h2><span class="card-sub">Any product with an active BOM. Its fills and blends are planned automatically.</span></div>
        <div class="card-body stack">
          <div class="row">
            <input class="input" list="mps-products" placeholder="Search SKU or product" style={{ flex: "1 1 280px" }} value={pick}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setPick(v);
                const it = choices.find((i) => v.startsWith(i.sku + " — ") || v === i.sku);
                if (it) setQty(it.batch || 1);
              }} />
            <datalist id="mps-products">{choices.map((i) => <option value={`${i.sku} — ${i.name}`}>{LANE_LABEL[i.type]}</option>)}</datalist>
            <input class="input" type="number" min={1} style={{ width: 100 }} value={qty || ""} placeholder="Qty" aria-label="Quantity" onInput={(e) => setQty(+(e.target as HTMLInputElement).value)} />
            <DaySelect api={api} value={day} onChange={setDay} />
            <button class="btn primary" disabled={!picked || !(qty > 0)} onClick={() => { api.addManual(picked!.sku, qty, day); setPick(""); setQty(0); }}><IconPlus /> Add</button>
          </div>
          {picked && <div class="small muted">{LANE_LABEL[picked.type]} · typical batch {fmt(picked.batch || 0)}{picked.type === "BLEND" ? " gal" : ""}</div>}
          {!!manual.length && (
            <table class="data">
              <thead><tr><th>Manual MO</th><th class="num">Quantity</th><th>Day</th><th /></tr></thead>
              <tbody>
                {manual.map((p) => (
                  <tr>
                    <td><b>{p.sku}</b><div class="small muted">{sched.model.names.get(p.sku)}</div></td>
                    <td class="num">{fmt(p.qty)}</td>
                    <td>{p.date ? shortDate(p.date) : sched.mos.find((m) => m.id === `pin:${p.id}`) ? `${shortDate(sched.mos.find((m) => m.id === `pin:${p.id}`)!.date)} (planner)` : "Not placed: see Shortages"}</td>
                    <td><button class="btn small" onClick={() => api.removePin(p.id)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {!!other.length && (
        <div class="card">
          <div class="card-head"><h2>On the reorder report but can't be scheduled</h2></div>
          <div class="card-body table-wrap">
            <table class="data">
              <thead><tr><th>Product</th><th>Issue</th><th class="num">Suggested</th></tr></thead>
              <tbody>{other.map((f) => <tr><td><b>{f.sku}</b><div class="small muted">{f.product}</div></td><td>{f.message}</td><td class="num">{fmt(f.suggested)}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
