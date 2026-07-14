// history.ts — long-run gold/silver history database ("gold_history" schema).
//
// A separate namespace from the live COMEX pipeline, holding decades of
// backfilled data from official primary sources:
//
//   lbma_prices   — LBMA gold PM fix + silver fix, daily since 1968
//                   (prices.lbma.org.uk official JSON, no key)
//   fred_series   — macro drivers from the St. Louis Fed (real yields,
//                   nominal 10Y, fed funds, CPI, dollar indexes, VIX,
//                   fed target rate) via fredgraph.csv, no key
//   cot_reports   — CFTC Commitments of Traders for COMEX gold + silver,
//                   weekly since 1986 (official Socrata API)
//   gld_holdings  — SPDR GLD trust holdings (oz/tonnes/NAV), daily since
//                   Nov 2004 (official State Street archive)
//   events        — dated market events: a curated crisis list plus Fed
//                   policy changes DERIVED mathematically from the FRED
//                   target-rate series (not hand-typed)
//
// Every sync is a full idempotent upsert (sources ship complete-history
// files), so re-running is always safe. historySummary() returns a
// validation report including a cross-check of the GLD-implied gold price
// against the LBMA fix — two independent institutions that must agree.

import * as XLSX from "xlsx";
import type pg from "pg";

type Pool = pg.Pool;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// FRED series backfilled nightly. Each is one small CSV from fredgraph.csv.
const FRED_SERIES: Record<string, string> = {
  DFII10: "10-Year real yield (TIPS), daily since 2003 — gold's #1 macro driver",
  DGS10: "10-Year nominal Treasury yield, daily since 1962",
  FEDFUNDS: "Effective federal funds rate, monthly since 1954",
  CPIAUCSL: "US CPI (all items), monthly since 1947",
  DTWEXBGS: "Broad trade-weighted dollar index, daily since 2006",
  DTWEXM: "Major-currencies dollar index, daily 1973–2019 (discontinued; long history)",
  DFEDTAR: "Fed funds target rate, 1982–2008 (source for derived Fed events)",
  DFEDTARU: "Fed funds target upper bound, since 2008 (source for derived Fed events)",
  VIXCLS: "CBOE VIX, daily since 1990",
};

// CFTC legacy futures-only contract codes (verified against live API).
const COT_CODES: Record<string, string> = { GOLD: "088691", SILVER: "084691" };

