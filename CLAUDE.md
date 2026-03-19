# GoldTrack — Claude Code Guide

## Project Overview

GoldTrack (BullionTrack) is a real-time gold and silver market analytics dashboard. It tracks COMEX warehouse stocks, delivery notices, central bank gold reserves, and mining data. Data is sourced from CME Group reports (XLS/PDF) and stored locally in SQLite.

## Architecture

- **Frontend:** React 19 + TypeScript + Vite (SPA)
- **Backend:** Express.js + Node.js (`server.ts`)
- **Database:** SQLite via `better-sqlite3` (`gold_data.db`)
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
├── server.ts             # Express backend + SQLite + CME data sync
├── gold_data.db          # SQLite database (do not commit)
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
| POST | `/api/cme/sync` | Consolidated sync trigger |
| GET | `/api/cme/latest-stocks` | Warehouse stock history (last 90 days) |
| GET | `/api/cme/latest-notices` | Latest delivery notices by metal |
| GET | `/api/cme/summary` | MTD/DAILY/YTD metals summary |
| GET | `/api/cme/vault-breakdown` | Vault-level stock distribution |
| GET | `/api/history` | Alias for latest-stocks |

## Database Schema

**`warehouse_stocks`** — COMEX inventory totals
- `date`, `metal` (GOLD/SILVER), `registered_oz`, `eligible_oz`, `total_oz`
- `daily_change_registered`, `daily_change_eligible`, `delta_label`
- UNIQUE: `(date, metal)`

**`vault_stocks`** — Per-vault breakdown
- `date`, `vault`, `metal`, `registered_oz`, `eligible_oz`
- UNIQUE: `(date, vault, metal)`

**`delivery_notices`** — CME delivery notices
- `date`, `firm`, `issued`, `stopped`, `metal`, `account_type` (CUSTOMER/HOUSE)
- UNIQUE: `(date, firm, metal, account_type)`

**`metals_summary`** — Summary metrics
- `date`, `metal`, `report_type` (MTD/DAILY/YTD)
- `mtd`, `settlement`, `daily_issued`, `daily_stopped`, `ytd_json`
- UNIQUE: `(date, metal, report_type)`

Data retention: warehouse_stocks auto-purges entries older than 90 days.

## Environment Variables

Create `.env.local` for local development:

```
GEMINI_API_KEY=your_key_here   # Google Gemini API (optional)
```

The `GEMINI_API_KEY` is injected into the Vite build via `vite.config.ts`.

## Styling Conventions

- Use the `cn()` utility (`src/utils/cn.ts`) for conditional Tailwind classes
- Custom color palette: `gold-50` through `gold-900` (primary accent: `gold-500` = `#F39C12`)
- Dark background: `#0B0E11`
- Reusable class `glass-card` for frosted glass card effect (defined in `index.css`)
- Fonts: Inter (sans), JetBrains Mono (mono)

## Code Conventions

- Functional React components with hooks (`useState`, `useEffect`)
- Explicit TypeScript interfaces for all data shapes
- Backend uses transaction-based SQLite writes for data consistency
- PDF parsing: regex-based text extraction in `server.ts`
- Excel parsing: XLSX library targeting bottom-row totals and vault name mapping
- Avoid class components — use functional components only
- Path alias `@/*` maps to the project root

## Notes

- `gold_data.db` is a runtime artifact — do not commit it
- The project is an ES module (`"type": "module"` in package.json)
- TypeScript targets ES2022
- Designed for deployment in AI Studio; Vite HMR is disabled in that environment
