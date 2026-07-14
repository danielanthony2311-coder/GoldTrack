# GoldTrack — Technical Summary

A one-file briefing covering: how data is gathered, API keys used, frontend/backend stack, exactly where each piece of data comes from, and how the CME fetcher avoids IP blocks.

Pairs with `PROJECT_OVERVIEW.md` (functional/page-level overview). This document is the technical/infra view.

---

## 1. TL;DR

GoldTrack is a React 19 + Vite SPA with an Express/Node backend that scrapes publicly-published CME Group reports (XLS and PDF files served from `cmegroup.com/delivery_reports/`) plus the IMF SDMX REST API for central bank reserves. Parsed data is stored in a Google Cloud SQL Postgres instance. No paid market-data APIs are used and **no API keys are required for the data sources** — the CME files are public downloads, IMF SDMX is open. Bot protection on CME is bypassed via cookie harvesting from a landing-page visit, rotating User-Agents, Referer spoofing, sequential fetches, and randomized human-paced delays between requests.

---

## 2. Stack

### Frontend (`src/`)

| Layer | Tech | Version |
|---|---|---|
| Framework | React + ReactDOM | 19.0.0 |
| Build tool | Vite | 6.2.0 |
| Language | TypeScript | 5.8.2 |
| Router | react-router-dom | 7.13.1 |
| Charts | Recharts | 3.7.0 |
| Styling | Tailwind CSS | 4.1.14 |
| Animation | motion (Framer) | 12.23.24 |
| Icons | lucide-react | 0.546.0 |

Built with `npm run build` → static bundle in `/dist`, served by Express in production.

### Backend (`server.ts`, single file, ~2,700 LOC)

| Layer | Tech | Purpose |
|---|---|---|
| Runtime | Node.js | v18+ required |
| Server | Express.js 4.21 | HTTP API + serves Vite build |
| Process runner | tsx 4.21 | Runs TS directly (no transpile step in dev) |
| HTTP client | axios 1.13 | Scraping CME files |
| Postgres driver | pg 8.20 | Connection to Cloud SQL |
| PDF parser | pdf-parse 2.4 | Parses MTD/Daily delivery PDFs |
| XLS parser | xlsx 0.18 | Parses warehouse stock spreadsheets |
| File uploads | multer 2.1 | Manual PDF upload endpoint |
| Env loader | dotenv 17.2 | Reads `.env.local` at startup |

The server is a single file (`server.ts`) — it runs scraping, parsing, DB writes, REST API endpoints, log streaming, and serves the React bundle from `/dist`. Everything in one process.

---

## 3. Data Sources — Where Each Piece Comes From

### 3a. CME Group (the main live source)

All scraped from public URLs under `https://www.cmegroup.com/delivery_reports/`. **No login. No API key. No subscription.** These are public files anyone can download from a browser:

| File | URL | Format | What it gives us |
|---|---|---|---|
| Gold Stocks | `https://www.cmegroup.com/delivery_reports/Gold_Stocks.xls` | Excel | Daily COMEX gold warehouse inventory: registered oz, eligible oz, daily change. Per-vault breakdown (Brinks, HSBC, JP Morgan Chase, Loomis, Manfra Tordella, Malca-Amit). |
| Silver Stocks | `https://www.cmegroup.com/delivery_reports/Silver_stocks.xls` | Excel | Same structure as gold, for silver. |
| MTD Delivery Report | `https://www.cmegroup.com/delivery_reports/MetalsIssuesAndStopsMTDReport.pdf` | PDF | Month-to-date cumulative issued/stopped contracts by firm and metal. |
| Daily Delivery Report | `https://www.cmegroup.com/delivery_reports/MetalsIssuesAndStopsReport.pdf` | PDF | Today's issued (sold) / stopped (bought) contracts by firm. Also contains the daily **settlement price** which is extracted by regex. |
| YTD Delivery Report | `https://www.cmegroup.com/delivery_reports/MetalsIssuesAndStopsYTDReport.pdf` | PDF | Year-to-date cumulative delivery activity broken down by month (Jan–Dec) for both metals. |

Triggered by: `GET /api/cme/sync` (manual button on the COMEX page). There is **no cron** — sync is on-demand.

### 3b. IMF SDMX REST API (central bank reserves)

| Source | URL | Auth | Frequency |
|---|---|---|---|
| IMF International Financial Statistics (IFS) | `https://dataservices.imf.org/REST/SDMX_JSON.svc/CompactData/IFS/A.{country_codes}.RAXG_USD.?startPeriod=2020&endPeriod=2026` | None — public REST | On-demand via `GET /api/cb/sync` |

