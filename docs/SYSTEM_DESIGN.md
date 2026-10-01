# Executive Operations Dashboard — System Design Document

| | |
|---|---|
| **Status** | Draft v1.0 — for review |
| **Date** | 2026-10-01 |
| **Scope** | KPIs, demand forecasting, cycle count scheduling, vendor scorecards, carrier scorecards |
| **System of record** | inFlow Inventory / inFlow Manufacturing (via inFlow Cloud API) |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals, Non-Goals, and Assumptions](#2-goals-non-goals-and-assumptions)
3. [Architecture Overview](#3-architecture-overview)
4. [Technology Stack](#4-technology-stack)
5. [Key Architecture Decisions](#5-key-architecture-decisions)
6. [inFlow Integration Design](#6-inflow-integration-design)
7. [Data Architecture and Database Schema](#7-data-architecture-and-database-schema)
8. [Functional Module Design](#8-functional-module-design)
9. [Backend Module and API Design](#9-backend-module-and-api-design)
10. [Frontend Component Hierarchy](#10-frontend-component-hierarchy)
11. [User Flows](#11-user-flows)
12. [Security, Access Control, and Audit](#12-security-access-control-and-audit)
13. [Non-Functional Requirements](#13-non-functional-requirements)
14. [Testing Strategy](#14-testing-strategy)
15. [Implementation Plan](#15-implementation-plan)
16. [Risks and Mitigations](#16-risks-and-mitigations)
17. [Open Questions for Stakeholders](#17-open-questions-for-stakeholders)
18. [Glossary](#18-glossary)

---

## 1. Executive Summary

We will build a web-based **Executive Operations Dashboard** that gives leadership a single, trustworthy view of inventory, manufacturing, purchasing, and fulfillment performance. inFlow remains the operational system of record; the dashboard **replicates inFlow data into its own analytical database** on a schedule, enriches it (history, targets, scores, forecasts), and serves fast, drillable views.

Five capability areas:

| Capability | What it delivers |
|---|---|
| **KPIs** | Curated, governed metric catalog (inventory turns, OTIF, fill rate, gross margin, MO schedule adherence, etc.) with targets, trends, and drill-down to the source documents. |
| **Forecasting** | SKU × location demand forecasts with confidence bands, accuracy tracking, planner overrides, and reorder-point / order-quantity recommendations. |
| **Cycle Count Schedules** | ABC-driven count calendar, mobile count entry, variance review and approval, inventory record accuracy (IRA) tracking, and optional posting of adjustments back to inFlow. |
| **Vendor Scorecards** | Weighted, period-based scores for on-time, in-full, lead-time reliability, price variance, and quality, with evidence drill-down and exportable reports. |
| **Carrier Scorecards** | On-time delivery, transit-time reliability, cost-to-serve, damage/claims, and tracking compliance per carrier and service level. |

The architecture is a **modular monolith** (one deployable API + background workers + a separate Python forecasting worker) on **PostgreSQL**, which keeps operating cost and complexity appropriate for a mid-size business while leaving clean seams to split services later.

---

## 2. Goals, Non-Goals, and Assumptions

### 2.1 Goals

- **G1 — Single source of executive truth.** Every KPI has one written definition, one calculation, and an owner.
- **G2 — Fresh enough to act on.** Operational data no more than 15–30 minutes stale during business hours; daily KPIs finalized by 06:00 local.
- **G3 — Drill from number to document.** Any KPI value can be traced to the POs, SOs, MOs, shipments, or counts that produced it.
- **G4 — Forward-looking.** Forecasts and stockout-risk projections, not just historical reporting.
- **G5 — Close the loop.** Cycle-count results and approved adjustments can flow back into inFlow (gated behind approval and a feature flag).
- **G6 — Fast.** Dashboard pages render in under 2 seconds at p95.

### 2.2 Non-Goals (v1)

- Replacing inFlow transactions (creating POs, SOs, or MOs from the dashboard). Recommendations are exported or deep-linked into inFlow; they are not executed.
- General-purpose BI / ad-hoc report building. We'll offer CSV/Excel export and can expose the analytics schema to Power BI or Metabase later.
- Full financial accounting (GL, AP/AR). Cost and margin figures come from inFlow costing.
- Native mobile apps. The counter experience is a responsive PWA.

### 2.3 Assumptions (verify in Phase 0)

| # | Assumption | Impact if wrong |
|---|---|---|
| A1 | The company is on an inFlow Cloud plan with API access enabled and an API key can be issued. | Blocker; no integration path. |
| A2 | The inFlow API exposes products, stock levels by location/sublocation, vendors, customers, purchase orders (with receipts), sales orders (with shipping/fulfillment data), manufacturing orders/BOMs, stock adjustments/transfers, and stock counts. | Gaps need alternate sources (CSV export, manual entry). |
| A3 | Entities can be fetched incrementally (a modified-since filter or equivalent sort-and-cursor). | Must fall back to full re-pulls, which raises rate-limit pressure. |
| A4 | inFlow does **not** record carrier *delivery* dates or vendor quality defects. | Carrier delivery data comes from a tracking aggregator; quality events are entered in the dashboard. |
| A5 | At least 12–24 months of sales history exists in inFlow. | Forecasts for short-history SKUs fall back to simple methods and are flagged low-confidence. |
| A6 | Single company, roughly 1–10 locations, up to ~50k SKUs, up to ~100k order lines per year. | Larger volumes push us toward partitioning or a columnar store sooner. |
| A7 | Users authenticate through an existing identity provider (Microsoft Entra ID, Google Workspace, or Okta). | Fall back to a managed auth provider (Auth0/Clerk). |

---

## 3. Architecture Overview

### 3.1 System Context

```mermaid
flowchart LR
    subgraph Users
        EX[Executives]
        OPS[Ops / Inventory Managers]
        PUR[Purchasing / Planners]
        CNT[Warehouse Counters]
        ADM[Admins]
    end

    DASH[[Executive Operations Dashboard]]

    INF[(inFlow Cloud API)]
    TRK[(Carrier Tracking Aggregator<br/>e.g. EasyPost / ShipEngine / AfterShip)]
    IDP[(Identity Provider<br/>Entra ID / Okta / Google)]
    MAIL[(Email / Teams / Slack)]

    EX & OPS & PUR & CNT & ADM --> DASH
    DASH -- read: master data, orders, stock<br/>write: stock adjustments (gated) --> INF
    INF -. webhooks, if available .-> DASH
    DASH -- tracking lookups --> TRK
    TRK -. tracking webhooks .-> DASH
    DASH -- SSO / OIDC --> IDP
    DASH -- alerts and digests --> MAIL
```

### 3.2 Container View

```mermaid
flowchart TB
    subgraph Client
        WEB[Web App - Next.js / React<br/>Desktop dashboards + Counter PWA]
    end

    subgraph Platform
        API[API Service - NestJS<br/>REST, auth, RBAC, query layer]
        WRK[Job Workers - Node / BullMQ<br/>sync, transform, KPI, scorecards,<br/>cycle-count gen, alerts, exports]
        FC[Forecast Worker - Python<br/>statsforecast, backtesting]
        SCH[Scheduler<br/>repeatable jobs]
        Q[(Redis<br/>queues, cache, rate-limit buckets)]
        DB[(PostgreSQL 16<br/>raw, core, analytics, app schemas)]
        OBJ[(Object Storage<br/>exports, PDFs, raw archives)]
        SEC[(Secrets Manager<br/>inFlow API key, tracking keys)]
    end

    WEB -->|HTTPS / JSON| API
    API --> DB
    API --> Q
    API --> OBJ
    SCH --> Q
    Q --> WRK
    Q --> FC
    WRK --> DB
    FC --> DB
    WRK --> OBJ
    WRK -->|rate-limited| INF[(inFlow API)]
    WRK --> TRK[(Tracking API)]
    WRK --> SEC
    INF -. webhooks .-> API
```

### 3.3 Data Flow (Pipeline Layers)

```mermaid
flowchart LR
    A[inFlow API] -->|Extract<br/>incremental + reconcile| B[raw.*<br/>JSONB payloads, hashed]
    B -->|Normalize<br/>upsert, FK resolution| C[core.*<br/>typed operational model]
    C -->|Snapshot<br/>daily| D[core.inventory_snapshots]
    C & D -->|Compute| E[analytics.*<br/>kpi_values, scorecards,<br/>forecasts, accuracy]
    E -->|Serve| F[API query layer<br/>+ Redis cache]
    F --> G[Web UI]
```

Every layer is idempotent and replayable. Raw payloads are retained, so a bug in normalization or KPI logic is fixed by re-running transforms, not by re-pulling from inFlow.

---

## 4. Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language (app) | **TypeScript** end to end | One language across UI and API; shared types and validation schemas. |
| Monorepo | **pnpm workspaces + Turborepo** | Shared packages (types, KPI definitions, UI kit) with cached builds. |
| Frontend | **Next.js (App Router), React, TanStack Query** | Mature SSR/CSR hybrid, routing, and good data-fetching ergonomics. |
| UI kit | **Tailwind CSS + shadcn/ui (Radix)** | Accessible primitives; fast to theme to brand. |
| Charts | **Apache ECharts** (via a thin wrapper) | Handles large series, confidence bands, heatmaps, and calendars well. |
| Grids | **TanStack Table** (AG Grid Community if heavy grid editing is needed) | Virtualized tables for drill-down evidence. |
| API | **NestJS** (modular monolith) | Clear module boundaries, DI, guards for RBAC, OpenAPI generation. |
| Validation | **Zod** (shared between web and API) | One schema source for request/response contracts. |
| ORM / migrations | **Drizzle ORM** + SQL migrations | SQL-first, good fit for analytical queries and materialized views. |
| Database | **PostgreSQL 16** (managed: AWS RDS or Azure Flexible Server) | Relational integrity for operational data; window functions and materialized views for analytics; JSONB for raw landing. |
| Queue / cache | **Redis + BullMQ** | Repeatable jobs, retries with backoff, concurrency control, rate-limit buckets. |
| Forecasting | **Python 3.12 + Nixtla statsforecast** (ETS, AutoARIMA, Croston/TSB, seasonal naive), pandas/polars | Fast, well-tested classical models suited to SKU-level demand; no GPU needed. |
| Auth | **OIDC SSO** (Entra ID / Okta / Google) via Auth.js on web + JWT verification in API | Reuses corporate identity and MFA policies. |
| PDF export | Headless Chromium rendering of print-styled pages | Scorecard PDFs match on-screen visuals. |
| Observability | **OpenTelemetry**, Sentry, structured JSON logs, CloudWatch / Grafana | Traces across API → queue → worker → inFlow calls. |
| Infra as code | **Terraform** | Reproducible environments (dev / staging / prod). |
| Hosting | **AWS**: ECS Fargate, RDS PostgreSQL, ElastiCache Redis, S3, Secrets Manager, CloudFront | Managed services and low ops overhead. (Azure equivalents are a like-for-like swap if the company is a Microsoft shop.) |
| CI/CD | **GitHub Actions** | Lint, typecheck, tests, migrations, container build, deploy. |

---

## 5. Key Architecture Decisions

Each decision is written as a lightweight ADR. Full ADRs live in `docs/adr/` once implementation starts.

**ADR-001 — Replicate inFlow data rather than querying the API live.**
*Context:* The inFlow API is rate-limited, paginated, and transactional; it has no aggregation endpoints and no historical stock positions. *Decision:* Sync into PostgreSQL and compute analytics locally. *Consequences:* Data is near-real-time rather than real-time (15-minute target), and we own sync correctness (handled by reconciliation jobs and a freshness indicator in the UI).

**ADR-002 — Modular monolith, not microservices.**
*Decision:* One NestJS API and one worker image sharing domain modules, plus one Python forecasting worker. *Rationale:* A small team, a single database, and shared transactional boundaries. Module boundaries (integration, kpi, forecasting, cycle-count, scorecard, alerting) are enforced by lint rules so we can split services later if needed.

**ADR-003 — PostgreSQL as both operational store and analytical store.**
*Decision:* Separate schemas (`raw`, `core`, `analytics`, `app`) in one cluster, with pre-aggregated `kpi_values` tables and materialized views. *Revisit trigger:* KPI queries exceed 1s at p95 after indexing and pre-aggregation, or order lines exceed roughly 10M. At that point, consider TimescaleDB, DuckDB, or a cloud warehouse.

**ADR-004 — Pre-compute KPIs; don't calculate them on request.**
*Decision:* KPI values are materialized per grain (day/week/month) and dimension (company, location, category, vendor, carrier) by workers after each sync. *Consequence:* Fast reads and auditable values (we store numerator and denominator). Definition changes trigger a backfill job.

**ADR-005 — Python for forecasting only.**
*Decision:* Forecasting runs in an isolated Python worker that reads from and writes to Postgres via the queue contract. *Rationale:* The best statistical forecasting libraries are in Python; isolating them keeps the main stack homogeneous.

**ADR-006 — Write-back to inFlow is narrow, explicit, and gated.**
*Decision:* The only v1 write-back is posting **approved cycle-count adjustments**. It sits behind a feature flag, requires a two-step approval, and is idempotent (a stored external reference prevents duplicate posting).

**ADR-007 — Carrier delivery data from a tracking aggregator.**
*Decision:* Because inFlow stores carrier and tracking number but not delivery confirmation, a single aggregator API (EasyPost, ShipEngine, or AfterShip; chosen in Phase 0) supplies delivery events. Manual delivery-date entry is the fallback.

---

## 6. inFlow Integration Design

> **Note:** The endpoint names, filters, pagination style, rate limits, and webhook availability below reflect our current understanding of the inFlow Cloud API. **All of them must be confirmed in the Phase 0 API spike** against the live API documentation and a sandbox/test company.

### 6.1 Connection

- **Base:** `https://cloudapi.inflowinventory.com/{companyId}/...`
- **Auth:** API key sent as a bearer token. The key is stored in Secrets Manager and never in the database or the client.
- **Versioning:** inFlow uses a versioned `Accept` header. We pin the version in configuration and alert if the API returns deprecation signals.
- **Admin UX:** An admin enters the company ID and API key once. The system validates them with a lightweight read call and shows connection health.

### 6.2 Entity Coverage Matrix

| inFlow entity | Dashboard use | Sync mode | Expected frequency |
|---|---|---|---|
| Products (incl. categories, UoM, costs, item type) | All modules | Incremental | 15 min |
| Locations / sublocations | All modules | Full (small) | Hourly |
| Stock levels (by product × location × sublocation) | Inventory KPIs, counts, forecasts | Full or incremental | 15 min + nightly snapshot |
| Vendors (+ vendor item pricing / lead times) | Vendor scorecards, replenishment | Incremental | Hourly |
| Customers | Sales KPIs | Incremental | Hourly |
| Purchase orders (+ lines, receiving) | Purchasing KPIs, vendor scorecards | Incremental | 15 min |
| Sales orders (+ lines, picking/packing/shipping, carrier, tracking #) | Sales and fulfillment KPIs, carrier scorecards, forecast actuals | Incremental | 15 min |
| Manufacturing orders (+ BOM, components, completion) | Manufacturing KPIs, dependent demand | Incremental | 15 min |
| Bills of materials | Dependent demand explosion | Incremental | Daily |
| Stock adjustments / transfers | Inventory movement history, shrink | Incremental | 15 min |
| Stock counts | Cycle-count reconciliation | Incremental | 15 min |
| **Write:** stock adjustment (or stock count completion) | Posting approved count variances | On demand | Event-driven |

### 6.3 Sync Strategy

Three complementary modes:

1. **Initial backfill.** Full paginated pull of every entity, ordered by dependency (locations → categories → products → vendors/customers → BOMs → POs → SOs → MOs → adjustments → counts). This is resumable: the cursor is checkpointed per page, so a crash resumes instead of restarting.
2. **Incremental sync** (every 15 minutes in business hours, hourly otherwise). For each entity, request records modified since `watermark − overlap` (a 5-minute overlap absorbs clock skew), upsert them into `raw`, then normalize the changed keys into `core`.
3. **Nightly reconciliation.** Pull ID + last-modified lists (or full lists for small entities), detect deletes and missed updates, compare stock-level totals, and write a reconciliation report to `app.sync_runs`. A mismatch above threshold raises an admin alert.

**Webhooks (if inFlow supports them for the entity):** Treated as *hints* that enqueue a targeted fetch of the changed record. They never replace polling, and the payload is never trusted as the full record.

```mermaid
sequenceDiagram
    autonumber
    participant S as Scheduler
    participant Q as Redis/BullMQ
    participant W as Sync Worker
    participant RL as Rate Limiter
    participant I as inFlow API
    participant DB as Postgres

    S->>Q: enqueue sync:purchase_orders (incremental)
    Q->>W: job
    W->>DB: read sync_cursors.watermark
    loop each page
        W->>RL: acquire token
        RL-->>W: ok
        W->>I: GET /purchase-orders?modifiedSince=wm-5m&include=lines,receipts&after=cursor
        I-->>W: 200 page (or 429 → backoff and retry)
        W->>DB: upsert raw.inflow_records (hash compare, skip unchanged)
        W->>DB: checkpoint page cursor
    end
    W->>DB: normalize changed keys → core.purchase_orders/lines/receipts
    W->>DB: advance watermark, write sync_runs row
    W->>Q: enqueue kpi:recompute(affected domains, date ranges)
    W->>Q: enqueue scorecard:recompute(affected vendors)
```

### 6.4 Rate Limiting and Resilience

- **Token bucket in Redis**, shared across all workers, configured below inFlow's published limit (default: 80% of the documented cap). One global bucket per inFlow company.
- **Priority lanes:** Interactive/targeted fetches (webhook hints, write-backs) go ahead of bulk backfill pages.
- **Retries:** Exponential backoff with jitter on 429/5xx, honoring `Retry-After`. After 5 attempts the job goes to a dead-letter queue and shows in Admin → Sync.
- **Circuit breaker:** After N consecutive failures, pause the entity's sync and alert admins rather than hammering the API.
- **Idempotency:** Upserts keyed on `(entity, inflow_id)`. A content hash avoids rewriting unchanged rows. Write-backs carry a client reference stored in `ops.count_adjustments.inflow_reference`, which is checked before every post.
- **Schema drift:** Normalizers validate payloads with Zod. Unknown fields are kept in raw, and missing required fields quarantine the record (it isn't dropped silently) and surface a warning.

### 6.5 Data Freshness Contract

Every API response that serves KPI or entity data includes `dataAsOf` (the oldest last-successful-sync watermark among the entities it depends on). The UI shows a **Data Freshness badge** that turns amber after 45 minutes and red after 2 hours.

---

## 7. Data Architecture and Database Schema

### 7.1 Schema Layout

| Schema | Purpose | Written by | Read by |
|---|---|---|---|
| `raw` | Immutable-ish landing of inFlow and tracking payloads (JSONB) | Sync workers | Normalizers, debugging |
| `core` | Typed, normalized operational model mirroring inFlow plus enrichments | Normalizers | Everything |
| `analytics` | Derived facts: KPI values, forecasts, scorecards, accuracy | Compute workers, forecast worker | API |
| `ops` | Dashboard-owned workflow data: cycle counts, quality events, overrides | API (user actions) | API, workers |
| `app` | Users, roles, configuration, sync bookkeeping, alerts, audit | API, workers | API |

**Conventions**

- Surrogate keys are `uuid` (v7, time-ordered). inFlow IDs are stored as `inflow_id` with a unique index.
- All tables carry `created_at` and `updated_at` (timestamptz). `core` tables also carry `source_modified_at` and `is_deleted` (soft delete from reconciliation).
- Money is `numeric(18,4)` plus a `currency` code. Quantities are `numeric(18,4)` because UoM can be fractional.
- Dates used for KPI bucketing are stored in the company's **local business timezone** as `date` columns alongside raw timestamps.

### 7.2 Entity-Relationship Overview (core)

```mermaid
erDiagram
    LOCATIONS ||--o{ SUBLOCATIONS : has
    PRODUCT_CATEGORIES ||--o{ PRODUCTS : groups
    PRODUCTS ||--o{ VENDOR_PRODUCTS : "supplied as"
    VENDORS ||--o{ VENDOR_PRODUCTS : supplies
    PRODUCTS ||--o{ BOM_LINES : "parent of"
    PRODUCTS ||--o{ INVENTORY_LEVELS : stocked
    LOCATIONS ||--o{ INVENTORY_LEVELS : holds
    PRODUCTS ||--o{ INVENTORY_SNAPSHOTS : "history of"
    PRODUCTS ||--o{ INVENTORY_MOVEMENTS : moves

    VENDORS ||--o{ PURCHASE_ORDERS : receives
    PURCHASE_ORDERS ||--o{ PO_LINES : contains
    PO_LINES ||--o{ PO_RECEIPTS : "received via"

    CUSTOMERS ||--o{ SALES_ORDERS : places
    SALES_ORDERS ||--o{ SO_LINES : contains
    SALES_ORDERS ||--o{ SHIPMENTS : "fulfilled by"
    CARRIERS ||--o{ SHIPMENTS : carries
    SHIPMENTS ||--o{ SHIPMENT_EVENTS : tracks

    PRODUCTS ||--o{ MANUFACTURING_ORDERS : produces
    MANUFACTURING_ORDERS ||--o{ MO_COMPONENTS : consumes
```

### 7.3 `app` Schema — Identity, Configuration, Sync

**`app.users`**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| idp_subject | text UNIQUE | OIDC `sub` |
| email | citext UNIQUE | |
| display_name | text | |
| role | enum `admin, executive, ops_manager, planner, inventory_lead, counter, viewer` | Primary role |
| is_active | boolean | |
| last_login_at | timestamptz | |

**`app.user_location_access`** — (user_id FK, location_id FK) composite PK. Empty means all locations.

**`app.integration_connections`**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| provider | enum `inflow, tracking_aggregator` | |
| external_account_id | text | inFlow company ID |
| secret_ref | text | ARN/path in Secrets Manager, never the key itself |
| api_version | text | Pinned inFlow API version |
| status | enum `active, degraded, paused, error` | |
| writeback_enabled | boolean default false | Feature flag for ADR-006 |
| last_success_at | timestamptz | |

**`app.sync_cursors`** — (connection_id, entity) PK, watermark timestamptz, last_cursor text, last_run_id FK.

**`app.sync_runs`**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| connection_id | uuid FK | |
| entity | text | e.g. `purchase_orders` |
| mode | enum `backfill, incremental, reconcile, targeted` | |
| status | enum `running, succeeded, partial, failed` | |
| started_at / finished_at | timestamptz | |
| pages_fetched, records_fetched, records_changed, records_quarantined | int | |
| api_calls, throttled_calls | int | |
| error_summary | text | |

**`app.webhook_inbox`** — id, provider, event_type, external_id, payload jsonb, signature_valid boolean, received_at, processed_at, status. Unique on (provider, provider_event_id) for dedupe.

**`app.audit_log`** — id bigserial, occurred_at, user_id, action, entity_type, entity_id, before jsonb, after jsonb, ip, user_agent. Append-only; the application role has no UPDATE/DELETE grant.

**`app.saved_views`** — id, user_id, page_key, name, filters jsonb, layout jsonb, is_default, is_shared.

**`app.feature_flags`** — key PK, enabled, rollout jsonb.

### 7.4 `raw` Schema — Landing

**`raw.inflow_records`**

| Column | Type | Notes |
|---|---|---|
| entity | text | PK part |
| inflow_id | text | PK part |
| payload | jsonb | Full record including requested includes |
| payload_hash | bytea | SHA-256 for change detection |
| source_modified_at | timestamptz | |
| first_seen_at / last_fetched_at | timestamptz | |
| sync_run_id | uuid FK | |
| normalize_status | enum `pending, ok, quarantined` | |
| normalize_error | text | |

Index on (entity, normalize_status) for the transform queue. Older payload versions are optionally archived to S3 as Parquet (by date) for full history.

**`raw.tracking_events`** — provider, tracking_number, carrier_code, payload jsonb, received_at.

### 7.5 `core` Schema — Operational Model

**Master data**

| Table | Key columns |
|---|---|
| `core.locations` | id, inflow_id, name, type (`warehouse, store, production, virtual`), timezone, is_active |
| `core.sublocations` | id, location_id FK, code (bin), zone, is_countable |
| `core.product_categories` | id, inflow_id, name, parent_id (self FK), path (ltree) |
| `core.products` | id, inflow_id, sku UNIQUE, name, category_id FK, item_type (`stocked, non_stocked, service, assembled/manufactured`), base_uom, standard_cost, avg_cost, list_price, is_active, **abc_class**, **xyz_class**, classification_updated_at, lead_time_days_override, safety_stock_override, source_modified_at |
| `core.vendors` | id, inflow_id, name, code, payment_terms, default_lead_time_days, currency, is_active |
| `core.vendor_products` | vendor_id FK, product_id FK (composite PK), vendor_sku, unit_cost, quoted_lead_time_days, min_order_qty, is_preferred |
| `core.customers` | id, inflow_id, name, type, region, is_active |
| `core.carriers` | id, code UNIQUE, name, scac, tracking_provider_code, is_active |
| `core.carrier_aliases` | alias text PK, carrier_id FK, service_level — maps the free-text carrier/shipping-method values found in inFlow to a canonical carrier |
| `core.bom_lines` | id, parent_product_id FK, component_product_id FK, qty_per, scrap_pct, effective_from/to |

**Inventory**

| Table | Key columns | Notes |
|---|---|---|
| `core.inventory_levels` | product_id, location_id, sublocation_id (PK triple), qty_on_hand, qty_reserved, qty_on_order, qty_available, unit_cost, synced_at | Current state, overwritten each sync |
| `core.inventory_snapshots` | snapshot_date, product_id, location_id (PK), qty_on_hand, qty_reserved, qty_on_order, unit_cost, extended_value | Built nightly by us, since inFlow has no stock history. **Partitioned by month.** |
| `core.inventory_movements` | id, product_id, location_id, sublocation_id, movement_type (`receipt, shipment, adjustment, transfer_in, transfer_out, mo_consume, mo_produce, count_adjust`), qty (signed), unit_cost, occurred_at, business_date, source_doc_type, source_doc_id, reason_code | Unified ledger derived from POs, SOs, MOs, adjustments, and transfers. Partitioned by month. |

**Purchasing**

| Table | Key columns |
|---|---|
| `core.purchase_orders` | id, inflow_id, po_number, vendor_id FK, location_id FK, status (`open, issued, partially_received, received, cancelled, closed`), order_date, **promised_date** (vendor-confirmed), requested_date, currency, subtotal, freight, total, created_by, source_modified_at |
| `core.po_lines` | id, po_id FK, line_no, product_id FK, qty_ordered, unit_cost, line_promised_date, qty_received_total (denormalized) |
| `core.po_receipts` | id, po_id FK, po_line_id FK, product_id FK, location_id, sublocation_id, qty_received, received_at, business_date, inflow_receipt_ref |

**Sales and fulfillment**

| Table | Key columns |
|---|---|
| `core.sales_orders` | id, inflow_id, so_number, customer_id FK, location_id FK, status, order_date, requested_ship_date, promised_ship_date, promised_delivery_date, channel, currency, subtotal, discount, freight_charged, total, source_modified_at |
| `core.so_lines` | id, so_id FK, line_no, product_id FK, qty_ordered, qty_shipped_total, unit_price, discount, unit_cost_at_sale |
| `core.shipments` | id, so_id FK, carrier_id FK (nullable until mapped), carrier_raw text, service_level, tracking_number, shipped_at, ship_business_date, promised_delivery_at, **delivered_at**, delivery_source (`tracking_api, manual, inferred`), freight_cost, weight, packages, status (`label_created, in_transit, delivered, exception, returned`), last_tracking_sync_at |
| `core.shipment_lines` | shipment_id FK, so_line_id FK, qty_shipped |
| `core.shipment_events` | id, shipment_id FK, status, description, occurred_at, location_text, is_exception, exception_code |

**Manufacturing**

| Table | Key columns |
|---|---|
| `core.manufacturing_orders` | id, inflow_id, mo_number, product_id FK, location_id FK, status (`planned, released, in_progress, completed, cancelled`), qty_planned, qty_completed, start_date, due_date, completed_at, labor_cost, overhead_cost |
| `core.mo_components` | id, mo_id FK, component_product_id FK, qty_required, qty_consumed, unit_cost |

**Key indexes:** `(vendor_id, order_date)` on POs; `(customer_id, order_date)` and `(location_id, order_date)` on SOs; `(product_id, business_date)` on movements; `(carrier_id, ship_business_date)` on shipments; `(due_date, status)` on MOs; and GIN on `raw.payload` only for debugging paths.

### 7.6 `analytics` Schema — Derived Facts

**`analytics.dim_date`** — date PK, iso_week, fiscal_week, fiscal_month, fiscal_quarter, fiscal_year, is_business_day, holiday_name. This drives the fiscal calendar (4-4-5 or calendar months, configured).

**`analytics.kpi_definitions`**

| Column | Type | Notes |
|---|---|---|
| code | text PK | e.g. `inventory_turns` |
| name, description | text | Plain-English definition shown in UI |
| domain | enum `inventory, sales, fulfillment, purchasing, manufacturing, forecasting, counts` | |
| unit | enum `currency, percent, ratio, days, count, quantity` | |
| direction | enum `higher_is_better, lower_is_better, target_band` | Drives coloring |
| grains | text[] | `{day, week, month, quarter}` |
| dimensions | text[] | `{company, location, category, vendor, carrier, customer}` |
| calc_version | int | Bumped when logic changes, which triggers a backfill |
| owner_user_id | uuid FK | Accountable executive |
| is_active | boolean | |

**`analytics.kpi_targets`** — id, kpi_code FK, dimension_type, dimension_id (nullable = company), effective_from, effective_to, target_value, warning_threshold, critical_threshold, set_by, set_at.

**`analytics.kpi_values`** — Main read model for dashboards

| Column | Type | Notes |
|---|---|---|
| kpi_code | text | PK part |
| grain | enum | PK part |
| period_start | date | PK part |
| dimension_type | text | PK part (`company`, `location`, ...) |
| dimension_id | uuid | PK part (all-zero UUID for company) |
| value | numeric | |
| numerator / denominator | numeric | Auditable composition, enables correct roll-ups |
| sample_size | int | |
| is_final | boolean | False for the current open period |
| calc_version | int | |
| computed_at | timestamptz | |

Partitioned by `grain`, with BRIN on `period_start`.

**`analytics.kpi_annotations`** — id, kpi_code, period_start, dimension_type/id, note, author_id, created_at (for example "Port strike delayed inbound").

**Forecasting**

| Table | Key columns |
|---|---|
| `analytics.forecast_runs` | id, trigger (`scheduled, manual, backfill`), grain (`week`), horizon_periods, history_start, data_cutoff_date, model_candidates text[], status, started_at, finished_at, series_count, params jsonb, initiated_by |
| `analytics.forecast_series` | run_id FK, product_id, location_id (PK triple), demand_class (`smooth, erratic, intermittent, lumpy, new, inactive`), selected_model, backtest_wape, backtest_bias, backtest_mase, history_periods, is_low_confidence |
| `analytics.forecasts` | run_id, product_id, location_id, period_start (PK), qty_p10, qty_p50, qty_p90, model_name. Partitioned by run month |
| `analytics.forecast_published` | product_id, location_id, period_start (PK), run_id, qty_final (after overrides), qty_statistical, override_id — the **current consensus forecast** read by the UI |
| `analytics.forecast_accuracy` | product_id, location_id, period_start, lag_periods (PK), forecast_run_id, forecast_qty, actual_qty, abs_error, error — enables WAPE/bias by lag |
| `analytics.replenishment_recommendations` | run_id, product_id, location_id (PK), on_hand, on_order, avg_daily_demand, demand_std, lead_time_days, lead_time_std, service_level_target, safety_stock, reorder_point, eoq, suggested_order_qty, suggested_order_date, preferred_vendor_id, projected_stockout_date, days_of_cover, status (`new, reviewed, exported, dismissed`) |

**Scorecards**

| Table | Key columns |
|---|---|
| `analytics.scorecard_templates` | id, subject_type (`vendor, carrier`), name, version, is_default, period_type (`month, quarter`), min_sample_size, grade_scale jsonb (for example A ≥ 90, B ≥ 80…) |
| `analytics.scorecard_template_metrics` | template_id, metric_code (PK pair), weight (sum = 100), target_value, floor_value, scoring_method (`linear, step, inverse_linear`), is_required |
| `analytics.scorecard_results` | id, template_id, subject_type, subject_id, period_start, period_end, overall_score, grade, rank, rank_of, trend_delta, sample_size, is_provisional, computed_at. Unique (template_id, subject_id, period_start) |
| `analytics.scorecard_metric_results` | result_id FK, metric_code (PK pair), raw_value, numerator, denominator, normalized_score (0–100), weighted_score, sample_size |

### 7.7 `ops` Schema — Workflows Owned by the Dashboard

**Cycle counting**

| Table | Key columns |
|---|---|
| `ops.count_policies` | id, location_id (nullable = default), abc_class, counts_per_year, tolerance_qty, tolerance_pct, tolerance_value, requires_recount_above_tolerance, is_active |
| `ops.count_calendars` | id, location_id, working_days int[] (ISO DOW), daily_capacity_tasks, daily_capacity_minutes, blackout_dates date[] |
| `ops.count_schedules` | id, location_id, name, period_start, period_end, status (`draft, published, closed`), generation_params jsonb, generated_at, published_by, published_at |
| `ops.count_tasks` | id, schedule_id FK (nullable for ad-hoc), product_id, location_id, sublocation_id, scheduled_date, reason (`abc_cycle, exception_negative_stock, exception_variance_history, exception_high_value_move, adhoc, recount`), priority, assigned_to FK users, status (`planned, assigned, in_progress, submitted, recount_requested, approved, rejected, posted, skipped, cancelled`), system_qty_at_freeze, frozen_at, est_minutes |
| `ops.count_results` | id, task_id FK, attempt_no, counted_qty, counted_by, counted_at, device_id, entry_method (`scan, manual`), system_qty, variance_qty, variance_pct, variance_value, within_tolerance, notes, photo_object_key |
| `ops.count_adjustments` | id, result_id FK UNIQUE, approved_by, approved_at, second_approver (above value threshold), reason_code, adjustment_qty, status (`pending_post, posted, failed, manual`), inflow_reference (idempotency key), inflow_adjustment_id, posted_at, error |

**Supplier quality (not available in inFlow)**

| Table | Key columns |
|---|---|
| `ops.vendor_quality_events` | id, vendor_id, po_id (nullable), product_id, event_type (`defect, damaged, wrong_item, short_ship_undisclosed, late_asn, documentation_error`), qty_affected, cost_impact, severity, occurred_at, reported_by, disposition, notes |
| `ops.carrier_claims` | id, carrier_id, shipment_id, claim_type (`damage, loss, delay`), amount_claimed, amount_recovered, filed_at, resolved_at, status |

**Planner inputs**

| Table | Key columns |
|---|---|
| `ops.forecast_overrides` | id, product_id, location_id, period_start, period_end, override_type (`absolute, percent`), value, reason_code (`promotion, new_customer, lost_customer, supply_constraint, other`), comment, created_by, created_at, expires_at, is_active |
| `ops.scorecard_reviews` | id, scorecard_result_id, reviewer_id, status (`draft, reviewed, shared_with_vendor`), summary, action_items jsonb, reviewed_at |

### 7.8 Alerting

| Table | Key columns |
|---|---|
| `app.alert_rules` | id, name, rule_type (`kpi_threshold, kpi_trend, stockout_risk, late_po, sync_failure, count_variance`), kpi_code, dimension filter jsonb, comparator, threshold, evaluation_grain, cooldown_minutes, channels text[] (`in_app, email, teams, slack`), recipients jsonb, is_active, owner_id |
| `app.alert_events` | id, rule_id, triggered_at, context jsonb (value, dimension, link), severity, status (`open, acknowledged, resolved, suppressed`), acknowledged_by, acknowledged_at |
| `app.digest_subscriptions` | user_id, digest_type (`daily_exec, weekly_ops, monthly_scorecards`), channel, send_time_local, is_active |

### 7.9 Data Retention

| Data | Retention |
|---|---|
| raw payloads (latest) | Indefinite. Prior versions go to S3 Parquet for 7 years. |
| core | Indefinite (soft-deleted rows retained) |
| inventory_snapshots, movements | 7 years, monthly partitions |
| forecasts (non-published runs) | 18 months, then dropped by partition |
| audit_log | 7 years |
| sync_runs | 13 months |

---

## 8. Functional Module Design

### 8.1 KPI Engine

**Starter KPI catalog** (finalized with executives in Phase 0):

| Domain | KPI | Definition (summary) | Direction |
|---|---|---|---|
| Inventory | Inventory Value | Σ on-hand qty × unit cost at period end | Target band |
| Inventory | Inventory Turns | Annualized COGS ÷ average inventory value | Higher |
| Inventory | Days of Inventory on Hand | Avg inventory value ÷ (COGS ÷ days in period) | Lower (target band) |
| Inventory | Excess & Obsolete % | Value of SKUs with no movement in 180 days or cover > 365 days ÷ total value | Lower |
| Inventory | Stockout Rate | % of active stocked SKU-locations with available ≤ 0 (daily avg) | Lower |
| Inventory | Inventory Record Accuracy (IRA) | % of count results within tolerance | Higher |
| Sales | Revenue / Gross Margin % | Shipped revenue; (revenue − COGS) ÷ revenue | Higher |
| Sales | Backlog Value | Open SO value not yet shipped | Target band |
| Fulfillment | Order Fill Rate | Units shipped complete on first shipment ÷ units ordered | Higher |
| Fulfillment | OTIF (customer) | Orders shipped in full by promised ship date ÷ orders due | Higher |
| Fulfillment | Order Cycle Time | Median hours from order to ship | Lower |
| Purchasing | Vendor OTIF | PO lines received in full by promised date ÷ lines due | Higher |
| Purchasing | Purchase Price Variance | Σ (actual − standard/last cost) × qty | Lower |
| Purchasing | Open PO Value / Past-Due POs | Value and count of POs past promised date | Lower |
| Manufacturing | MO Schedule Adherence | MOs completed by due date ÷ MOs due | Higher |
| Manufacturing | Production Yield | Qty completed ÷ qty planned (completed MOs) | Higher |
| Manufacturing | Throughput | Units produced per period | Higher |
| Manufacturing | WIP Value | Component value consumed in open MOs | Target band |
| Forecasting | Forecast Accuracy (1 − WAPE) / Bias | At lag 1 and lag 4 weeks | Higher / ≈0 |

**Computation model**

- Each KPI is a server-side **KPI calculator** registered by code. It declares its source tables, supported grains and dimensions, and a SQL query template that produces `(period_start, dimension_id, numerator, denominator, sample_size)`.
- **Triggers:** (a) after each sync, recompute open periods for affected domains; (b) nightly, finalize yesterday and recompute the trailing 35 days to catch late edits; (c) on `calc_version` bump or target change, backfill the full history.
- **Roll-ups** use numerator and denominator (never average-of-averages).
- **Comparisons:** prior period, same period last year, and target, all computed at read time from `kpi_values`.

### 8.2 Forecasting

**Scope:** Weekly demand per SKU × location, horizon of 26 weeks, refreshed weekly (Sunday night) and on demand.

**Pipeline**

1. **Build demand history.** Shipped quantity by requested-ship week (so we capture *demand*, not constrained supply) from `so_lines`/`shipments`, plus **dependent demand** from MO component requirements for manufactured items' components. Stockout weeks are flagged and imputed so lost sales don't bias the forecast downward.
2. **Classify each series** (Syntetos–Boylan ADI/CV²): smooth, erratic, intermittent, lumpy; also new (< 13 weeks of history) and inactive.
3. **Candidate models by class:**
   - Smooth/erratic: AutoETS, AutoARIMA, seasonal naive, and Theta.
   - Intermittent/lumpy: Croston (SBA), TSB, and ADIDA.
   - New: category-level profile scaled by available history, flagged low-confidence.
4. **Backtest** using a rolling origin (3 folds × 8 weeks). Select per series by lowest WAPE with a bias guardrail.
5. **Fit and predict** p10/p50/p90 (conformal intervals where the model has no native intervals).
6. **Apply overrides** from `ops.forecast_overrides` and write `forecast_published`.
7. **Replenishment calculation:**
   - Safety stock = z(service level by ABC class) × √(LT × σ_d² + d̄² × σ_LT²)
   - Reorder point = d̄ × LT + safety stock
   - Suggested order quantity = max(EOQ, MOQ) rounded to pack size when inventory position ≤ ROP
   - Projected stockout date from an on-hand + on-order − forecast projection.
   - Lead-time mean and σ come from **actual PO receipt history** (shared with the vendor scorecard), falling back to the quoted lead time.
8. **Accuracy tracking.** When actuals land, write `forecast_accuracy` at lags 1, 4, and 8. This feeds the Forecast Accuracy KPI.

**Execution:** The API enqueues `forecast:run`. The Python worker reads its inputs via SQL, processes series in parallel chunks of about 2,000, writes results in bulk (COPY), and reports progress to the job record so the UI can show a progress bar.

### 8.3 Cycle Count Scheduling

**ABC classification** (monthly job, or on demand):

- Rank SKUs by trailing-12-month **annual usage value** (units consumed or shipped × cost). A = top ~80% of value, B = next ~15%, C = remainder (configurable). Optional overrides: force A for high-theft or regulated items.
- XYZ (demand variability) is calculated for forecasting and display.

**Schedule generation algorithm**

1. **Inputs:** location, period (for example the next quarter), policies (A = 12×/year, B = 4×, C = 1×), working calendar, daily capacity (tasks or minutes), and blackout dates.
2. **Required counts** for each SKU-sublocation = counts_per_year × (period length ÷ 365), minus counts already completed in the cycle.
3. **Spread evenly:** Target interval = period ÷ required counts. Assign each count to the working day nearest its ideal date, then balance load using a greedy fill that respects capacity, keeps the same sublocations/zones on the same day (to cut travel), and avoids counting a SKU with open picks or receipts scheduled that day where that is known.
4. **Exception counts** are injected daily: negative on-hand, last count out of tolerance, large unexplained adjustments, high-value SKUs with movement since the last count, and "zero on-hand but open SO".
5. Output is a **draft schedule** that a planner can preview, edit (drag tasks between days), and **publish**. Publishing creates `count_tasks`.

**Execution workflow**

- **Freeze:** When a counter opens a task, the system captures `system_qty_at_freeze` from the latest inventory level. The counter **does not see** the system quantity (blind count).
- **Enter:** The counter scans the bin and SKU and enters a quantity. Offline-capable PWA entries queue locally and sync when connectivity returns.
- **Evaluate:** Variance is checked against the policy tolerance (qty, %, or value). Out of tolerance triggers an automatic recount request to a *different* counter where possible.
- **Approve:** An inventory lead approves. Adjustments above the value threshold require a second approver.
- **Post:** If write-back is enabled, a worker posts the adjustment to inFlow with an idempotency reference. Otherwise it's marked "manual" with a printable adjustment list.
- **Measure:** IRA by ABC class, location, and counter, along with adjustment value (shrink) trend.

### 8.4 Vendor Scorecards

**Default template** (weights editable per template version):

| Metric | Calculation | Default weight | Source |
|---|---|---|---|
| On-Time Delivery | PO lines whose first receipt is ≤ promised date (+ grace days) ÷ lines due in period | 30 | PO lines and receipts |
| In-Full Rate | Lines received ≥ 98% of ordered qty (configurable) ÷ lines closed | 20 | PO lines and receipts |
| Lead-Time Reliability | 100 − normalized σ of (actual − quoted lead time) | 15 | POs, vendor_products |
| Price Variance | Σ (invoice/PO cost − standard or contract cost) × qty ÷ spend | 15 | PO lines, product costs |
| Quality | 1 − (qty affected by quality events ÷ qty received) | 20 | ops.vendor_quality_events |

Additional display-only metrics: spend, PO count, average lead time, and late-PO aging.

**Scoring:** Each metric is normalized to 0–100 between `floor_value` and `target_value` (linear by default). The overall score is the weighted sum, mapped to a letter grade. Vendors below `min_sample_size` POs in the period are shown as "Insufficient data" rather than scored. Results are recomputed after relevant syncs while a period is open, and locked (`is_provisional = false`) N days after period close.

### 8.5 Carrier Scorecards

**Data assembly:**

1. Shipments come from inFlow SO fulfillment (carrier/shipping method text, tracking number, ship date, freight cost).
2. **Carrier mapping:** Free-text carrier values are mapped via `core.carrier_aliases`. Unmapped values land in an Admin queue.
3. **Tracking enrichment:** A worker registers new tracking numbers with the aggregator and ingests webhook events into `shipment_events`. It sets `delivered_at`, exceptions, and promised delivery (carrier ETA or service-level standard).

**Default template:**

| Metric | Calculation | Default weight |
|---|---|---|
| On-Time Delivery | Delivered ≤ promised delivery date ÷ delivered shipments | 35 |
| Transit-Time Reliability | % within ±1 day of the service-level standard; σ of transit days | 15 |
| Damage / Claims Rate | Claims (damage + loss) ÷ shipments | 20 |
| Cost Efficiency | Freight cost per shipment (or per lb) vs. target, and vs. other carriers for the same lane/service | 20 |
| Tracking Compliance | Shipments with valid tracking and first scan within 24h of ship ÷ shipments | 10 |

Breakdowns by service level, origin location, and destination region.

---

## 9. Backend Module and API Design

### 9.1 Module Structure (NestJS modular monolith)

```
apps/
  web/                    Next.js frontend (dashboards + counter PWA)
  api/                    NestJS HTTP API
  worker/                 BullMQ job processors (same domain packages as api)
  forecaster/             Python forecasting worker
packages/
  domain-integration/     inFlow client, rate limiter, sync orchestration, normalizers
  domain-kpi/             KPI registry, calculators, targets
  domain-forecasting/     job contracts, override logic, replenishment reads
  domain-cycle-count/     ABC classifier, schedule generator, count workflow state machine
  domain-scorecard/       metric calculators, template scoring engine
  domain-alerting/        rule evaluation, notification adapters
  db/                     Drizzle schema, migrations, query helpers
  contracts/              Zod schemas shared by web and api (request/response DTOs)
  ui/                     Shared React components, chart wrappers, design tokens
  config/                 eslint, tsconfig, boundary rules
infra/                    Terraform
docs/                     This document, ADRs, KPI dictionary, runbooks
```

*(This is a directory layout to guide implementation, not code.)*

### 9.2 REST API Surface (v1)

All routes are prefixed `/api/v1`. Responses include `dataAsOf`. Lists support cursor pagination, sorting, and the shared filter set (`from`, `to`, `grain`, `locationIds`, `categoryIds`, `compare`).

| Area | Endpoint | Purpose |
|---|---|---|
| Session | `GET /me` | Profile, role, permissions, location scope |
| KPIs | `GET /kpis/definitions` | Catalog with definitions and owners |
| | `GET /kpis/overview` | Executive tile set: value, comparison, target status, sparkline |
| | `GET /kpis/{code}/series` | Time series by grain and dimension |
| | `GET /kpis/{code}/breakdown` | Values by dimension for a period |
| | `GET /kpis/{code}/contributors` | Underlying documents (drill to source) |
| | `PUT /kpis/{code}/targets` | Set targets *(executive/admin)* |
| | `POST /kpis/{code}/annotations` | Add an annotation |
| Forecasting | `GET /forecasts/summary` | Accuracy, risk counts, last run |
| | `GET /forecasts/items/{productId}` | History + forecast bands + overrides + projection |
| | `POST /forecasts/overrides` / `DELETE /forecasts/overrides/{id}` | Planner overrides |
| | `GET /replenishment/recommendations` | Filterable recommendation list |
| | `PATCH /replenishment/recommendations/{id}` | Mark reviewed/dismissed |
| | `POST /replenishment/export` | CSV/XLSX for inFlow PO import |
| | `POST /forecasts/runs` / `GET /forecasts/runs/{id}` | Trigger a run and track progress |
| Cycle counts | `GET/PUT /cycle-counts/policies` | ABC policies and tolerances |
| | `POST /cycle-counts/classification/run` | Recompute ABC |
| | `POST /cycle-counts/schedules/preview` | Generate a draft (no persistence) |
| | `POST /cycle-counts/schedules` / `POST .../{id}/publish` | Save and publish |
| | `GET /cycle-counts/tasks` | Calendar/list (filter by date, assignee, status) |
| | `POST /cycle-counts/tasks/{id}/start` | Freeze system qty |
| | `POST /cycle-counts/tasks/{id}/results` | Submit a count (idempotent client UUID) |
| | `POST /cycle-counts/results/{id}/approve` / `.../recount` / `.../reject` | Variance workflow |
| | `GET /cycle-counts/accuracy` | IRA metrics |
| Scorecards | `GET /scorecards/{vendor|carrier}` | Leaderboard for a period |
| | `GET /scorecards/{vendor|carrier}/{id}` | Detail, metric breakdown, and trend |
| | `GET /scorecards/{vendor|carrier}/{id}/evidence` | Underlying POs/shipments for a metric |
| | `POST /scorecards/{vendor|carrier}/{id}/export` | PDF generation (async) |
| | `POST /quality-events`, `POST /carrier-claims` | Manual data capture |
| | `GET/PUT /scorecards/templates/{id}` | Template weights and targets *(admin)* |
| Alerts | `GET/POST/PUT /alerts/rules`, `GET /alerts/events`, `POST /alerts/events/{id}/ack` | |
| Admin | `GET /admin/integration`, `PUT /admin/integration` | inFlow connection settings |
| | `GET /admin/sync/runs`, `POST /admin/sync/{entity}` | Sync monitoring and manual trigger |
| | `GET /admin/carrier-aliases/unmapped`, `PUT /admin/carrier-aliases` | Carrier mapping |
| | `GET/POST/PATCH /admin/users` | User and role management |
| | `GET /admin/audit` | Audit log search |
| Webhooks | `POST /webhooks/inflow`, `POST /webhooks/tracking` | Signature-verified, enqueue-only |

### 9.3 Background Jobs

| Queue | Job | Schedule / Trigger |
|---|---|---|
| `sync` | `sync:{entity}:incremental` | Every 15 min (business hours), hourly off-hours |
| `sync` | `sync:{entity}:reconcile` | Nightly 01:00 |
| `sync` | `sync:targeted` | Webhook hint |
| `transform` | `normalize:{entity}` | After a sync page batch |
| `snapshot` | `snapshot:inventory` | Nightly 23:55 local |
| `compute` | `kpi:recompute` | After sync; nightly finalize 02:00 |
| `compute` | `scorecard:recompute` | After PO/shipment changes; nightly |
| `compute` | `abc:classify` | Monthly, 1st business day |
| `forecast` | `forecast:run` | Weekly Sun 22:00; manual |
| `tracking` | `tracking:register`, `tracking:poll` | On new shipment; hourly fallback poll |
| `counts` | `counts:exceptions` | Daily 05:00 |
| `writeback` | `inflow:post-adjustment` | On approval (priority lane) |
| `alerts` | `alerts:evaluate` | After KPI recompute; every 15 min |
| `notify` | `digest:send` | Per subscription schedule |
| `export` | `export:pdf`, `export:xlsx` | On demand |

---

## 10. Frontend Component Hierarchy

### 10.1 Application Shell and Providers

```
<RootLayout>
├── <AuthProvider>                     OIDC session, token refresh
├── <QueryClientProvider>              TanStack Query cache
├── <ThemeProvider>                    light/dark, brand tokens
├── <PermissionProvider>               role → capability map; <Can> helper
├── <GlobalFilterProvider>             date range, grain, locations, compare mode (URL-synced)
└── <AppShell>
    ├── <TopBar>
    │   ├── <OrgLogo>
    │   ├── <GlobalFilterBar>
    │   │   ├── <DateRangePicker presets="MTD|QTD|YTD|L13W|Custom">
    │   │   ├── <GrainSelect>
    │   │   ├── <LocationMultiSelect>
    │   │   └── <CompareToggle options="prior period|last year|target">
    │   ├── <DataFreshnessBadge>       dataAsOf + sync status popover
    │   ├── <AlertBell>                → <AlertDropdown>
    │   └── <UserMenu>                 profile, saved views, sign out
    ├── <SideNav>                      Executive · KPIs · Forecasting · Cycle Counts · Scorecards · Alerts · Admin
    └── <MainContent>                  route outlet + <ErrorBoundary> + <Suspense>
```

### 10.2 Page Trees

```
/executive  — ExecutiveOverviewPage
├── <PageHeader title actions=[SaveView, Export, Present mode]>
├── <KpiTileGrid>
│   └── <KpiTile> ×N                   value, delta vs compare, target status pill, sparkline
│       └── onClick → <KpiDrilldownDrawer>
│           ├── <KpiTrendChart>       with target band + annotations
│           ├── <DimensionBreakdownBar>
│           └── <ContributorsTable>   links to source docs (deep link to inFlow)
├── <ExceptionsPanel>
│   ├── <StockoutRiskList>            top projected stockouts (from forecasting)
│   ├── <PastDuePOList>
│   ├── <LateShipmentsList>
│   └── <MOBehindScheduleList>
├── <ScorecardSnapshot>
│   ├── <TopBottomVendorsCard>
│   └── <TopBottomCarriersCard>
└── <ForecastVsActualMini>

/kpis/[domain]  — KpiDomainPage (inventory | sales | fulfillment | purchasing | manufacturing)
├── <DomainHeader>
├── <KpiTileGrid filter=domain>
├── <KpiTrendPanel multi-series>
└── <KpiBreakdownTable>               by location / category / vendor / carrier

/kpis/kpi/[code]  — KpiDetailPage
├── <KpiHeader>                       definition popover, owner, calc version
├── <KpiTrendChart>                   target/warning bands, compare overlay
├── <KpiTargetEditor>                 (Can: kpi.targets.edit)
├── <DimensionHeatmap>                location × period
├── <ContributorsTable>
└── <AnnotationsTimeline> + <AddAnnotationDialog>

/forecasting  — ForecastOverviewPage
├── <ForecastRunStatusCard>           last run, next run, Run Now (Can)
├── <AccuracyScorecards>              WAPE, bias by lag / ABC class
├── <StockoutRiskTable>               projected stockout date, days of cover
└── <ReplenishmentRecommendationsTable>
    ├── <RecommendationRow>           ROP, SS, suggested qty, vendor, status
    ├── <BulkActionsBar>              mark reviewed, dismiss, export for inFlow
    └── <ExportDialog>

/forecasting/items/[productId]  — ForecastItemPage
├── <ItemHeader>                      SKU, ABC/XYZ, demand class, low-confidence flag
├── <ForecastChart>                   history, p10–p90 band, p50, overrides, stockout markers
├── <InventoryProjectionChart>        on hand + on order − forecast over horizon
├── <ModelInfoCard>                   selected model, backtest metrics, candidates
├── <OverrideEditor>                  period range, type, value, reason → <OverrideHistory>
└── <ReplenishmentCard>

/forecasting/runs  — <RunHistoryTable> → <RunDetailDrawer>

/cycle-counts  — CycleCountHomePage
├── <CountKpiStrip>                   IRA, tasks due today, overdue, pending approvals
├── <CountCalendar view=month|week>   tasks per day, capacity heat
│   └── <CalendarDayCell> → <DayTaskListPopover>
└── <ScheduleList> → "New schedule" → ScheduleBuilderWizard

ScheduleBuilderWizard  (/cycle-counts/schedules/new)
├── <ScopeStep>                       location, period, zones, include exceptions
├── <PolicyStep>                      ABC frequencies, tolerances, capacity (prefilled)
├── <PreviewStep>
│   ├── <LoadBalanceChart>            tasks/day vs capacity
│   └── <DraggableScheduleGrid>       move tasks between days
└── <PublishStep>                     assignment rules, confirm

/cycle-counts/review  — VarianceReviewPage
├── <VarianceFilters>
├── <VarianceTable>                   system vs counted, variance qty/value, tolerance flag
│   └── <VarianceRowActions>          Approve · Request recount · Reject
├── <ApproveAdjustmentDialog>         reason code, second-approver notice
└── <WritebackStatusPanel>            posted / failed / manual

/cycle-counts/accuracy  — <IraByClassChart>, <IraTrendChart>, <CounterPerformanceTable>, <ShrinkTrendChart>

/count  — CounterPWA (mobile-first, minimal chrome)
├── <CounterHeader>                   location, online/offline indicator, sync queue count
├── <MyTasksQueue>                    sorted by bin path
└── <CountEntryScreen>
    ├── <BinScanInput>
    ├── <SkuScanInput>                with product image/description confirm
    ├── <QuantityKeypad>              UoM aware; system qty hidden (blind)
    ├── <PhotoCapture optional>
    └── <SubmitButton>                queues offline via IndexedDB

/scorecards/vendors  — VendorLeaderboardPage   (carriers page mirrors this)
├── <ScorecardPeriodPicker>
├── <TemplateSelect>
├── <ScoreDistributionChart>
└── <LeaderboardTable>                rank, grade badge, score, trend arrow, sample size

/scorecards/vendors/[id]  — VendorScorecardDetailPage
├── <ScorecardHeader>                 grade, overall score, rank, trend
├── <MetricBreakdownGrid>
│   └── <MetricScoreCard> ×N          raw value, normalized score, weight, target
├── <MetricTrendCharts>
├── <EvidenceTable tabbed by metric>  POs/lines/receipts or shipments behind each metric
├── <QualityEventLog> + <QualityEventForm>     (carrier page: <ClaimsLog> + <ClaimForm>)
├── <ReviewNotesPanel>                summary, action items, status
└── <ExportPdfButton>

/alerts  — <AlertRuleList>, <AlertRuleEditor>, <AlertHistoryTable>

/admin
├── /integration   <InflowConnectionCard>, <SyncStatusTable>, <SyncRunLog>, <TriggerSyncButton>, <ReconciliationReport>
├── /mappings      <UnmappedCarrierQueue>, <CarrierAliasEditor>
├── /users         <UserTable>, <InviteUserDialog>, <RoleSelect>, <LocationAccessEditor>
├── /kpis          <KpiCatalogEditor> (descriptions, owners, active flag)
├── /scorecards    <ScorecardTemplateEditor> (weights must total 100)
├── /counts        <CountPolicyEditor>, <CountCalendarEditor>
├── /flags         <FeatureFlagToggles> (incl. inFlow write-back)
└── /audit         <AuditLogViewer>
```

### 10.3 Shared UI Library (`packages/ui`)

- **Data display:** `KpiTile`, `StatusPill`, `GradeBadge`, `TrendArrow`, `Sparkline`, `DataTable` (virtualized, column chooser, CSV export), `EmptyState`, `Skeleton`.
- **Charts** (ECharts wrappers with a consistent theme): `TimeSeriesChart` (bands, annotations, compare overlay), `BarBreakdown`, `Heatmap`, `CalendarHeat`, `Gauge`, `DistributionChart`.
- **Inputs:** `DateRangePicker`, `EntityMultiSelect` (async search for SKUs/vendors), `ScanInput` (keyboard-wedge and camera barcode), `NumericKeypad`.
- **Feedback:** `Toast`, `ConfirmDialog`, `JobProgress` (polls async job status).
- **Access:** `<Can permission="...">`, which hides or disables controls based on role.

### 10.4 State Management Principles

- **Server state** lives in TanStack Query, with query keys built from the global filter state. There is no global client store for server data.
- **Filter state** lives in the URL so every view is shareable and bookmarkable. Saved views persist filters server-side.
- **Counter PWA** keeps an offline queue in IndexedDB, uses client-generated UUIDs for idempotent submissions, and replays in the background.

---

## 11. User Flows

### 11.1 Admin: Connect inFlow and Initial Backfill

```mermaid
flowchart TD
    A[Admin signs in via SSO] --> B[Admin → Integration]
    B --> C[Enter inFlow Company ID + API key]
    C --> D{Validate with test call}
    D -- fail --> C1[Show error: auth / permissions / plan] --> C
    D -- ok --> E[Store key in Secrets Manager<br/>save connection]
    E --> F[Start initial backfill]
    F --> G[Progress view per entity<br/>records, pages, ETA, throttling]
    G --> H{Backfill complete?}
    H -- errors --> I[Review quarantined records<br/>retry entity] --> G
    H -- yes --> J[Run reconciliation report<br/>counts & stock totals vs inFlow]
    J --> K[Map unmapped carriers]
    K --> L[Review ABC classification + KPI targets]
    L --> M[Enable incremental schedule<br/>invite users]
```

### 11.2 Executive: Daily Review and Drill-Down

```mermaid
sequenceDiagram
    actor E as Executive
    participant UI as Web App
    participant API
    participant DB as Postgres

    E->>UI: Opens /executive (from daily digest link or bookmark)
    UI->>API: GET /kpis/overview?range=MTD&compare=last_year
    API->>DB: read analytics.kpi_values (+ Redis cache)
    API-->>UI: tiles + dataAsOf
    UI-->>E: KPI tiles (OTIF red vs target)
    E->>UI: Clicks OTIF tile
    UI->>API: GET /kpis/otif/series, /breakdown?dim=location
    API-->>UI: trend + breakdown
    UI-->>E: Drawer: Location B driving the miss
    E->>UI: Clicks Location B bar
    UI->>API: GET /kpis/otif/contributors?location=B
    API-->>UI: late orders list
    E->>UI: Adds annotation "Short-staffed week 39", shares view URL with Ops
```

### 11.3 Planner: Forecast Review, Override, and Replenishment

```mermaid
flowchart TD
    A[Weekly forecast run completes Sunday night] --> B[Planner opens /forecasting]
    B --> C[Stockout Risk table sorted by days of cover]
    C --> D[Open SKU detail]
    D --> E{Forecast reasonable?}
    E -- no: known promo or new customer --> F[Add override with reason & expiry]
    F --> G[Published forecast + projection recalculated]
    E -- yes --> H[Review replenishment card<br/>ROP, safety stock, suggested qty]
    G --> H
    H --> I{Act?}
    I -- order --> J[Select recommendations → Export for inFlow PO import<br/>or open item in inFlow]
    I -- dismiss --> K[Dismiss with reason]
    J & K --> L[Status recorded; accuracy tracked as actuals arrive]
```

### 11.4 Inventory Lead and Counter: Cycle Count Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Planned: Schedule published
    Planned --> Assigned: Auto/manual assignment
    Assigned --> InProgress: Counter opens task (system qty frozen, hidden)
    InProgress --> Submitted: Count entered (scan + qty)
    Submitted --> Approved: Within tolerance (auto) or lead approves
    Submitted --> RecountRequested: Out of tolerance
    RecountRequested --> InProgress: Recount by different counter
    Submitted --> Rejected: Lead rejects (data error)
    Approved --> Posted: Write-back to inFlow succeeds
    Approved --> ManualPost: Write-back disabled / failed → manual list
    Posted --> [*]
    ManualPost --> [*]
    Planned --> Skipped: Blackout / cancelled with reason
    Skipped --> [*]
```

```mermaid
flowchart LR
    subgraph Plan [Inventory Lead — weekly/quarterly]
        P1[Review ABC classes & policies] --> P2[Schedule Builder: scope, period, capacity]
        P2 --> P3[Preview load-balanced calendar<br/>drag to adjust] --> P4[Publish]
    end
    subgraph Execute [Counter — daily, mobile]
        E1[Open /count, see today's queue by bin path] --> E2[Scan bin → scan SKU → enter qty]
        E2 --> E3[Submit — works offline, syncs later]
    end
    subgraph Review [Inventory Lead — daily]
        R1[Variance Review queue] --> R2{Within tolerance?}
        R2 -- yes --> R3[Bulk approve]
        R2 -- no --> R4[Recount or investigate<br/>check recent movements]
        R3 & R4 --> R5[Approve adjustment<br/>2nd approver if > $ threshold]
        R5 --> R6[Post to inFlow / manual list]
    end
    P4 --> E1
    E3 --> R1
    R6 --> M[IRA KPI & shrink trend update]
```

### 11.5 Purchasing Manager: Monthly Vendor Scorecard Review

```mermaid
flowchart TD
    A[Period closes; scorecards locked after N days] --> B[Monthly digest: bottom 5 vendors]
    B --> C[Open Vendor Leaderboard]
    C --> D[Select vendor → detail]
    D --> E[Inspect low metric e.g. On-Time 72%]
    E --> F[Evidence tab: late PO lines with promised vs received dates]
    F --> G{Data issue?}
    G -- yes: wrong promised date in inFlow --> H[Fix in inFlow → next sync recomputes]
    G -- no --> I[Log quality events if any<br/>write review summary + action items]
    I --> J[Export PDF → share with vendor]
    J --> K[Status: shared_with_vendor; trend tracked next period]
```

### 11.6 Alert Lifecycle

```mermaid
sequenceDiagram
    participant W as KPI Worker
    participant A as Alert Evaluator
    participant N as Notifier
    actor U as Owner

    W->>A: kpi:recomputed (stockout_rate, Location A)
    A->>A: evaluate rules (threshold, cooldown, dedupe)
    A->>N: alert_event created (severity=critical)
    N-->>U: Email / Teams + in-app bell
    U->>N: Click link → KPI detail with context
    U->>A: Acknowledge (optionally annotate)
    A->>A: Auto-resolve when value returns within threshold
```

---

## 12. Security, Access Control, and Audit

### 12.1 Authentication

- OIDC SSO with the corporate IdP. MFA is enforced at the IdP.
- Short-lived access tokens (15 min) with refresh. The API validates JWT signature, audience, and issuer.
- Counter devices: same SSO, with an optional long-lived "device session" on shared warehouse tablets that is restricted to the `counter` role and location.

### 12.2 Role-Based Access Control

| Capability | Admin | Executive | Ops Mgr | Planner | Inv. Lead | Counter | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View executive & KPI pages | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Set KPI targets / annotate | ✓ | ✓ | annotate | – | – | – | – |
| View forecasts | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Override forecasts, run forecast | ✓ | – | – | ✓ | – | – | – |
| Manage replenishment recs | ✓ | – | ✓ | ✓ | – | – | – |
| Build/publish count schedules | ✓ | – | ✓ | – | ✓ | – | – |
| Enter counts | ✓ | – | – | – | ✓ | ✓ | – |
| Approve variances | ✓ | – | ✓ | – | ✓ | – | – |
| View scorecards | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| Log quality events / claims, review scorecards | ✓ | – | ✓ | ✓ | – | – | – |
| Edit templates, policies, users, integration, flags | ✓ | – | – | – | – | – | – |

Row-level scoping by `user_location_access` is applied in the query layer for every location-dimensioned read.

### 12.3 Data Protection

- TLS 1.2+ everywhere. RDS, S3, and Redis are encrypted at rest (KMS).
- The inFlow API key and tracking keys live only in Secrets Manager and are read by workers at runtime. Keys are rotatable without a deploy.
- Webhooks: HMAC signature verification, timestamp tolerance, and replay protection via `webhook_inbox` uniqueness.
- Principle of least privilege: separate DB roles for the API (no DDL), workers, migrations, and a read-only reporting role.
- OWASP ASVS L2 controls: CSRF protection for cookie sessions, strict CSP, input validation via shared Zod contracts, rate limiting on the API.
- **Audit log** for all writes: targets, overrides, policies, approvals, write-backs, user and role changes, and integration settings.

---

## 13. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Performance | Dashboard API p95 < 500 ms for KPI reads; page interactive < 2 s p95; forecast run for 50k series < 30 min |
| Freshness | Operational entities ≤ 15–30 min stale in business hours; KPIs for prior day final by 06:00 local |
| Availability | 99.5% monthly for the web/API (business-critical but not transactional). Sync can tolerate hours of inFlow outage with automatic catch-up. |
| Scalability | Designed for 50k SKUs × 10 locations, 1M order lines/year without architecture change |
| Backup / DR | RDS automated backups + PITR (7–35 days); daily snapshot copied cross-region; RPO 15 min, RTO 4 h. Raw payloads allow rebuild of core and analytics. |
| Observability | Traces across API → queue → worker → inFlow; metrics for sync lag per entity, API throttle rate, job failures, KPI compute duration; dashboards and paging on sync lag > 2 h or DLQ growth |
| Accessibility | WCAG 2.1 AA; color-blind-safe status palette (icons + color); keyboard navigable |
| Browser support | Latest two versions of Chrome, Edge, Safari, Firefox; counter PWA on iOS Safari and Android Chrome |
| Localization | Single locale and currency at launch; currency and timezone are stored, not assumed |

---

## 14. Testing Strategy

| Level | Approach |
|---|---|
| Unit | KPI calculators, scoring normalization, ABC classifier, schedule generator (property-based tests: capacity never exceeded, frequency targets met), variance/tolerance logic, replenishment math |
| Contract | Recorded inFlow API fixtures (sanitized) validate normalizers; Zod contracts shared across web/API; a nightly canary against the live API in staging detects schema drift |
| Integration | Testcontainers Postgres + Redis; full sync → normalize → KPI pipeline on a fixture company |
| Data quality | Automated checks after each sync: row counts vs inFlow, FK orphans, negative quantities, PO lines without promised date, unmapped carriers. Results go to the admin page. |
| KPI validation | **Golden dataset**: finance/ops-verified expected values for a closed month. CI fails if any KPI deviates. |
| Forecast | Backtest regression: WAPE on a frozen benchmark set must not degrade beyond tolerance on model changes |
| End-to-end | Playwright: executive drill-down, schedule build → count → approve, override → recompute, scorecard export |
| Performance | k6 load tests on KPI endpoints with production-like volumes |
| UAT | Each phase ends with stakeholder UAT against acceptance criteria |

---

## 15. Implementation Plan

**Assumed team:** 1 tech lead/architect, 2 full-stack engineers, 1 data/forecasting engineer (~50%, full-time in Phase 5), 1 product designer (~50%), QA embedded. **Total: about 24–28 weeks** to full rollout, with a usable executive MVP at about week 10.

```mermaid
gantt
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d
    title Delivery Roadmap (indicative)
    section Foundation
    Phase 0 Discovery & Foundations     :p0, 2026-10-12, 2w
    section Data
    Phase 1 inFlow Integration & Data Model :p1, after p0, 4w
    section MVP
    Phase 2 KPI Engine & Executive Dashboard :p2, after p1, 4w
    section Expansion
    Phase 3 Vendor & Carrier Scorecards  :p3, after p2, 3w
    Phase 4 Cycle Count Scheduling       :p4, after p3, 4w
    Phase 5 Forecasting & Replenishment  :p5, after p2, 5w
    section Launch
    Phase 6 Alerts, Hardening & Rollout  :p6, after p4, 3w
```

*Phase 5 runs in parallel with Phases 3–4, staffed by the data/forecasting engineer plus one full-stack engineer for the UI in its later weeks.*

---

### Phase 0 — Discovery and Foundations (2 weeks)

**Objective:** Remove the big unknowns, agree on definitions, and stand up the skeleton.

1. **inFlow API spike.** With a test company and API key, confirm the authentication, versioning header, pagination, modified-since filtering, `include` expansions, rate limits, webhook availability, and the write endpoint for stock adjustments/counts. Document the actual entity coverage against §6.2 and update assumptions A2–A4.
2. **Data audit.** Pull a sample of POs, SOs, and MOs. Measure how often promised dates, carrier fields, tracking numbers, and costs are populated. Produce a **data readiness report** (for example, "38% of POs lack a vendor-promised date"), which sets expectations and process changes.
3. **KPI definition workshop** with executives. Finalize the catalog (§8.1), formulas, owners, targets, fiscal calendar, and timezone. Sign off on the **KPI Dictionary** (`docs/kpi-dictionary.md`).
4. **Scorecard and cycle-count policy workshop.** Set metric weights, grace days, tolerances, ABC frequencies, approval thresholds, and counting capacity per location.
5. **Choose a tracking aggregator** (EasyPost, ShipEngine, or AfterShip) based on carrier coverage and cost.
6. **Repo and platform skeleton.** Monorepo, lint/format/typecheck, CI pipeline, Terraform for dev/staging (VPC, RDS, Redis, ECS, S3, Secrets Manager), and a hello-world deploy of web + api + worker.
7. **SSO integration** with the corporate IdP. Base RBAC roles.
8. **Design system and wireframes.** Low-fidelity wireframes for the Executive Overview, KPI detail, scorecard detail, and counter PWA, validated with 2–3 target users.

**Deliverables:** API spike report, data readiness report, signed-off KPI dictionary, policy decisions, ADRs 001–007 ratified, deployed skeleton with SSO.
**Exit criteria:** No unresolved blocker on API coverage; stakeholders have approved KPI definitions; CI/CD deploys to staging on merge.

---

### Phase 1 — inFlow Integration and Core Data Model (4 weeks)

**Objective:** A reliable, observable pipeline that mirrors inFlow into `raw` and `core` and builds history.

1. Implement `app`, `raw`, and `core` schema migrations (§7.3–7.5) and `analytics.dim_date` with the fiscal calendar.
2. Build the **inFlow API client**: auth, versioned headers, pagination, typed responses, error taxonomy.
3. Build the **Redis token-bucket rate limiter** with priority lanes, retries/backoff, circuit breaker, and DLQ.
4. Build the **sync orchestrator**: per-entity jobs, dependency ordering, resumable backfill with page checkpoints, incremental watermarks with overlap.
5. Write **normalizers** for each entity (raw → core): Zod validation, FK resolution, soft deletes, quarantine path.
6. Build the **inventory movement ledger** derivation from receipts, shipments, MOs, adjustments, and transfers.
7. Add the **nightly inventory snapshot** job and the **nightly reconciliation** job with a report.
8. Add the webhook receiver (if supported) as targeted-fetch hints.
9. Build the **Admin → Integration UI**: connection setup, sync status per entity, run log, manual trigger, quarantined records, reconciliation report.
10. Run **data quality checks** after each sync and surface them in admin.
11. Execute the **production backfill** in staging against the real company (read-only) and validate totals with ops/finance.

**Deliverables:** Running sync in staging with full history; admin integration pages; data quality dashboard.
**Exit criteria:** Reconciliation shows ≥ 99.9% record parity and stock-on-hand totals matching inFlow per location; incremental lag < 15 min for 5 consecutive business days; zero unhandled DLQ items.

---

### Phase 2 — KPI Engine and Executive Dashboard: MVP (4 weeks)

**Objective:** Executives use the dashboard daily.

1. Add `analytics.kpi_definitions`, `kpi_targets`, `kpi_values`, and `kpi_annotations` migrations. Seed the catalog from the KPI dictionary.
2. Build the **KPI calculator framework** (registry, SQL templates, numerator/denominator, grains, dimensions) and implement the inventory, sales, fulfillment, purchasing, and manufacturing KPIs.
3. Add recompute triggers (post-sync, nightly finalize, backfill on version bump) and a Redis read cache with invalidation on recompute.
4. Build the **golden dataset test** for one closed month, signed off by finance/ops.
5. Implement the KPI API endpoints (§9.2), including contributors/drill-through and the `dataAsOf` contract.
6. Frontend: app shell, global filters (URL-synced), Data Freshness badge, **Executive Overview**, **KPI domain pages**, **KPI detail** with target editor and annotations, and drill-down drawer with deep links to inFlow documents.
7. Add saved views and CSV/XLSX export from tables.
8. Production environment: Terraform prod, backups/PITR, monitoring and alerting on sync lag, Sentry.
9. **Pilot release** to 3–5 executives. Gather feedback for 1 week and iterate.

**Deliverables:** Production MVP with the executive overview and all domain KPIs.
**Exit criteria:** Golden-dataset KPIs match within 0.5%; p95 KPI API < 500 ms; pilot executives confirm the numbers match their expectations (or discrepancies are explained and documented).

---

### Phase 3 — Vendor and Carrier Scorecards (3 weeks)

**Objective:** Objective, evidence-backed supplier and carrier performance management.

1. Add migrations for the scorecard templates, metrics, results, metric results, `ops.vendor_quality_events`, `ops.carrier_claims`, and `ops.scorecard_reviews`.
2. Build the **scoring engine**: metric calculators, normalization methods, weights, grading, minimum sample handling, provisional/locked periods, rank and trend.
3. Implement **vendor metrics** (OTD, in-full, lead-time reliability, PPV, quality).
4. Add **carrier alias mapping** plus an admin queue for unmapped values.
5. Build the **tracking aggregator integration**: register tracking numbers, webhook ingestion, hourly poll fallback, `shipment_events`, and delivered/exception status. Backfill tracking for the trailing 90 days where the provider allows it.
6. Implement **carrier metrics** (OTD, transit reliability, claims rate, cost efficiency, tracking compliance).
7. Frontend: leaderboards, detail pages with metric breakdown and evidence tables, quality event and claims forms, review notes, and the **PDF export**.
8. Add the template editor in admin (weights must sum to 100, versioned).
9. Add the monthly scorecard digest email.

**Deliverables:** Vendor and carrier scorecards in production, with PDF export.
**Exit criteria:** Purchasing has validated 5 vendors' scores against their own records; at least 90% of shipments in the trailing 30 days have delivery status; carriers are fully mapped.

---

### Phase 4 — Cycle Count Scheduling (4 weeks)

**Objective:** Replace ad-hoc counting with a planned, measured program.

1. Add migrations for the `ops.count_*` tables. Seed policies and calendars from the Phase 0 decisions.
2. Build the **ABC/XYZ classification** job with overrides in admin.
3. Build the **schedule generator** (§8.3) with property-based tests, plus the preview API.
4. Add **exception count** detection (daily job).
5. Build the **count workflow state machine** and APIs: start/freeze, submit (idempotent), tolerance evaluation, recount routing, approvals with a second-approver threshold.
6. Frontend: the count calendar, **Schedule Builder wizard** with drag-and-drop preview, variance review, and accuracy dashboard.
7. Build the **Counter PWA**: task queue by bin path, barcode scanning (camera + keyboard wedge), blind entry, offline queue (IndexedDB), and installable manifest.
8. Build the **inFlow write-back** worker for approved adjustments (behind a feature flag): idempotency reference, retry, failure surfacing, plus a manual-post fallback list.
9. Add the IRA KPI into the KPI engine (counts domain).
10. **Pilot** at one location for 2 weeks with write-back **off**, then enable write-back after parallel verification.

**Deliverables:** Cycle count program live at the pilot location; IRA KPI on the executive dashboard.
**Exit criteria:** The generated schedule meets ABC frequency targets within ±5% while never exceeding capacity; offline counts sync without loss in field testing; 20 consecutive write-backs verified in inFlow with no duplicates.

---

### Phase 5 — Forecasting and Replenishment (5 weeks, parallel with Phases 3–4)

**Objective:** Forward-looking demand and stockout visibility with actionable reorder recommendations.

1. Stand up the **Python forecasting worker** (container, queue consumer, DB access, structured logging, progress reporting).
2. Build the **demand history** (requested-ship-week demand, dependent demand via BOM explosion, stockout-week imputation).
3. Build **demand classification** and candidate model sets. Add the **rolling-origin backtest** harness and per-series model selection.
4. Produce **probabilistic output** (p10/p50/p90), bulk-write forecasts, and a forecast series metadata table.
5. Apply **overrides** and build `forecast_published`.
6. Compute **lead-time statistics** from PO receipt history (shared with vendor scorecards).
7. Build the **replenishment engine**: safety stock by ABC service level, ROP, EOQ/MOQ/pack rounding, inventory projection, projected stockout date.
8. Build **forecast accuracy** tracking by lag. Feed the Forecast Accuracy KPI.
9. Frontend: forecast overview, item detail (forecast chart with bands, projection chart, model card, override editor), replenishment table with bulk actions, and **export formatted for inFlow PO import**.
10. Add the weekly scheduled run and the manual run with progress UI.
11. **Validation:** Planners review the top 100 SKUs by value for 2 forecast cycles, compared against their current method.

**Deliverables:** Weekly forecasts, replenishment recommendations, accuracy tracking.
**Exit criteria:** Backtest WAPE for A-class SKUs beats the seasonal-naive baseline by at least 15% (target set with planners in Phase 0); bias within ±5%; a full run completes within the SLA.

---

### Phase 6 — Alerts, Hardening, and Organization-Wide Rollout (3 weeks)

**Objective:** Proactive notifications, production hardening, and adoption.

1. Build the **alerting** engine: rule types, evaluation after recompute, cooldown/dedupe, in-app + email + Teams/Slack adapters, acknowledgment, and auto-resolve.
2. Add **digests**: daily executive summary, weekly ops, and monthly scorecards.
3. **Performance pass:** query plans, indexes, materialized views, cache tuning, and k6 load tests at 2× expected volume.
4. **Security review:** dependency audit, pen test of auth/RBAC and webhooks, secret rotation drill, audit-log completeness check.
5. **DR drill:** restore from PITR into a fresh environment; rebuild analytics from raw.
6. Write **runbooks**: sync lag, inFlow outage, DLQ handling, write-back failure, forecast run failure, KPI backfill.
7. **Training and documentation:** role-based quick guides, the in-app KPI definitions, and a counter training video.
8. **Rollout:** all locations for cycle counts and all user groups. Hypercare for 2 weeks with daily triage.

**Deliverables:** Production-hardened platform, alerts and digests, runbooks, trained users.
**Exit criteria:** All NFRs (§13) met in load and DR tests; no open Sev-1/Sev-2 defects; at least 80% of target users active weekly by the end of hypercare.

---

### Post-Launch Backlog (candidates)

- Promotions and causal factors in forecasting (ML models such as LightGBM with exogenous features).
- Multi-echelon inventory optimization across locations, and transfer recommendations.
- Vendor portal for scorecard sharing and promise-date confirmation.
- Direct PO creation in inFlow from approved recommendations (extends ADR-006 write-back scope).
- Read-only semantic layer for Power BI/Excel.
- Capacity/labor KPIs for manufacturing if routing/labor data becomes available.

---

## 16. Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|:-:|:-:|---|
| R1 | inFlow API lacks an entity or field we need (for example receipt dates per line, MO completion dates, stock adjustment history) | Med | High | Phase 0 spike before committing; fallback to scheduled CSV export ingestion; adjust KPI scope early |
| R2 | API rate limits throttle backfill or freshness | Med | Med | Shared token bucket, hash-based skipping, include-expansions to cut calls, off-hours backfill, adaptive polling intervals |
| R3 | Poor source data quality (missing promised dates, free-text carriers, inconsistent costs) | High | High | Data readiness report in Phase 0; data-quality dashboard; process fixes in inFlow; scorecards show "insufficient data" instead of misleading scores |
| R4 | Executives dispute KPI numbers, eroding trust | Med | High | Signed-off KPI dictionary, golden dataset tests, numerator/denominator transparency, drill-to-document, annotations |
| R5 | Insufficient history for reliable forecasts | Med | Med | Demand classification, low-confidence flags, category-level fallbacks, planner overrides, accuracy tracked visibly |
| R6 | Write-back creates incorrect or duplicate adjustments in inFlow | Low | High | Feature flag, two-step approval, idempotency key, pilot with write-back off, parallel verification, audit log |
| R7 | Counter adoption (warehouse connectivity, device constraints) | Med | Med | Offline-first PWA, scanner support, short training, pilot location feedback |
| R8 | Tracking aggregator coverage or cost for regional/LTL carriers | Med | Med | Choose provider by coverage in Phase 0; manual delivery entry fallback; LTL proof-of-delivery import |
| R9 | inFlow API version changes break sync | Low | Med | Pinned version header, contract tests, nightly staging canary, quarantine path instead of crash |
| R10 | Scope creep toward a full BI tool | Med | Med | Non-goals stated; export and read-only reporting role as a pressure valve |

---

## 17. Open Questions for Stakeholders

1. Which inFlow plan and edition is in use, and is API access enabled? Who owns the API key?
2. How many locations and sublocations (bins), active SKUs, and orders per month are there today?
3. Fiscal calendar: calendar months or 4-4-5? Fiscal year start? Business timezone(s)?
4. Do vendors confirm promised dates, and are they entered on POs in inFlow today?
5. Which carriers are used (parcel vs. LTL vs. own fleet)? Is a shipping platform already in use (ShipStation, etc.) that has delivery data?
6. How are vendor quality issues recorded today (if at all)?
7. Current cycle-count practice: frequency, who counts, devices available (scanners, phones, tablets), Wi-Fi coverage in the warehouse?
8. Should approved count adjustments post to inFlow automatically, or is a manual post preferred initially?
9. What service-level targets (fill rate) should drive safety stock by ABC class?
10. Preferred identity provider for SSO, and preferred cloud (AWS vs. Azure)?
11. Who are the KPI owners, and which 6–8 KPIs belong on the executive overview?
12. Notification channels: email only, or Teams/Slack as well?

---

## 18. Glossary

| Term | Meaning |
|---|---|
| **ABC classification** | Ranking SKUs by annual usage value; A items get the most attention and count frequency |
| **XYZ classification** | Ranking SKUs by demand variability (X stable … Z erratic) |
| **IRA** | Inventory Record Accuracy: % of counts where system qty matches physical within tolerance |
| **OTIF** | On-Time In-Full delivery |
| **WAPE** | Weighted Absolute Percentage Error: Σ\|actual − forecast\| ÷ Σ actual |
| **Bias** | Σ(forecast − actual) ÷ Σ actual; positive means over-forecasting |
| **ROP** | Reorder point: inventory position that triggers a replenishment order |
| **EOQ** | Economic Order Quantity |
| **PPV** | Purchase Price Variance |
| **Watermark** | Last successfully synced modification timestamp per entity |
| **DLQ** | Dead-letter queue: jobs that exhausted retries and need human review |
| **Blind count** | A count where the counter can't see the system quantity |
