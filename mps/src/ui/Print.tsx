import { longDate, shortDate } from "../calc/dates";
import type { Mo, Schedule } from "../calc/plan";
import type { Dataset } from "../data/model";
import type { Lane } from "../data/settings";
import { LANE_LABEL, LANES } from "../data/settings";
import { fmt, fmt0 } from "./format";
import { BlockedTable, MaterialsTable, ReceiptsTable, UnplacedTable } from "./Shortages";

export type PrintKind = { kind: "master" } | { kind: "team"; lane: Lane };

const qty = (m: Mo) => (m.type === "BLEND" ? `${fmt(m.qty)} gal` : m.type === "FILL" ? `${fmt(m.qty)} (${fmt0(m.gallons)} gal)` : fmt(m.qty));

function Header(props: { title: string; sched: Schedule; ds: Dataset }) {
  const { sched } = props;
  return (
    <div class="print-header">
      <h1>{props.title}</h1>
      <div class="meta">
        <span>{longDate(sched.days[0])} – {longDate(sched.days[sched.days.length - 1])}{sched.closures.length ? ` · closed ${sched.closures.map((c) => shortDate(c.date)).join(", ")}` : ""}</span>
        <span>Files loaded {new Date(props.ds.loadedAt).toLocaleString()} · printed {new Date().toLocaleString()}</span>
      </div>
    </div>
  );
}

function MoRows(props: { mos: Mo[]; withDate?: boolean; withWhy?: boolean }) {
  return (
    <table class="ptable">
      <thead><tr>{props.withDate && <th>Day</th>}<th>MO</th><th>SKU</th><th>Product</th><th class="num">Qty</th>{props.withWhy && <th>Why</th>}</tr></thead>
      <tbody>
        {props.mos.map((m) => (
          <tr>
            {props.withDate && <td class="nowrap">{shortDate(m.date)}</td>}
            <td class="mono">{m.name}{m.pinned ? " (locked)" : m.manual ? " (manual)" : ""}</td>
            <td>{m.sku}</td>
            <td>{m.product}</td>
            <td class="num nowrap">{qty(m)}</td>
            {props.withWhy && <td class="small">{m.why[0] ?? ""}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Master(props: { sched: Schedule; ds: Dataset }) {
  const { sched } = props;
  const lane = (t: Lane) => sched.mos.filter((m) => m.type === t);
  const review = sched.flags.filter((f) => f.kind === "noSales" && !f.added);
  return (
    <>
      <section class="sheet">
        <Header title="Master Production Schedule" {...props} />
        <div class="ptiles">
          <div><b>{lane("BLEND").length}</b> blend batches · {fmt0(lane("BLEND").reduce((a, m) => a + m.qty, 0))} gal</div>
          <div><b>{fmt0(lane("FILL").reduce((a, m) => a + m.gallons, 0))}</b> gal filled · {lane("FILL").length} MOs</div>
          <div><b>{fmt0(lane("KIT").reduce((a, m) => a + m.qty, 0))}</b> kits · {lane("KIT").length} MOs</div>
          <div><b>{sched.shortages.length}</b> items short on materials · <b>{sched.materials.length}</b> raw materials short</div>
        </div>
        <h2>Schedule by day</h2>
        {sched.days.map((d) => {
          const mos = sched.mos.filter((m) => m.date === d);
          return (
            <div class="pday">
              <h3>{shortDate(d)}</h3>
              {mos.length ? LANES.map((t) => {
                const xs = mos.filter((m) => m.type === t);
                return xs.length ? (
                  <div class="plane"><b>{LANE_LABEL[t]}:</b> {xs.map((m) => `${m.sku} ${qty(m)}`).join(" · ")}</div>
                ) : null;
              }) : <div class="small">Nothing scheduled</div>}
            </div>
          );
        })}
      </section>
      <section class="sheet">
        <h2>Suggested MOs</h2>
        <MoRows mos={sched.mos} withDate withWhy />
      </section>
      <section class="sheet">
        <h2>Raw materials short</h2>
        {sched.materials.length ? <MaterialsTable sched={sched} /> : <p>None.</p>}
        <h2>Needs scheduling, but materials are missing</h2>
        {sched.shortages.length ? <BlockedTable sched={sched} /> : <p>None.</p>}
        {sched.receipts.some((r) => r.used > 0) && (<><h2>POs this schedule counts on</h2><ReceiptsTable sched={sched} onlyUsed /></>)}
        {!!sched.unplaced.length && (<><h2>Didn't fit in these two weeks</h2><UnplacedTable sched={sched} /></>)}
        {!!review.length && (
          <>
            <h2>Needs review: below reorder point with no recent sales</h2>
            <table class="ptable">
              <thead><tr><th>SKU</th><th>Product</th><th class="num">Available</th><th class="num">Reorder point</th><th class="num">Suggested</th></tr></thead>
              <tbody>{review.map((f) => <tr><td>{f.sku}</td><td>{f.product}</td><td class="num">{fmt(f.available)}</td><td class="num">{fmt(f.reorderPoint)}</td><td class="num">{fmt(f.suggested)}</td></tr>)}</tbody>
            </table>
          </>
        )}
      </section>
    </>
  );
}

function Team(props: { sched: Schedule; ds: Dataset; lane: Lane }) {
  const { sched, lane } = props;
  return (
    <>
      {sched.days.map((d) => {
        const mos = sched.mos.filter((m) => m.date === d && m.type === lane);
        return (
          <section class="sheet">
            <Header title={`${LANE_LABEL[lane]} team · ${shortDate(d)}`} {...props} />
            {mos.length ? (
              <table class="ptable team">
                <thead><tr><th>Done</th><th>MO</th><th>SKU</th><th>Product</th><th class="num">{lane === "BLEND" ? "Gallons" : "Qty"}</th>{lane === "FILL" && <th class="num">Gallons</th>}<th>Notes</th></tr></thead>
                <tbody>
                  {mos.map((m) => (
                    <tr>
                      <td class="box">☐</td>
                      <td class="mono">{m.name}</td>
                      <td>{m.sku}</td>
                      <td>{m.product}</td>
                      <td class="num">{fmt(m.qty)}</td>
                      {lane === "FILL" && <td class="num">{fmt0(m.gallons)}</td>}
                      <td class="blank" />
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p>Nothing scheduled for the {LANE_LABEL[lane].toLowerCase()} team today.</p>}
          </section>
        );
      })}
    </>
  );
}

export function PrintView(props: { kind: PrintKind; sched: Schedule; ds: Dataset }) {
  return (
    <div class="print-root">
      {props.kind.kind === "master" ? <Master sched={props.sched} ds={props.ds} /> : <Team sched={props.sched} ds={props.ds} lane={props.kind.lane} />}
    </div>
  );
}
