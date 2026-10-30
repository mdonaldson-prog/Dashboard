import { useState } from "preact/hooks";
import type { Api } from "../App";
import { shortDate } from "../calc/dates";
import type { DayLoad, Mo } from "../calc/plan";
import type { Lane } from "../data/settings";
import { LANE_LABEL, LANES } from "../data/settings";
import { fmt, fmt0, plural } from "./format";
import { IconAlert, IconLock, IconPlus, IconX } from "./icons";

/** Used / capacity for one lane on one day, as text and a 0–1+ fraction. */
export function laneUse(L: DayLoad, lane: Lane, cap: Api["s"]["capacity"]): { text: string; frac: number } {
  if (lane === "BLEND") {
    const total = cap.blendStd + cap.blendBig;
    return { text: `${L.blendStd + L.blendBig} / ${total} batches${L.blendBig ? ` (${L.blendBig} big)` : ""}`, frac: (L.blendStd + L.blendBig) / total };
  }
  if (lane === "FILL") return { text: `${fmt0(L.fillGal)} / ${fmt0(cap.fillGal)} gal`, frac: L.fillGal / cap.fillGal };
  return { text: `${fmt0(L.kits)} / ${fmt0(cap.kits)} kits`, frac: L.kits / cap.kits };
}

export function Meter(props: { frac: number; label: string }) {
  const cls = props.frac > 1.0001 ? "bad" : props.frac >= 0.9 ? "warn" : "";
  return (
    <div class="cap">
      <div class={`meter ${cls}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(props.frac * 100)} aria-label={props.label}>
        <div class="meter-fill" style={{ width: `${Math.min(100, props.frac * 100)}%` }} />
      </div>
      <span class="small muted">{props.label}{props.frac > 1.0001 ? " · over" : ""}</span>
    </div>
  );
}

function qtyText(mo: Mo) {
  if (mo.type === "BLEND") return `${fmt(mo.qty)} gal`;
  if (mo.type === "FILL") return `${fmt(mo.qty)} units · ${fmt0(mo.gallons)} gal`;
  return `${fmt(mo.qty)} kits`;
}

function MoCard(props: { mo: Mo; onOpen: () => void; onDrag: (mo: Mo | null) => void }) {
  const { mo } = props;
  return (
    <button
      class={`mo ${mo.pinned || mo.manual ? "pinned" : ""} ${mo.warnings.length ? "has-warn" : ""}`}
      draggable
      onDragStart={(e) => { e.dataTransfer?.setData("text/plain", mo.id); props.onDrag(mo); }}
      onDragEnd={() => props.onDrag(null)}
      onClick={props.onOpen}
      title={mo.why.join("\n")}
    >
      <span class="mo-top">
        <span class="mo-sku">{mo.sku}</span>
        {mo.pinned && <span class="mo-flag" title="Locked to this day"><IconLock /></span>}
        {mo.manual && <span class="mo-flag" title="Added manually"><IconPlus /></span>}
        {!!mo.warnings.length && <span class="mo-flag warn" title={mo.warnings.join("\n")}><IconAlert /></span>}
        {mo.why.some((w) => w.startsWith("Uses ")) && <span class="mo-po" title={mo.why.filter((w) => w.startsWith("Uses ")).join("\n")}>PO</span>}
      </span>
      <span class="mo-name">{mo.product}</span>
      <span class="mo-qty">{qtyText(mo)}</span>
    </button>
  );
}

function MoDrawer(props: { api: Api; mo: Mo; onClose: () => void }) {
  const { api, mo } = props;
  const [name, setName] = useState(mo.name);
  const pinId = mo.id.startsWith("pin:") ? mo.id.slice(4) : null;
  const pin = pinId ? api.edits.pins.find((p) => p.id === pinId) : null;
  return (
    <div class="drawer-bg" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="drawer narrow" role="dialog" aria-label={mo.name}>
        <div class="drawer-head">
          <div style={{ minWidth: 0 }}>
            <div class="small muted">{LANE_LABEL[mo.type]} MO · {shortDate(mo.date)}</div>
            <h2>{mo.product}</h2>
            <div class="small muted">{mo.sku}</div>
          </div>
          <span class="spacer" />
          <button class="btn icon ghost" aria-label="Close" onClick={props.onClose}><IconX /></button>
        </div>
        <div class="drawer-body stack">
          <label class="field">
            MO name
            <div class="row">
              <input class="input mono" style={{ flex: 1 }} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)}
                onBlur={() => api.rename(mo.nameKey, name === mo.defaultName ? "" : name)} />
              {mo.name !== mo.defaultName && <button class="btn small" onClick={() => { setName(mo.defaultName); api.rename(mo.nameKey, ""); }}>Reset</button>}
            </div>
          </label>
          <div class="row">
            <label class="field">
              Day
              <select class="select" value={mo.date} onChange={(e) => { api.move(mo, (e.target as HTMLSelectElement).value); props.onClose(); }}>
                {api.sched.days.map((d) => <option value={d}>{shortDate(d)}</option>)}
              </select>
            </label>
            <label class="field">
              Quantity {mo.type === "BLEND" ? "(gal)" : ""}
              {pin ? (
                <input class="input" type="number" min={0} step="any" style={{ width: 120 }} value={pin.qty}
                  onChange={(e) => api.setPinQty(pin.id, Math.max(0, +(e.target as HTMLInputElement).value))} />
              ) : (
                <span class="input static">{fmt(mo.qty)}</span>
              )}
            </label>
            {mo.type === "FILL" && <div class="field">Gallons<span class="input static">{fmt0(mo.gallons)}</span></div>}
          </div>
          <div class="row">
            {!pinId && <button class="btn" onClick={() => { api.lock(mo); props.onClose(); }}><IconLock /> Lock to this day</button>}
            {mo.pinned && <button class="btn" onClick={() => { api.unlock(mo); props.onClose(); }}>Unlock (let the planner place it)</button>}
            {mo.manual && pinId && <button class="btn" onClick={() => { api.removePin(pinId); props.onClose(); }}>Remove manual MO</button>}
          </div>
          {!pinId && <div class="small muted">Changing the day or quantity locks the MO. A locked MO stays put when files are reloaded, and the planner works around it.</div>}
          {!!mo.warnings.length && (
            <div class="notice warn"><IconAlert /><div>{mo.warnings.map((w) => <div>{w}</div>)}</div></div>
          )}
          <div>
            <div class="section-title">Why it's scheduled</div>
            <ul class="why">{mo.why.map((w) => <li>{w}</li>)}</ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Calendar(props: { api: Api }) {
  const { api } = props;
  const { sched, s } = api;
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<Mo | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  const openMo = sched.mos.find((m) => m.id === open) ?? null;

  const lane = (t: Lane) => sched.mos.filter((m) => m.type === t);
  const sum = (xs: Mo[], f: (m: Mo) => number) => xs.reduce((a, m) => a + f(m), 0);
  const capTotal = (t: Lane) => sched.days.length * (t === "BLEND" ? s.capacity.blendStd + s.capacity.blendBig : t === "FILL" ? s.capacity.fillGal : s.capacity.kits);
  const used = { BLEND: lane("BLEND").length, FILL: sum(lane("FILL"), (m) => m.gallons), KIT: sum(lane("KIT"), (m) => m.qty) };
  const weeks: string[][] = [];
  for (let i = 0; i < sched.days.length; i += 5) weeks.push(sched.days.slice(i, i + 5));
  const blockedQty = sched.shortages.length;

  return (
    <>
      <div class="tiles">
        <div class="tile">
          <div class="tile-label">Blends</div>
          <div class="tile-value">{plural(used.BLEND, "batch", "batches")}</div>
          <Meter frac={used.BLEND / capTotal("BLEND")} label={`${fmt0(sum(lane("BLEND"), (m) => m.qty))} gal · ${Math.round((100 * used.BLEND) / capTotal("BLEND"))}% of capacity`} />
        </div>
        <div class="tile">
          <div class="tile-label">Fill</div>
          <div class="tile-value">{fmt0(used.FILL)} gal</div>
          <Meter frac={used.FILL / capTotal("FILL")} label={`${plural(lane("FILL").length, "MO")} · ${Math.round((100 * used.FILL) / capTotal("FILL"))}% of capacity`} />
        </div>
        <div class="tile">
          <div class="tile-label">Kits</div>
          <div class="tile-value">{fmt0(used.KIT)} kits</div>
          <Meter frac={used.KIT / capTotal("KIT")} label={`${plural(lane("KIT").length, "MO")} · ${Math.round((100 * used.KIT) / capTotal("KIT"))}% of capacity`} />
        </div>
        <button class={`tile ${blockedQty ? "tile-bad" : "tile-good"}`} onClick={() => api.go("shortages")}>
          <div class="tile-label">Can't be scheduled</div>
          <div class="tile-value">{plural(blockedQty + sched.unplaced.length, "item")}</div>
          <div class="small muted">{plural(sched.materials.length, "raw material")} short{sched.unplaced.length ? ` · ${sched.unplaced.length} didn't fit` : ""}</div>
        </button>
      </div>

      {weeks.map((wk, wi) => (
        <div class="card">
          <div class="card-head"><h2>Week {wi + 1}</h2><span class="card-sub">{shortDate(wk[0])} – {shortDate(wk[wk.length - 1])}</span></div>
          <div class="card-body">
            <div class="cal" style={{ "--days": wk.length } as never}>
              <div class="cal-corner" />
              {LANES.map((t) => <div class={`cal-lane lane-${t}`}>{LANE_LABEL[t]}</div>)}
              {wk.map((d) => {
                const L = sched.loads.find((x) => x.date === d)!;
                return (
                  <>
                    <div class="cal-day">{shortDate(d)}</div>
                    {LANES.map((t) => {
                      const u = laneUse(L, t, s.capacity);
                      const cellKey = `${t}|${d}`;
                      const mos = sched.mos.filter((m) => m.date === d && m.type === t);
                      return (
                        <div
                          class={`cal-cell lane-${t} ${drag && drag.type === t ? "droppable" : ""} ${dropAt === cellKey ? "drop-on" : ""}`}
                          onDragOver={(e) => { if (drag && drag.type === t) { e.preventDefault(); setDropAt(cellKey); } }}
                          onDragLeave={() => setDropAt((x) => (x === cellKey ? null : x))}
                          onDrop={(e) => { e.preventDefault(); setDropAt(null); if (drag && drag.type === t && drag.date !== d) api.move(drag, d); setDrag(null); }}
                        >
                          <div class="cal-cell-head"><span class="cal-cell-lane">{LANE_LABEL[t]} · {shortDate(d)}</span><Meter frac={u.frac} label={u.text} /></div>
                          {mos.map((m) => <MoCard mo={m} onOpen={() => setOpen(m.id)} onDrag={setDrag} />)}
                          {!mos.length && <div class="small muted cal-empty">Nothing scheduled</div>}
                        </div>
                      );
                    })}
                  </>
                );
              })}
            </div>
          </div>
        </div>
      ))}
      <div class="small muted">
        Drag an MO to another day in its lane, or click it to rename, lock, change the quantity or see why it's scheduled. Moved and locked MOs keep their day when the plan recalculates.
      </div>
      {openMo && <MoDrawer key={openMo.id} api={api} mo={openMo} onClose={() => setOpen(null)} />}
    </>
  );
}