export async function ensureHistoryTables(pool: Pool) {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS gold_history`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_history.lbma_prices (
      date TEXT NOT NULL,
      metal TEXT NOT NULL,
      usd DOUBLE PRECISION,
      gbp DOUBLE PRECISION,
      eur DOUBLE PRECISION,
      PRIMARY KEY (date, metal)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_history.fred_series (
      series_id TEXT NOT NULL,
      date TEXT NOT NULL,
      value DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (series_id, date)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_history.cot_reports (
      report_date TEXT NOT NULL,
      metal TEXT NOT NULL,
      open_interest DOUBLE PRECISION,
      noncomm_long DOUBLE PRECISION,
      noncomm_short DOUBLE PRECISION,
      noncomm_spreading DOUBLE PRECISION,
      comm_long DOUBLE PRECISION,
      comm_short DOUBLE PRECISION,
      nonrept_long DOUBLE PRECISION,
      nonrept_short DOUBLE PRECISION,
      PRIMARY KEY (report_date, metal)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_history.gld_holdings (
      date TEXT PRIMARY KEY,
      close_usd DOUBLE PRECISION,
      oz_per_share DOUBLE PRECISION,
      nav_per_share DOUBLE PRECISION,
      total_oz DOUBLE PRECISION,
      tonnes DOUBLE PRECISION,
      volume BIGINT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_history.events (
      date TEXT NOT NULL,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY (date, label)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_hist_lbma_metal_date ON gold_history.lbma_prices(metal, date DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_hist_cot_metal_date ON gold_history.cot_reports(metal, report_date DESC)`
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === "" || v === ".") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// Multi-row upsert in chunks — one round trip per ~1000 rows instead of one
// per row, which matters when backfilling ~60k rows into Cloud SQL.
async function bulkUpsert(
  pool: Pool,
  table: string,
  columns: string[],
  conflictCols: string[],
  rows: any[][],
  chunkSize = 1000
): Promise<number> {
  if (rows.length === 0) return 0;
  const updateCols = columns.filter((c) => !conflictCols.includes(c));
  const updateClause =
    updateCols.length > 0
      ? `DO UPDATE SET ${updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`
      : "DO NOTHING";
  const client = await pool.connect();
  let written = 0;
  try {
    await client.query("BEGIN");
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const params: any[] = [];
      const values = chunk
        .map((row) => {
          const ph = row.map((v) => {
            params.push(v);
            return `$${params.length}`;
          });
          return `(${ph.join(",")})`;
        })
        .join(",");
      await client.query(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}
         ON CONFLICT (${conflictCols.join(",")}) ${updateClause}`,
        params
      );
      written += chunk.length;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return written;
}

// ── LBMA prices (official, since 1968) ────────────────────────────────────────

export async function syncLbmaHistory(pool: Pool): Promise<number> {
  const feeds: { metal: string; url: string }[] = [
    { metal: "GOLD", url: "https://prices.lbma.org.uk/json/gold_pm.json" },
    { metal: "SILVER", url: "https://prices.lbma.org.uk/json/silver.json" },
  ];
  let total = 0;
  for (const { metal, url } of feeds) {
    const data = await fetchJson(url);
    if (!Array.isArray(data)) throw new Error(`LBMA ${metal}: unexpected payload shape`);
    const rows: any[][] = [];
    for (const rec of data) {
      const usd = num(rec?.v?.[0]);
      if (!rec?.d || !usd || usd <= 0) continue; // 0 = no fix that day
      rows.push([rec.d, metal, usd, num(rec.v[1]), num(rec.v[2])]);
    }
    total += await bulkUpsert(
      pool,
      "gold_history.lbma_prices",
      ["date", "metal", "usd", "gbp", "eur"],
      ["date", "metal"],
      rows
    );
  }
  return total;
}

// ── FRED macro series (no API key — fredgraph.csv) ────────────────────────────

export async function syncFredHistory(pool: Pool): Promise<number> {
  let total = 0;
  for (const seriesId of Object.keys(FRED_SERIES)) {
    const csv = await fetchText(
      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`
    );
    const lines = csv.trim().split("\n");
    if (!/^observation_date/i.test(lines[0] ?? "")) {
      throw new Error(`FRED ${seriesId}: unexpected header "${lines[0]?.slice(0, 60)}"`);
    }
    const rows: any[][] = [];
    for (const line of lines.slice(1)) {
      const [date, raw] = line.split(",");
      const value = num(raw);
      if (!date || value === null) continue; // "." = missing observation
      rows.push([seriesId, date.trim(), value]);
    }
    total += await bulkUpsert(
      pool,
      "gold_history.fred_series",
      ["series_id", "date", "value"],
      ["series_id", "date"],
      rows
    );
  }
  return total;
}

// ── CFTC Commitments of Traders (weekly since 1986) ───────────────────────────

export async function syncCotHistory(pool: Pool): Promise<number> {
  let total = 0;
  for (const [metal, code] of Object.entries(COT_CODES)) {
    // Incremental: only refetch from 30 days before the last stored report.
    const last = await pool.query(
      `SELECT MAX(report_date) AS d FROM gold_history.cot_reports WHERE metal = $1`,
      [metal]
    );
    const params = new URLSearchParams({
      cftc_contract_market_code: code,
      $limit: "50000",
      $order: "report_date_as_yyyy_mm_dd",
    });
    const lastDate = last.rows[0]?.d;
    if (lastDate) {
      const since = new Date(`${lastDate}T00:00:00Z`);
      since.setUTCDate(since.getUTCDate() - 30);
      params.set(
        "$where",
        `report_date_as_yyyy_mm_dd >= '${since.toISOString().slice(0, 10)}T00:00:00.000'`
      );
    }
    const data = await fetchJson(
      `https://publicreporting.cftc.gov/resource/6dca-aqww.json?${params.toString()}`
    );
    if (!Array.isArray(data)) throw new Error(`CFTC ${metal}: unexpected payload shape`);
    const rows: any[][] = [];
    for (const r of data) {
      const date = typeof r.report_date_as_yyyy_mm_dd === "string"
        ? r.report_date_as_yyyy_mm_dd.slice(0, 10)
        : null;
      if (!date) continue;
      rows.push([
        date,
        metal,
        num(r.open_interest_all),
        num(r.noncomm_positions_long_all),
        num(r.noncomm_positions_short_all),
        // the dataset historically misspells this field; accept either
        num(r.noncomm_positions_spread_all ?? r.noncomm_postions_spread_all ?? r.noncomm_positions_spread),
        num(r.comm_positions_long_all),
        num(r.comm_positions_short_all),
        num(r.nonrept_positions_long_all),
        num(r.nonrept_positions_short_all),
      ]);
    }
    total += await bulkUpsert(
      pool,
      "gold_history.cot_reports",
      [
        "report_date", "metal", "open_interest",
        "noncomm_long", "noncomm_short", "noncomm_spreading",
        "comm_long", "comm_short", "nonrept_long", "nonrept_short",
      ],
      ["report_date", "metal"],
      rows
    );
  }
  return total;
}

