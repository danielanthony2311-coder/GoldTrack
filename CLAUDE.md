# GoldTrack — Claude Code Guide

## Project Overview

GoldTrack (BullionTrack) is a real-time gold and silver market analytics dashboard. It tracks COMEX warehouse stocks, delivery notices, central bank gold reserves, and mining data. Data is sourced from CME Group reports (XLS/PDF) and stored in PostgreSQL.

## Architecture

- **Frontend:** React 19 + TypeScript + Vite (SPA)
- **Backend:** Express.js + Node.js (`server.ts`)
- **Database:** PostgreSQL via `pg` (Pool-based, async)
- **Styling:** Tailwind CSS 4 with custom gold theme
- **Charts:** Recharts

The backend serves both the API and static frontend assets. In dev, Vite handles HMR; in production, the built `/dist` is served.

## Commands

```bash
npm run dev       # Start dev server (tsx server.ts — serves both API + Vite HMR)
npm run build     # Build frontend to /dist
npm run preview   # Preview production build
npm run lint      # TypeScript type check (tsc --noEmit)
npm run clean     # Remove /dist
```

## Project Structure

```
GoldTrack/
├── src/
│   ├── components/       # Reusable React components
│   ├── pages/            # Route-level page components
│   ├── data/mockData.ts  # Seed/mock data
│   └── utils/cn.ts       # Tailwind class merge utility
├── server.ts             # Express backend + PostgreSQL + CME data sync
├── vite.config.ts
└── index.html
```

## Key Pages

| Route | Page | Purpose |
|---|---|---|
| `/` | Dashboard | Market overview, warehouse stocks, delivery data |
| `/comex` | COMEX Details | Historical charts, MTD/YTD reports, CME sync |
| `/cb-tracker` | CB Tracker | Central bank gold reserves leaderboard |
| `/mining-synergy` | Mining Synergy | Mining analytics |
| `/supply` | Physical Supply | COMEX warehouse, OI, ETF, LBMA |
| `/positioning` | Positioning | Gold/Silver ratio, Gold vs DXY, COT |
| `/patterns` | Pattern Library | Pre-registered backtested patterns: survivors, graveyard, chance disclosure |

## Backend API Endpoints

