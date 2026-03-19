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

Data retention: warehouse_stocks and vault_stocks auto-purge entries beyond 90 days (`RETENTION_DAYS` constant in `server.ts`).

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

## Notes

- The project is an ES module (`"type": "module"` in package.json)
- TypeScript targets ES2022
- Path alias `@/*` maps to the project root
- Avoid class components — use functional components only
- Designed for deployment in AI Studio; Vite HMR is disabled in that environment
- `gold_data.db` and `.env.local` are in `.gitignore` — do not commit them
