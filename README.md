# Executive Operations Dashboard

An executive dashboard for KPIs, cycle count scheduling, freight, and stock transfers, built from inFlow Inventory / inFlow Manufacturing and freight-portal exports.

It's a single self-contained HTML file. There's no server, no accounts, and no installation. Open it in Edge or Chrome, drop in the weekly reports, and everything is calculated in the browser. Nothing is uploaded anywhere.

## Use it

1. Download [`release/Dashboard.html`](release/Dashboard.html) and save it in your shared folder.
2. Each week, export the 8 reports listed on its start screen, plus the BOM monthly. The [design doc, §5.4](docs/SYSTEM_DESIGN.md#54-weekly-upload-checklist) has the full checklist.
3. Open `Dashboard.html` and drop the files in (or use **Open folder**).

## Aurora cycle count schedule (Google Sheets)

[`release/Aurora_Cycle_Count_Schedule.xlsx`](release/Aurora_Cycle_Count_Schedule.xlsx) is a spreadsheet version of the count schedule for Aurora: A SKUs weekly, B every 2 weeks, C every 4 weeks, counted Tuesday–Friday. Upload it to Google Drive and open it with Google Sheets. Each week, paste the Dashboard's `velocity-Aurora.csv` (Cycle counts → Velocity classes → CSV) into the Velocity tab. The **How to use** tab has the steps.

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