Returns annual gold reserve holdings in USD per country (`RAXG_USD` indicator). Parsed from the SDMX JSON response.

If the IMF call fails, the server falls back to a **hardcoded World Gold Council baseline** so the CB Tracker page still renders. The response includes a `source: 'IMF IFS' | 'WGC Baseline'` flag so the frontend can show which set is current.

### 3c. Hardcoded mock data (NOT live)

These pages have **no live data source** and are populated entirely from `src/data/mockData.ts`:

- `/cb-tracker` — most of the page (live IMF data exists but is not yet wired into all charts)
- `/mining-synergy` — entire page (AISC, GDX price, miner history, supply gap)
- Some unused Dashboard variables (`TOP_BUYERS`, `DIVERGENCE_INDEX`, `generateStockHistory`) are imported but never rendered

A colleague reading the site should know: only **COMEX / warehouse / delivery data is live**. Mining and central bank dashboards are demos until those data feeds are wired up.

---

## 4. API Keys — Inventory

**Short answer: none of the live data sources require an API key.**

| Service | Needs key? | Status |
|---|---|---|
| CME Group file downloads | No | Public downloads, no auth |
| IMF SDMX REST | No | Public REST, no auth |
| Google Cloud SQL (Postgres) | DB credentials, not an API key | Stored in `.env.local` as PG* vars |
| `GEMINI_API_KEY` | Optional | `@google/genai` is in `package.json` but the integration is not wired to any production feature. Safe to leave unset. |
| World Gold Council | No | Used only as a hardcoded fallback dataset, not fetched |

**The only secrets that matter** are the Postgres connection strings in `.env.local`:

```
PGHOST=34.11.91.3
PGPORT=5432
PGDATABASE=postgres
PGUSER=postgres
PGPASSWORD=...
PGSSLMODE=require
```

There is **no** auth on the frontend — anyone who can reach the host can hit `/api/cme/sync` and trigger a scrape. This is a gap to fix before any production exposure.

---

## 5. Anti-Bot / IP-Block Avoidance

CME serves the files publicly but their CDN/WAF rejects bare automated `curl`/`axios` requests with a `403` or a bot-challenge page. The sync route in `server.ts` (around lines 903–1280) defeats this with a six-part technique:

### 5.1 Rotating User-Agent pool

Three realistic, current Chrome strings are randomly chosen per sync session (one UA is used for all four requests in a session):

```ts
const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...Chrome/123.0.0.0 Safari/537.36',
];
const sessionUA = UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
```

### 5.2 Landing-page cookie harvesting (the key trick)

Before any file download, the server first GETs the landing page:

```
GET https://www.cmegroup.com/delivery_reports/
```

The `Set-Cookie` headers on that response are harvested into a single `Cookie: ...` header string and re-sent on every subsequent file request. This is what tells CME's WAF "this is a real browsing session, not a bare curl."

Cookies are also **merged** as new ones are received during the session — so the cookie jar evolves naturally across the four file fetches.

### 5.3 Referer spoofing

Every file request includes `Referer: https://www.cmegroup.com/delivery_reports/` to simulate a click from the landing page rather than direct deep-link access.

### 5.4 Full browser-like header set

Each request sends the standard set a real Chrome would send: `Accept-Language`, `Accept-Encoding`, `Connection`, `Upgrade-Insecure-Requests`, `Sec-Fetch-*`, etc. (See `server.ts` ~line 1000.)

### 5.5 Sequential fetches with randomized delays

Files are downloaded **one at a time**, never in parallel. Between each download the server waits a randomized, vaguely human-paced delay:

```ts
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Gaussian-ish: average of 3 random numbers — clusters around midpoint
const delay = (minMs, maxMs) => {
  const r = (Math.random() + Math.random() + Math.random()) / 3;
  return sleep(Math.round(minMs + r * (maxMs - minMs)));
};
```

A full 4-file sync typically takes 15–30 seconds — slower than a parallel fetch would be, but well below the rate-limit threshold.

### 5.6 Single static outbound IP

The Cloud SQL DB only allows connections from whitelisted IPs, so the production host has a static outbound IP (`103.228.19.2` per `PROJECT_OVERVIEW.md`) that's added to GCP authorized networks. As a side-effect, CME sees consistent requests from the same IP rather than rotating residential proxies — paradoxically this looks *more* legitimate (it looks like a single analyst hitting the page repeatedly, not a botnet).

### What's NOT used (and why we don't need it)

- No rotating proxies / VPN
- No headless browser (Puppeteer/Playwright)
- No CAPTCHA solver
- No paid scraping API (ScrapingBee, ZenRows, etc.)

