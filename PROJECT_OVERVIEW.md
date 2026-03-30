# GoldTrack — Project Overview

## What Is It?

GoldTrack (BullionTrack) is a real-time gold and silver market analytics dashboard. It pulls data from CME Group (COMEX) reports and displays warehouse inventory levels, delivery activity, central bank reserve data, and mining equity analytics.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| Backend | Express.js + Node.js (server.ts) |
| Database | PostgreSQL (Google Cloud SQL) via `pg` Pool |
| Styling | Tailwind CSS 4 with custom gold theme |
| Charts | Recharts |
| PDF parsing | pdf-parse v2 (PDFParse class) |
| Excel parsing | XLSX library |

---

## What It Does — Page by Page

### `/` — Dashboard (Market Overview)
- Metal toggle (Gold / Silver)
- Shows live **settlement price** from the CME daily PDF
- **Daily Deliveries** metric card — contracts delivered today
- **Registered Stocks** metric card — physical oz available for delivery, with daily change
- **Top Institutional Buyers / Sellers** bar chart — firms taking or making delivery (from delivery notices)
- All data is live from the PostgreSQL database (populated by CME sync)

### `/comex` — COMEX Detailed Analytics
- **Sync CME** button — triggers live fetch of CME reports (XLS + PDF)
- **MetalsSummary** component — shows MTD/Daily/YTD summary stats per metal
- **HistoricalComparisonChart** — warehouse stock trend over time
- **Daily Big Movers** — top buyers (stopped) and sellers (issued) by firm, per metal
- **MTD view** — table of month-to-date cumulative delivery contracts
- **YTD view** — monthly breakdown table (Jan–Dec) for Gold and Silver
- **InstitutionalActivity** component — institutional upload/analysis section
- Download button exists in UI but is **not wired up**

### `/cb-tracker` — Central Bank Tracker
- **Global Leaderboard** bar chart — top gold holding countries by tonnes (2026 data)
- Color codes countries by % of reserves held in gold
- **Whale Tracker** — Poland, Turkey, India buying streak sidebar
- **Monthly Purchase Trends** area chart — 24-month central bank net purchases
- **Country-by-Country table** — official holdings, last purchase date, monthly history heatmap, YOY change
- Click a country row to see its **purchase history bar chart**
- **China Special Report** — official vs estimated holdings analysis
- **All data on this page is hardcoded mock data** — not connected to any live API

### `/mining-synergy` — Sovereign-Mining Synergy
- **Sovereign Monthly Pulse table** — country, monthly tonnes, shadow multiplier, 3M momentum, buying streak signal
- **Miner Margin & AISC Monitor** — adjustable spot gold price input; calculates net margin, margin %, and operating leverage per miner vs their AISC cost
- **House Surge vs GDX chart** — house account delivery surges plotted against GDX ETF price
- **Physical Supply Gap widget** — mine supply vs recycling vs demand gap visualization with deficit figure
- **All data on this page is hardcoded mock data** — not connected to any live API

### `/logs` — Log Viewer
- View last N lines of backend or frontend logs
- Useful for debugging sync issues

---

## Backend — What It Does

### CME Data Sync (`GET /api/cme/sync`)
Fetches 4 files from CME Group:
1. `goldXls` — Gold warehouse stock report (Excel)
2. `silverXls` — Silver warehouse stock report (Excel)
3. `mtdPdf` — Month-to-date delivery report (PDF)
4. `dailyPdf` — Daily delivery issues/stops report (PDF)

Parses and saves to PostgreSQL. Uses cookie harvesting to bypass CME's bot protection.

### API Endpoints
| Endpoint | What It Returns |
|---|---|
| `GET /api/cme/sync` | Fetch + parse + store latest CME reports |
| `GET /api/cme/latest-stocks` | Warehouse stock history (last 90 days) |
| `GET /api/cme/latest-notices` | Latest delivery notices by firm/metal |
| `GET /api/cme/summary` | MTD / DAILY / YTD metals summary |
| `GET /api/cme/vault-breakdown` | Per-vault stock distribution |
| `GET /api/history` | Alias for latest-stocks |
| `POST /api/cme/institutional/upload` | Upload a PDF manually for parsing |
| `GET /api/logs/:type` | View server or frontend logs |
| `POST /api/log` | Frontend log receiver |