All routes are prefixed with `/api`:

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/cme/sync` | Fetch & sync CME report files (XLS + PDF) |
| GET | `/api/cme/latest-stocks` | Warehouse stock history (last 90 days) |
| GET | `/api/cme/latest-notices` | Latest delivery notices by metal |
| GET | `/api/cme/summary` | MTD/DAILY/YTD metals summary |
| GET | `/api/cme/vault-breakdown` | Vault-level stock distribution |
| GET | `/api/history` | Alias for latest-stocks |
| GET | `/api/dxy/sync` | Seed/update DXY (US Dollar Index) data |
| GET | `/api/dxy/latest` | DXY history (last 90 days) |
| GET | `/api/export/csv` | Download all collected data as CSV |
| GET | `/api/goldhistory/sync` | Backfill/refresh the long-run history DB (LBMA 1968+, FRED macro, CFTC COT 1986+, GLD 2004+, events). Idempotent full upsert; part of the nightly pipeline |
| GET | `/api/goldhistory/summary` | Validation report: row counts, date ranges, gap check, sanity bounds, LBMA-vs-GLD cross-check |
| GET | `/api/patterns/run` | Recompute all pre-registered pattern backtests (frozen definitions; part of nightly pipeline) |
| GET | `/api/patterns/library` | Pattern library: survivors/graveyard/insufficient + honesty summary (feeds `/patterns` page) |

## Database Schema

Tables are auto-created on startup via `CREATE TABLE IF NOT EXISTS`. All `id` columns use `BIGSERIAL PRIMARY KEY`.

**`warehouse_stocks`** — COMEX inventory totals
- `date`, `metal` (GOLD/SILVER), `registered_oz`, `eligible_oz`, `total_oz`
- `daily_change_registered`, `daily_change_eligible`, `delta_label`
- UNIQUE: `(date, metal)`
- Index: `idx_warehouse_metal_date (metal, date DESC)`

**`vault_stocks`** — Per-vault breakdown
- `date`, `vault`, `metal`, `registered_oz`, `eligible_oz`
- UNIQUE: `(date, vault, metal)`
- Index: `idx_vault_metal_date (metal, date DESC)`

**`delivery_notices`** — CME delivery notices
- `date`, `firm`, `issued`, `stopped`, `metal`, `account_type` (CUSTOMER/HOUSE)
- UNIQUE: `(date, firm, metal, account_type)`
- Index: `idx_notices_metal_date (metal, date DESC)`

**`metals_summary`** — Summary metrics
- `date`, `metal`, `report_type` (MTD/DAILY/YTD)
- `mtd`, `settlement`, `daily_issued`, `daily_stopped`, `ytd_json`
- UNIQUE: `(date, metal, report_type)`
- Index: `idx_summary_metal_date (metal, date DESC)`

**`dxy_index`** — US Dollar Index daily closes
- `date` (UNIQUE), `close`, `source`
- Index: `idx_dxy_date (date DESC)`

Data retention: kept forever by default (`RETENTION_DAYS` env var, default `0` = no purge). Set `RETENTION_DAYS=90` to restore the old auto-purge of warehouse_stocks and vault_stocks. History accumulation is a product feature — do not purge in production.

**`market_narratives`** — AI-generated daily interpretation (see `analysis.ts`)
- `date`, `metal`, `headline`, `narrative`, `theory`, `what_changed`, `confidence`, `watch_next`, `sources` (JSONB), `signals` (JSONB), `model`
- UNIQUE: `(date, metal)`

**`app_state`** — Key/value store (`key` TEXT PK, `value`, `updated_at`); tracks `last_pipeline_at` for the boot catch-up check.

### `gold_history` schema (long-run history DB — see `history.ts`)

Separate namespace holding decades of backfilled data from official primary sources. All syncs are idempotent full upserts (~105k rows, ~30s).

- **`lbma_prices`** — `(date, metal)` PK; `usd`, `gbp`, `eur`. LBMA gold PM fix + silver fix, daily since 1968 (prices.lbma.org.uk official JSON, no key)
- **`fred_series`** — `(series_id, date)` PK; `value`. Nine macro series via `fredgraph.csv` (no API key): DFII10, DGS10, FEDFUNDS, CPIAUCSL, DTWEXBGS, DTWEXM, DFEDTAR, DFEDTARU, VIXCLS
- **`cot_reports`** — `(report_date, metal)` PK; OI + noncommercial/commercial/nonreportable long/short. CFTC Socrata API (`publicreporting.cftc.gov/resource/6dca-aqww.json`), weekly since 1986. Contract codes: GOLD 088691, SILVER 084691. Incremental after first backfill
- **`gld_holdings`** — `date` PK; close, oz/share, NAV/share, total oz, tonnes, volume. Official SPDR archive XLSX (`api.spdrgoldshares.com/api/v1/historical-archive`), daily since Nov 2004. Holiday rows skipped
- **`events`** — `(date, label)` PK; 18 curated crisis/geopolitical events + ~180 Fed policy changes DERIVED via SQL from DFEDTAR/DFEDTARU (never hand-typed)

Validation: `/api/goldhistory/summary` cross-checks the GLD-implied gold price (NAV/share ÷ oz/share) against the LBMA fix — median diff must be ~0%. Verified 2026-07-10: 0.0000% over 5,300 overlapping days.

### Pattern engine (`patterns.ts`)

Pre-registered backtests over `gold_history` — 13 GOLD hypotheses frozen in code (`HYPOTHESES` array). Statistical guardrails ALL live in the shared engine, never per-pattern: point-in-time publication lags (`LAG_DAYS`), expanding-window percentiles (a day is ranked only against prior days), episode grouping (≥63 trading days apart, n = episodes not days), next-day entry, Wilson 95% intervals, n<15 → INSUFFICIENT with no stats shown, first/second-half holdout, adjacent-horizon sign consistency, threshold-perturbation robustness (`variants`), pre-1971-08-16 exclusion. **Definitions are frozen by SHA-256 hash** — the engine refuses to overwrite a pattern whose definition changed; register the revision under a NEW id (lineage stays visible). Failed patterns stay in the library as NO_EDGE (the graveyard is the anti-cherry-picking proof). Results go to `gold_history.pattern_stats`. `getRegimeContext()` (rolling 2-y gold-vs-real-yield correlation) is injected into the AI narrative prompt for GOLD.

- **`pattern_stats`** — `pattern_id` PK; `definition_hash`, family/name/description/rationale, `expected_direction`, `primary_horizon` (21/63/126 td), `status` (SURVIVED/NO_EDGE/INSUFFICIENT), `n_episodes`, `checks` JSONB, `results` JSONB (eras full/firstHalf/secondHalf/recent × horizons), `variants` JSONB, `active_today`

Endpoints: GET `/api/patterns/run` (recompute + store; in SYNC_ENDPOINTS so it refreshes nightly after the history sync), GET `/api/patterns/library` (summary incl. `expectedSurvivorsByChance` + all patterns; feeds `/patterns` page).

**When adding a hypothesis:** add it to `HYPOTHESES` with an honest ex-ante `rationale`, pick `direction` and `primaryHorizon` BEFORE looking at results, give it threshold `variants`, and never edit it afterwards — revisions get a new id.

## Environment Variables

Create `.env.local` for local development (required — server exits on startup if missing):

```
PGHOST=your_host
PGPORT=5432
PGDATABASE=postgres
PGUSER=postgres
PGPASSWORD=your_password
PGSSLMODE=require       # Set to 'require' to enable SSL (uses rejectUnauthorized: false)
GEMINI_API_KEY=your_key # Google Gemini API (optional, injected into Vite build)
ANTHROPIC_API_KEY=your_key # Claude API — powers the AI market narrative (optional; panel shows setup hint if unset)
```

**Required vars:** `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`. Server will refuse to start if any are missing.

> **Note:** `PGSSLMODE=require` uses `ssl: { rejectUnauthorized: false }`, which skips TLS certificate validation. For hardened production, replace with a CA cert.

## Backend Conventions

- All DB operations use `pg.Pool` with `$1, $2, ...` parameterized queries
- Write operations use `pool.connect()` with explicit `BEGIN / COMMIT / ROLLBACK`
- `initDb()` is called before routes are registered — creates all tables and indexes
- All API route handlers are `async`
- Errors in XLS/PDF processing are caught per-file and reported in the sync response (do not abort the entire sync)
- PDF parsing: regex-based text extraction (`parseCMEPdf` / `processSection` in `server.ts`)
- Excel parsing: XLSX library targeting bottom-row totals and vault name mapping (`parseXls`)
- `pdf-parse` is loaded via `createRequire` (CJS shim in ESM context)

## Frontend Conventions

- Functional React components with hooks (`useState`, `useEffect`)
- Explicit TypeScript interfaces for all data shapes
- `useEffect` data fetches use `AbortController` for cleanup on unmount / dependency change
- Parallel fetches use `Promise.all`; all responses check `.ok` before `.json()`
- Use the `cn()` utility (`src/utils/cn.ts`) for conditional Tailwind classes

## Styling Conventions

- Custom color palette: `gold-50` through `gold-900` (primary accent: `gold-500` = `#F39C12`)
- Dark background: `#0B0E11`
- Reusable class `glass-card` for frosted glass card effect (defined in `index.css`)
- Fonts: Inter (sans), JetBrains Mono (mono)