// ── SPDR GLD holdings archive (daily since Nov 2004) ──────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseGldDate(v: any): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000) {
    // Excel serial date (days since 1899-12-30)
    return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (m) {
      const mon = MONTHS[m[2].toLowerCase()];
      if (mon !== undefined) {
        return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      }
    }
  }
  return null;
}

export async function syncGldHistory(pool: Pool): Promise<number> {
  const res = await fetch(
    "https://api.spdrgoldshares.com/api/v1/historical-archive?product=gld&exchange=NYSE&lang=en",
    { headers: { "User-Agent": UA } }
  );
  if (!res.ok) throw new Error(`GLD archive → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames.find((n) => /archive/i.test(n));
  if (!sheetName) throw new Error(`GLD archive: no Archive sheet in [${wb.SheetNames.join(", ")}]`);
  const grid: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    raw: true,
  });

  // Locate the header row and map columns by name, not position.
  const hdrIdx = grid.findIndex((r) => String(r?.[0]).trim() === "Date");
  if (hdrIdx === -1) throw new Error("GLD archive: header row not found");
  const hdr = grid[hdrIdx].map((c: any) => String(c ?? ""));
  const col = (label: string) => hdr.findIndex((h) => h.toLowerCase().startsWith(label.toLowerCase()));
  const iClose = col("Closing Price");
  const iOzShare = col("Ounces of Gold per Share");
  const iNav = col("NAV/Share");
  const iTotalOz = col("Total Ounces of Gold");
  const iTonnes = col("Tonnes of Gold");
  const iVol = col("Daily Share Volume");
  if (iOzShare === -1 || iNav === -1) {
    throw new Error(`GLD archive: column layout changed — header is [${hdr.join(" | ")}]`);
  }

  const rows: any[][] = [];
  for (const r of grid.slice(hdrIdx + 1)) {
    const date = parseGldDate(r?.[0]);
    if (!date) continue; // holiday rows say "US Holiday" in numeric columns
    const navPerShare = num(r[iNav]);
    if (navPerShare === null) continue;
    const vol = num(r[iVol]);
    rows.push([
      date,
      num(r[iClose]),
      num(r[iOzShare]),
      navPerShare,
      iTotalOz === -1 ? null : num(r[iTotalOz]),
      iTonnes === -1 ? null : num(r[iTonnes]),
      vol === null ? null : Math.round(vol),
    ]);
  }
  return bulkUpsert(
    pool,
    "gold_history.gld_holdings",
    ["date", "close_usd", "oz_per_share", "nav_per_share", "total_oz", "tonnes", "volume"],
    ["date"],
    rows
  );
}

// ── Events: curated crises + Fed moves derived from FRED data ─────────────────

// Major, well-documented dates. Kept short deliberately — every entry must be
// unambiguous. Fed policy changes are NOT in this list; they are derived from
// the DFEDTAR/DFEDTARU series mathematically below.
const CURATED_EVENTS: [string, string, string, string][] = [
  ["1971-08-15", "Nixon ends dollar-gold convertibility", "MONETARY", "Close of the gold window; start of the free-floating gold era"],
  ["1979-11-04", "Iran hostage crisis begins", "GEOPOLITICS", "Contributed to the 1979–80 gold spike"],
  ["1980-01-21", "Gold peaks at $850 (1980 top)", "MARKET", "Intraday record that stood for 28 years"],
  ["1987-10-19", "Black Monday stock crash", "CRISIS", "Dow -22.6% in one day"],
  ["1999-09-26", "Washington Agreement on Gold", "MONETARY", "European central banks cap gold sales; major bottom in gold"],
  ["2001-09-11", "September 11 attacks", "GEOPOLITICS", "US markets closed four days"],
  ["2008-09-15", "Lehman Brothers collapse", "CRISIS", "Peak of the global financial crisis"],
  ["2010-05-09", "First Greek bailout / eurozone crisis", "CRISIS", "EU + IMF rescue package announced"],
  ["2011-08-05", "S&P downgrades US credit rating", "CRISIS", "First-ever US downgrade; gold made its 2011 top the following month"],
  ["2013-04-12", "Gold's two-day crash begins", "MARKET", "Largest two-day drop in 30 years (~-13%)"],
  ["2015-08-11", "China devalues the yuan", "MONETARY", "Surprise devaluation; global risk-off"],
  ["2016-06-23", "Brexit referendum", "GEOPOLITICS", "Gold's biggest one-day jump since 2008 followed"],
  ["2019-08-01", "US-China trade war escalation", "GEOPOLITICS", "New tariffs announced on remaining Chinese imports"],
  ["2020-03-11", "COVID-19 declared a pandemic", "CRISIS", "WHO declaration; liquidity crash then all-time highs"],
  ["2022-02-24", "Russia invades Ukraine", "GEOPOLITICS", "Reserve-asset freeze accelerated central-bank gold buying"],
  ["2023-03-10", "Silicon Valley Bank collapse", "CRISIS", "US regional banking stress"],
  ["2023-10-07", "Israel-Hamas war begins", "GEOPOLITICS", "Gold +9% in the following two weeks"],
  ["2025-04-02", "US 'Liberation Day' tariff announcement", "GEOPOLITICS", "Broad reciprocal tariffs; gold safe-haven bid"],
];

export async function seedHistoryEvents(pool: Pool): Promise<number> {
  const curated = await bulkUpsert(
    pool,
    "gold_history.events",
    ["date", "label", "category", "detail"],
    ["date", "label"],
    CURATED_EVENTS.map((e) => [...e])
  );
  // Fed policy changes derived from the target-rate series already in
  // fred_series — pure SQL, no hand-typed dates.
  const derived = await pool.query(`
    INSERT INTO gold_history.events (date, label, category, detail)
    SELECT date,
      CASE WHEN value > prev THEN 'Fed raises target to ' || value || '%'
           ELSE 'Fed cuts target to ' || value || '%' END,
      CASE WHEN value > prev THEN 'FED_HIKE' ELSE 'FED_CUT' END,
      'Derived from FRED ' || series_id || ' (previous ' || prev || '%)'
    FROM (
      SELECT series_id, date, value,
             LAG(value) OVER (PARTITION BY series_id ORDER BY date) AS prev
      FROM gold_history.fred_series
      WHERE series_id IN ('DFEDTAR', 'DFEDTARU')
    ) t
    WHERE prev IS NOT NULL AND value <> prev
    ON CONFLICT (date, label) DO NOTHING
  `);
  return curated + (derived.rowCount ?? 0);
}

// ── Orchestrator + validation ─────────────────────────────────────────────────

export interface HistorySyncResult {
  source: string;
  ok: boolean;
  rows?: number;
  error?: string;
}

export async function runHistorySync(pool: Pool): Promise<HistorySyncResult[]> {
  const results: HistorySyncResult[] = [];
  const steps: [string, () => Promise<number>][] = [
    ["lbma_prices", () => syncLbmaHistory(pool)],
    ["fred_series", () => syncFredHistory(pool)],
    ["gld_holdings", () => syncGldHistory(pool)],
    ["cot_reports", () => syncCotHistory(pool)],
    ["events", () => seedHistoryEvents(pool)],
  ];
  for (const [source, fn] of steps) {
    try {
      const rows = await fn();
      results.push({ source, ok: true, rows });
      console.log(`[goldhistory] ${source}: upserted ${rows} rows`);
    } catch (e: any) {
      results.push({ source, ok: false, error: e.message });
      console.error(`[goldhistory] ${source} FAILED: ${e.message}`);
    }
    // polite pause between different providers
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2500));
  }
  return results;
}

// Validation report: row counts, date ranges, freshness, recent gaps, sanity
// bounds, and the LBMA-vs-GLD cross-check (two independent institutions whose
// prices must agree — median difference should be ~0%).
export async function historySummary(pool: Pool) {
  const tables = await pool.query(`
    SELECT 'lbma_gold' AS t, COUNT(*) n, MIN(date) min_d, MAX(date) max_d FROM gold_history.lbma_prices WHERE metal='GOLD'
    UNION ALL
    SELECT 'lbma_silver', COUNT(*), MIN(date), MAX(date) FROM gold_history.lbma_prices WHERE metal='SILVER'
    UNION ALL
    SELECT 'fred_series (' || COUNT(DISTINCT series_id) || ' series)', COUNT(*), MIN(date), MAX(date) FROM gold_history.fred_series
    UNION ALL
    SELECT 'cot_gold', COUNT(*), MIN(report_date), MAX(report_date) FROM gold_history.cot_reports WHERE metal='GOLD'
    UNION ALL
    SELECT 'cot_silver', COUNT(*), MIN(report_date), MAX(report_date) FROM gold_history.cot_reports WHERE metal='SILVER'
    UNION ALL
    SELECT 'gld_holdings', COUNT(*), MIN(date), MAX(date) FROM gold_history.gld_holdings
    UNION ALL
    SELECT 'events', COUNT(*), MIN(date), MAX(date) FROM gold_history.events
  `);

  const crossCheck = await pool.query(`
    SELECT COUNT(*)::int AS days,
      ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY diff_pct))::numeric, 4) AS median_diff_pct,
      ROUND(MAX(diff_pct)::numeric, 2) AS max_diff_pct
    FROM (
      SELECT ABS(g.nav_per_share / NULLIF(g.oz_per_share, 0) - l.usd) / l.usd * 100 AS diff_pct
      FROM gold_history.gld_holdings g
      JOIN gold_history.lbma_prices l ON l.date = g.date AND l.metal = 'GOLD'
      WHERE g.oz_per_share > 0 AND l.usd > 0
    ) t
  `);

  const gaps = await pool.query(`
    SELECT metal, MAX(gap)::int AS max_gap_days
    FROM (
      SELECT metal, date::date - LAG(date::date) OVER (PARTITION BY metal ORDER BY date) AS gap
      FROM gold_history.lbma_prices
      WHERE date >= to_char(CURRENT_DATE - 365, 'YYYY-MM-DD')
    ) t
    WHERE gap IS NOT NULL
    GROUP BY metal
  `);

  const sanity = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM gold_history.lbma_prices WHERE metal='GOLD' AND (usd < 30 OR usd > 10000))::int AS gold_out_of_bounds,
      (SELECT COUNT(*) FROM gold_history.lbma_prices WHERE metal='SILVER' AND (usd < 1 OR usd > 500))::int AS silver_out_of_bounds,
      (SELECT COUNT(*) FROM gold_history.cot_reports WHERE open_interest <= 0)::int AS cot_nonpositive_oi,
      (SELECT COUNT(*) FROM gold_history.gld_holdings WHERE tonnes < 0 OR tonnes > 5000)::int AS gld_tonnes_out_of_bounds
  `);

  return {
    tables: tables.rows,
    crossCheck: {
      description:
        "GLD-implied gold price (NAV/share ÷ oz/share) vs LBMA PM fix — independent sources that must agree; median should be ~0%",
      ...crossCheck.rows[0],
    },
    recentGaps: {
      description: "Largest gap between consecutive LBMA prints in the last year (weekends/holidays make 3-4 days normal)",
      byMetal: gaps.rows,
    },
    sanityViolations: sanity.rows[0],
  };
}