### Database Tables
- `warehouse_stocks` — daily COMEX inventory totals (registered + eligible oz, daily change)
- `vault_stocks` — per-vault breakdown (Brinks, HSBC, JP Morgan, etc.)
- `delivery_notices` — firm-level issued/stopped contracts per day
- `metals_summary` — MTD / DAILY / YTD summary metrics including YTD monthly breakdown

Data older than 90 days is automatically purged.

---

## What Is Currently Working

- CME XLS parsing (Gold and Silver warehouse data → DB)
- CME PDF parsing (daily + MTD delivery reports → DB) — fixed in latest update
- Warehouse stock display with live chart and vault breakdown
- Daily delivery notices (buyers/sellers) from DB
- MTD and YTD tables from DB
- Settlement price display
- Metal toggle (Gold / Silver) on all main components
- Log viewer
- Manual PDF upload endpoint (`/api/cme/institutional/upload`)

---

## What Is NOT Working / Missing

### Broken / Incomplete
| Issue | Detail |
|---|---|
| **CME sync requires internet** | The sync fetches directly from cmegroup.com — fails in network-restricted environments (ENOTFOUND / ETIMEDOUT) |
| **Download button (COMEX page)** | Button exists in UI but does nothing — no download handler wired up |
| **`syncType` selector (COMEX page)** | The Daily / MTD / YTD dropdown changes the view but does NOT change what gets synced — all 4 files are always fetched |
| **`AlertItem` component (Dashboard)** | Defined in Dashboard.tsx but never rendered anywhere |
| **`supply`/`demand` state (CB Tracker)** | useState variables exist but are never used or displayed |

### All Mock Data (No Live Source)
| Page / Section | Data Status |
|---|---|
| CB Tracker — all charts and tables | Hardcoded in `mockData.ts` |
| Mining Synergy — all charts and tables | Hardcoded in `mockData.ts` |
| COMEX_METRICS in mockData | Not used in production views |
| CME_DAILY_NOTICES in mockData | Not used (replaced by DB) |
| `generateStockHistory()` in mockData | Generated client-side, imported in Dashboard but not actually rendered |
| TOP_BUYERS, DIVERGENCE_INDEX in mockData | Imported in Dashboard but not rendered |

### Missing Features to Be Fully Functional
| Feature | Why It Matters |
|---|---|
| **Live central bank data** | CB Tracker is entirely static — needs an API source (IMF, World Gold Council, etc.) |
| **Live mining data** | Mining Synergy is entirely static — AISC, GDX price, miner history are all hardcoded |
| **Live spot/settlement price** | Settlement price comes from CME PDF sync only — no live price feed (no ticker integration) |
| **Scheduled auto-sync** | Sync must be triggered manually — no cron job or scheduled task |
| **Country flags on CB Tracker** | Flag placeholders are grey boxes (`bg-zinc-800`) — no actual flag images |
| **Export/Download** | Download button on COMEX page is not implemented |
| **Alerts system** | Alert infrastructure exists in Dashboard but nothing triggers or displays alerts |
| **Authentication** | No login/auth — anyone with the URL can access all data and trigger syncs |
| **Error recovery UI** | When DB is unreachable, pages show raw error strings rather than graceful fallback states |

---

## What You Need to Run It

### Required
- **Node.js** (v18+)
- **PostgreSQL database** (Google Cloud SQL or any Postgres instance)
- **`.env.local`** file with these variables:
  ```
  PGHOST=your_db_host
  PGPORT=5432
  PGDATABASE=your_db_name
  PGUSER=your_db_user
  PGPASSWORD=your_db_password
  PGSSLMODE=require
  ```
- The machine running the server must have **outbound internet access** to cmegroup.com for sync to work
- Your Cloud SQL instance must have the **server's outbound IP whitelisted** in authorized networks

### Optional
- `GEMINI_API_KEY` — for any future Gemini AI integration (currently unused in frontend)

---

## Known Infrastructure Issues

- This environment **cannot reach cmegroup.com** (DNS blocked) — sync will fail here
- This environment **cannot reach the Cloud SQL instance** (firewall) — all DB endpoints return 500 until the server's IP (`103.228.19.2`) is whitelisted in GCP Cloud SQL authorized networks
