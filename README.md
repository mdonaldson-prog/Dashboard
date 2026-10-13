# Executive Operations Dashboard

An executive dashboard for KPIs, cycle count scheduling, freight, and stock transfers, built from inFlow Inventory / inFlow Manufacturing and freight-portal exports.

It's a single self-contained HTML file. There's no server, no accounts, and no installation. Open it in Edge or Chrome, drop in the weekly reports, and everything is calculated in the browser. Nothing is uploaded anywhere.

## Use it

1. Download [`release/Dashboard.html`](release/Dashboard.html) and save it in your shared folder.
2. Each week, export the 8 reports listed on its start screen, plus the BOM monthly. The [design doc, §5.4](docs/SYSTEM_DESIGN.md#54-weekly-upload-checklist) has the full checklist.
3. Open `Dashboard.html` and drop the files in (or use **Open folder**).

## Demand Forecast

[`release/Forecast.html`](release/Forecast.html) is a separate single-file page. It forecasts finished-goods and BOM-component demand through December 2027 by location (Aurora, DFW, Houston, or all). Drop in the inFlow **Sales Orders** and **BOM** exports, plus **Product Details** if you want component cost.

- Baseline = average of the last 3 full months; 2027 = baseline × seasonality × 1.30. Growth, baseline window and the monthly seasonality index can all be changed under **Assumptions**.
- Finished goods and components are on separate tabs, each with totals and a CSV export of every month. Components are exploded through every BOM level, tagged *Raw* or *Intermediate*, and planned at Aurora; "Driven by" shows which location's sales create them.
- The full method is on the page under "How this forecast is built", and in the [design doc, §7.4a](docs/SYSTEM_DESIGN.md#74a-demand-forecast-page-standalone).

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
npm run build:forecast                     # → ../release/Forecast.html
npm run verify:forecast -- /path/to/exports  # print the forecast totals by location
```
