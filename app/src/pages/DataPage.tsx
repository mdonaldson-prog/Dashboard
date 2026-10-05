import { useState } from "preact/hooks";
import type { AppApi } from "../App";
import { longDate } from "../calc/dates";
import { REPORTS, type ReportKind } from "../data/model";
import { CARRIER_CLASS_LABEL, carrierClass, DEFAULT_SETTINGS, mergeSettings, type CarrierClass } from "../data/settings";
import { Card, DataTable, Seg } from "../ui/components";
import { downloadBlob } from "../ui/csv";
import { IconAlert, IconCheck, IconDownload, IconUpload } from "../ui/icons";

export function DataPage(props: { api: AppApi; theme: string; setTheme: (t: string) => void }) {
  const { api } = props;
  const { c, s } = api;
  const [msg, setMsg] = useState("");
  const loaded = new Map(c.ds.files.filter((f) => f.kind).map((f) => [f.kind!, f]));
  const kinds = Object.keys(REPORTS) as ReportKind[];

  // Carrier values with order counts and freight charged
  const carriers = new Map<string, { raw: string; orders: number; freight: number }>();
  for (const o of c.orders.values()) {
    const k = o.carrier || "";
    const e = carriers.get(k) ?? { raw: k, orders: 0, freight: 0 };
    e.orders++;
    e.freight += o.freight;
    carriers.set(k, e);
  }
  const setCarrier = (raw: string, cls: CarrierClass) => api.setS((x) => ({ ...x, carrierOverrides: { ...x.carrierOverrides, [raw.toLowerCase()]: cls } }));

  const exportSettings = () => downloadBlob("dashboard-settings.json", new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }));
  const importSettings = async (f: File | undefined) => {
    if (!f) return;
    try {
      const next = mergeSettings(JSON.parse(await f.text()));
      api.setS(() => next);
      setMsg("Settings imported.");
    } catch {
      setMsg("That file isn't a settings file.");
    }
  };

  const neg = c.ds.stockLevels.filter((x) => x.qty < 0);
  const zeroCost = c.ds.stockLevels.filter((x) => x.qty > 0 && !(c.product(x.sku, x.product)?.cost));

  return (
    <>
      <Card
        title="Loaded reports"
        sub={`Loaded ${new Date(c.ds.loadedAt).toLocaleString()} · data through ${longDate(c.latest)}`}
        actions={<button class="btn primary" onClick={api.reload}><IconUpload /> Load new files</button>}
      >
        <DataTable
          rows={kinds.map((k) => ({ k, f: loaded.get(k) }))}
          pageSize={20}
          cols={[
            { key: "status", label: "", render: (r) => (r.f ? (r.f.warnings.length ? <span class="badge warn"><IconAlert /> Check</span> : <span class="badge good"><IconCheck /> OK</span>) : REPORTS[r.k].weekly ? <span class="badge bad">Missing</span> : <span class="badge">Optional</span>) },
            { key: "report", label: "Report", render: (r) => <><b>{REPORTS[r.k].label}</b><div class="small muted">{r.f?.name ?? "Not loaded"}</div></> },
            { key: "rows", label: "Rows", num: true, render: (r) => (r.f ? r.f.rows.toLocaleString() : "—") },
            { key: "range", label: "Dates", render: (r) => (r.f?.minDate ? `${longDate(r.f.minDate)} – ${longDate(r.f.maxDate!)}` : r.f ? "Current snapshot" : "—") },
            { key: "warn", label: "Notes", render: (r) => <div class="small secondary">{r.f?.warnings.map((w) => <div>{w}</div>)}</div> },
          ]}
        />
        {c.ds.files.some((f) => !f.kind) && (
          <div class="small" style={{ marginTop: 10 }}>
            <span class="badge bad">Not recognized</span> {c.ds.files.filter((f) => !f.kind).map((f) => f.name).join(", ")}
          </div>
        )}
      </Card>

      <Card title="Carrier classes" sub="Ground shipments are excluded from transportation metrics. Pickup orders are excluded from fulfillment speed. Blank carrier = Carrier unknown (included).">
        <DataTable
          rows={[...carriers.values()]}
          initialSort={{ key: "orders", dir: -1 }}
          pageSize={30}
          cols={[
            { key: "raw", label: "Shipping carrier in inFlow", render: (r) => r.raw || <span class="muted">(blank)</span> },
            { key: "orders", label: "Orders", unit: "count" },
            { key: "freight", label: "Freight charged", unit: "usd" },
            {
              key: "cls", label: "Class", sortValue: (r) => carrierClass(r.raw, s),
              render: (r) =>
                r.raw ? (
                  <select class="select" style={{ height: 28 }} value={carrierClass(r.raw, s)} onChange={(e) => setCarrier(r.raw, (e.target as HTMLSelectElement).value as CarrierClass)}>
                    {(Object.keys(CARRIER_CLASS_LABEL) as CarrierClass[]).map((k) => <option value={k}>{CARRIER_CLASS_LABEL[k]}</option>)}
                  </select>
                ) : CARRIER_CLASS_LABEL.unknown,
            },
          ]}
        />
      </Card>

      <div class="grid-2-even">
        <Card title="Negative stock" sub={`${neg.length} rows · excluded from inventory value`}>
          <DataTable rows={neg} pageSize={10} csvName="negative-stock.csv" initialSort={{ key: "qty", dir: 1 }}
            cols={[{ key: "location", label: "Location" }, { key: "product", label: "Product" }, { key: "sku", label: "SKU" }, { key: "qty", label: "On hand", unit: "units" }]} />
        </Card>
        <Card title="Stocked items with $0 cost" sub={`${zeroCost.length} rows · fill costs in inFlow so inventory value is complete`}>
          <DataTable rows={zeroCost} pageSize={10} csvName="zero-cost-items.csv" initialSort={{ key: "qty", dir: -1 }}
            cols={[{ key: "location", label: "Location" }, { key: "product", label: "Product" }, { key: "sku", label: "SKU" }, { key: "qty", label: "On hand", unit: "units" }]} />
        </Card>
      </div>

      <div class="grid-2-even">
        <Card title="Locations" sub="How the freight portal names each site's city. Used to match portal shipments to stock transfers.">
          <div class="stack" style={{ gap: 10 }}>
            {Object.entries(s.locations).map(([loc, ls]) => (
              <label class="field">
                {loc}
                <input class="input" value={ls.portalCity} onChange={(e) => api.setS((x) => ({ ...x, locations: { ...x.locations, [loc]: { ...ls, portalCity: (e.target as HTMLInputElement).value } } }))} />
              </label>
            ))}
            <label class="field">
              Sales lines with no location count toward velocity at
              <select class="select" value={s.unassignedSalesLocation} onChange={(e) => api.setS((x) => ({ ...x, unassignedSalesLocation: (e.target as HTMLSelectElement).value }))}>
                {Object.keys(s.locations).map((l) => <option value={l}>{l}</option>)}
              </select>
            </label>
            <label class="field">
              Manufacturing happens at (the MFG report has no location)
              <select class="select" value={s.mfgLocation} onChange={(e) => api.setS((x) => ({ ...x, mfgLocation: (e.target as HTMLSelectElement).value }))}>
                {Object.keys(s.locations).map((l) => <option value={l}>{l}</option>)}
              </select>
            </label>
          </div>
        </Card>
        <Card title="Calendar & settings file">
          <div class="stack" style={{ gap: 12 }}>
            <label class="field">
              Items that ship from another location (count in Sales $, not in units). One name fragment per line.
              <textarea class="input" style={{ height: 76, padding: 8, fontFamily: "var(--mono)" }} value={s.dropShipPatterns.join("\n")}
                onChange={(e) => api.setS((x) => ({ ...x, dropShipPatterns: (e.target as HTMLTextAreaElement).value.split("\n").map((v) => v.trim()).filter(Boolean) }))} />
            </label>
            <label class="field">
              Holidays (not business days, no counting). One date per line, YYYY-MM-DD.
              <textarea class="input" style={{ height: 120, padding: 8, fontFamily: "var(--mono)" }} value={s.holidays.join("\n")}
                onChange={(e) => api.setS((x) => ({ ...x, holidays: (e.target as HTMLTextAreaElement).value.split(/\s+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) }))} />
            </label>
            <div class="row">
              <span class="small secondary">Theme</span>
              <Seg label="Theme" value={props.theme} onChange={props.setTheme} options={[{ value: "auto", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
            </div>
            <div class="row">
              <button class="btn" onClick={exportSettings}><IconDownload /> Export settings</button>
              <label class="btn">
                <IconUpload /> Import settings
                <input type="file" accept=".json" style={{ display: "none" }} onChange={(e) => importSettings((e.target as HTMLInputElement).files?.[0])} />
              </label>
              <button class="btn ghost" onClick={() => { if (confirm("Reset all settings to defaults?")) api.setS(() => structuredClone(DEFAULT_SETTINGS)); }}>Reset to defaults</button>
            </div>
            {msg && <span class="small secondary">{msg}</span>}
            <p class="small muted" style={{ margin: 0 }}>
              Settings (capacity, cadences, carrier classes, class overrides) are saved in this browser. Export them to share with the other user or keep a backup.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