The combination of cookie harvesting + Referer + realistic UAs + delays is enough because CME's published delivery reports are **meant to be downloadable** — the WAF just blocks naïve automated access. We're not bypassing anything they prohibit in their ToS (these files are linked from their public reports index).

---

## 6. Database — Cloud SQL Postgres

Single instance, four core tables. Schema is auto-ensured on server startup.

| Table | Purpose |
|---|---|
| `warehouse_stocks` | Daily COMEX inventory totals per metal — registered oz, eligible oz, total, daily change |
| `vault_stocks` | Per-vault stock breakdown (Brinks, HSBC, JP Morgan, etc.) per metal per day |
| `delivery_notices` | Firm-level issued/stopped contracts per day per metal (from MTD + daily PDFs) |
| `metals_summary` | MTD / DAILY / YTD aggregates and the YTD monthly breakdown |

**Retention**: rows older than **90 days are auto-purged** to keep the DB small. The CB Tracker is forced to use IMF/mock data partly because of this — long-term history isn't kept locally.

---

## 7. Public API Endpoints

All served by Express on the same host as the SPA.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cme/sync` | Trigger full 4-file CME scrape + parse + DB write |
| `GET` | `/api/cme/latest-stocks` | Last 90 days of warehouse inventory |
| `GET` | `/api/cme/latest-notices` | Latest delivery notices (firm-level) |
| `GET` | `/api/cme/summary` | MTD / DAILY / YTD summary per metal |
| `GET` | `/api/cme/vault-breakdown` | Stock distribution per vault |
| `GET` | `/api/cme/firm-flows` | Per-firm cumulative flow analytics |
| `GET` | `/api/history` | Alias for `/api/cme/latest-stocks` |
| `POST` | `/api/cme/institutional/upload` | Manually upload a PDF for parsing |
| `GET` | `/api/cb/reserves` | Latest central bank reserves data from DB |
| `GET` | `/api/cb/sync` | Hit IMF SDMX, store in DB |
| `GET` | `/api/prices/sync` | No-op (prices come from CME PDF sync) |
| `GET` | `/api/logs/:type?lines=500` | Last N lines of server or frontend logs |
| `GET` | `/api/logs/:type/stream` | SSE real-time tail of a log file |
| `DELETE` | `/api/logs/:type` | Clear a log file |
| `POST` | `/api/log` | Receiver for frontend-side log forwarding |

None of these are auth-gated.

---

## 8. What's Live vs. What's Mock

| Area | Status |
|---|---|
| Warehouse stocks (gold + silver) | **Live** (CME XLS) |
| Vault breakdown | **Live** (CME XLS) |
| Daily delivery notices | **Live** (CME daily PDF) |
| MTD delivery totals | **Live** (CME MTD PDF) |
| YTD monthly delivery breakdown | **Live** (CME YTD PDF) |
| Settlement price | **Live** (extracted from daily PDF via regex) |
| Central bank reserves (annual) | **Live via IMF SDMX**, falls back to WGC baseline if IMF fails |
| Whale Tracker (Poland / Turkey / India streaks) | **Mock** (hardcoded) |
| Monthly CB purchase trends | **Mock** |
| China official vs estimated holdings | **Mock** |
| Mining Synergy — Sovereign Monthly Pulse | **Mock** |
| Mining Synergy — Miner AISC / margin monitor | **Mock** |
| Mining Synergy — GDX vs House Surge chart | **Mock** |
| Mining Synergy — Physical Supply Gap | **Mock** |

---

## 9. Infrastructure & Security Notes

- **Hosting**: server runs on Node, currently bound to port 3000. Production deploy details aren't pinned in this repo.
- **Outbound IP**: must be whitelisted in GCP Cloud SQL "authorized networks" (`103.228.19.2` in current setup).
- **Inbound**: not currently behind a CDN or WAF. No rate limiting on any endpoint.
- **Auth**: none. Any visitor to the host can trigger a CME sync, hit any API, and view all data.
- **Secrets**: only in `.env.local`. No secret management system (Vault, GCP Secret Manager, etc.) yet.
- **Logs**: written to `logs/server.log` and `logs/frontend.log`. Auto-rotated by line count (handled internally in server.ts).
- **Frontend bundle**: built with Vite, served as static files from `/dist` by the same Express process.

### Known limitations (for the colleague's awareness)

- Sync requires outbound internet — fails in air-gapped/firewalled environments
- No retry-on-failure for sync (a single failed file aborts the whole sync)
- No queue or job system — sync is synchronous, blocks the request thread
- No alerting on sync failure
- No auth/auth-z — needs to be added before any external exposure
- Mining + most CB Tracker data is demo content