## Requirements

- **Automated pipeline updates everything**: There are no manual Sync All buttons. Every new data source MUST be added to `SYNC_ENDPOINTS` in `server.ts` (the nightly automated pipeline, ~line 2798). Current sync list: `/api/cme/sync`, `/api/cb/sync`, `/api/prices/sync`, `/api/etf/sync`, `/api/lbma/sync`, `/api/oi/sync`, `/api/dxy/sync`. The pipeline runs weeknights at 21:00 ET (cron, with random start jitter and 20–90s pauses between sources) plus a catch-up run on server boot if the last run was >20h ago (`last_pipeline_at` in `app_state`). Disable with `AUTO_SYNC=off`.
- **Anti-blocking**: CME sync uses human-like delays, UA rotation, cookie harvesting, cooldowns, and sequential fetching to avoid IP blocks. All new external data syncs must follow the same pattern.
- **CSV Export**: `/api/export/csv` joins all gold data (price, warehouse, OI, DXY, delivery notices) by date into one downloadable CSV. Must include any new data columns when added.

## Notes

- The project is an ES module (`"type": "module"` in package.json)
- TypeScript targets ES2022
- Path alias `@/*` maps to the project root
- Avoid class components — use functional components only
- Designed for deployment in AI Studio; Vite HMR is disabled in that environment
- `gold_data.db` and `.env.local` are in `.gitignore` — do not commit them
