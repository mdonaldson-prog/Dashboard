# Executive Operations Dashboard & Master Production Schedule

An executive dashboard for KPIs, cycle count scheduling, freight, and stock transfers, built from inFlow Inventory / inFlow Manufacturing and freight-portal exports.

It's a single self-contained HTML file. There's no server, no accounts, and no installation. Open it in Edge or Chrome, drop in the weekly reports, and everything is calculated in the browser. Nothing is uploaded anywhere.

## Use it

1. Download [`release/Dashboard.html`](release/Dashboard.html) and save it in your shared folder.
2. Each week, export the 8 reports listed on its start screen, plus the BOM monthly. The [design doc, §5.4](docs/SYSTEM_DESIGN.md#54-weekly-upload-checklist) has the full checklist.
3. Open `Dashboard.html` and drop the files in (or use **Open folder**).

## Docs

- [System Design Document](docs/SYSTEM_DESIGN.md): architecture, data inputs, KPI definitions, count scheduling, and the implementation plan.
- [Prototype scope](docs/SYSTEM_DESIGN.md#16-prototype): what's built and what's next.

## Develop

The source is in [`app/`](app/): Preact + TypeScript + ECharts, bundled to one file with Vite.

```
cd app
npm install
npm run build                              # → dist/index.html (copy to release/Dashboard.html)
npm run verify -- /path/to/exports         # print last week's KPIs and the count plan
```

## Master Production Schedule

A separate single file, [`release/ProductionSchedule.html`](release/ProductionSchedule.html), that suggests a two-week Blend, Fill and Kit schedule from demand, stock and capacity.

- **Drop in each run:** Inventory summary, Stock reordering report, Sales by product details (last 8+ weeks). **Monthly:** inFlow BOM. **Optional:** completed MO history, to re-learn batch sizes and capacity.
- **How it plans:** average daily sales over the last 8 weeks (auto-built 15-gal and private-label kits passed down to their buckets and fills), 10 workdays of cover + 5 safety, reorder point as a minimum, netted against available stock, rounded up to each SKU's typical batch. Kits drive fills, fills drive blends. Raw materials go to the most urgent items first; anything short goes to the Shortages page.
- **Capacity (editable):** 3 standard + 1 big-tank (≥1,000 gal) blend per day, 1,835 gal filled, 275 kits. Mon–Fri, US holidays plus your own closures.
- **Outputs:** calendar with drag-to-move and lock, needs-review list with "Add to schedule", shortages, plan details, master overview and team sheet printouts, CSV of suggested MOs named `TYPE-YYDDMM-NAME-LABEL`.

Source is in [`mps/`](mps/):

```
cd mps
npm install
npm run build                              # → dist/index.html (copy to release/ProductionSchedule.html)
npm run verify -- /path/to/exports         # print the two-week schedule for a folder of exports
npm run baselines -- /path/to/exports      # re-learn the built-in batch sizes from MO history + BOM
```
