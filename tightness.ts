// tightness.ts — COMEX physical tightness gauge (0-100).
//
// One number answering "how physically tight is COMEX right now?", built
// the same way the pattern engine is built — honestly:
//
//   • Every component is a PERCENTILE of today's value against that
//     component's own available history. No invented scales: a score of 80
//     means "tighter than 80% of the days we can measure".
//   • Components without enough history report WARMING_UP and are excluded;
//     the composite renormalises over live components and publishes a
//     confidence figure (share of total weight that is live). n and window
//     are attached to every component — the UI must show them.
//   • Weights are fixed, documented here, and returned in the payload.
//     Changing them is a definition change — bump DEFINITION below.
//   • The gauge is a RELATIVE, same-day snapshot. It is not a forecast and
//     must never be presented as one.
//
// Daily scores are stored in tightness_daily; because each nightly run only
// sees data up to that day, the stored series is point-in-time by
// construction and can honestly be charted / backtested later.

import type pg from "pg";

type Pool = pg.Pool;

const OZ_PER_CONTRACT: Record<string, number> = { GOLD: 100, SILVER: 5000 };

export const DEFINITION = "tightness-v1";

// Fixed component weights (sum = 1). Coverage is the anchor: it is the most
// direct "claims vs deliverable metal" measure COMEX publishes.
const WEIGHTS = {
  coverage: 0.3, // OI oz per registered oz (higher = tighter)
  drawdown: 0.2, // 21d % change in registered oz (falling = tighter)
  deliveryPace: 0.2, // MTD deliveries vs same point in prior months
  houseStops: 0.15, // 5d share of stops going to dealer house accounts
  gldFlow: 0.15, // 21d change in GLD tonnes (inflows = tighter)
} as const;

type ComponentKey = keyof typeof WEIGHTS;

const MIN_OBS: Record<ComponentKey, number> = {
  coverage: 40,
  drawdown: 40,
  deliveryPace: 3, // prior months with data at the same day-of-month
  houseStops: 40,
  gldFlow: 60,
};

export type TightnessComponent = {
  key: ComponentKey;
  label: string;
  status: "LIVE" | "WARMING_UP";
  weight: number;
  // LIVE only:
  pctl: number | null; // 0-100, tightness-oriented (100 = tightest seen)
  raw: string | null; // human-readable current value
  n: number; // observations backing the percentile
  window: string; // what history the percentile ranks against
  note: string; // one-line plain-English meaning
};

export type TightnessResult = {
  metal: string;
  date: string; // data date the score describes (latest common input date)
  score: number | null; // null if no component is live
  confidence: number; // 0-1: share of total weight that is live
  zone: "LOOSE" | "NEUTRAL" | "ELEVATED" | "TIGHT" | null;
  definition: string;
  components: TightnessComponent[];
};

// ── helpers ──────────────────────────────────────────────────────────

/** Percentile rank (0-100) of the last value within the series. */
function pctlRank(series: number[]): number {
  const cur = series[series.length - 1];
  let below = 0;
  let equal = 0;
  for (const v of series) {
    if (v < cur) below++;
    else if (v === cur) equal++;
  }
  // midrank for ties, excluding the current observation itself
  const n = series.length;
  return n <= 1 ? 50 : ((below + (equal - 1) / 2) / (n - 1)) * 100;
}

function zoneFor(score: number): TightnessResult["zone"] {
  if (score >= 80) return "TIGHT";
  if (score >= 60) return "ELEVATED";
  if (score >= 40) return "NEUTRAL";
  return "LOOSE";
}

function fmtOz(v: number): string {
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M oz` : `${(v / 1e3).toFixed(0)}k oz`;
}

// ── component computations ───────────────────────────────────────────

/** Coverage: OI oz per registered oz, ranked over the joined daily series. */
async function computeCoverage(pool: Pool, metal: string): Promise<TightnessComponent> {
  const base: Omit<TightnessComponent, "status" | "pctl" | "raw" | "n" | "window"> = {
    key: "coverage",
    label: "Paper claims vs registered metal",
    weight: WEIGHTS.coverage,
    note: "Open-interest ounces per registered ounce. More claims per deliverable ounce = tighter.",
  };
  const res = await pool.query(
    `SELECT w.date, w.registered_oz, o.oi_contracts, o.oi_oz
       FROM warehouse_stocks w
       JOIN open_interest o ON o.date = w.date AND o.metal = w.metal
      WHERE w.metal = $1 AND w.registered_oz > 0
      ORDER BY w.date ASC`,
    [metal]
  );
  const series = res.rows.map((r) => {
    const oiOz = r.oi_oz != null ? Number(r.oi_oz) : Number(r.oi_contracts) * OZ_PER_CONTRACT[metal];
    return { date: r.date as string, ratio: oiOz / Number(r.registered_oz) };
  });
  if (series.length < MIN_OBS.coverage) {
    return { ...base, status: "WARMING_UP", pctl: null, raw: null, n: series.length, window: `need ${MIN_OBS.coverage}+ joint warehouse/OI days, have ${series.length}` };
  }
  const last = series[series.length - 1];
  return {
    ...base,
    status: "LIVE",
    pctl: pctlRank(series.map((s) => s.ratio)), // higher ratio = tighter, rank directly
    raw: `${last.ratio.toFixed(1)} oz of OI per registered oz`,
    n: series.length,
    window: `${series[0].date} → ${last.date}`,
  };
}

/** Drawdown: 21-day % change in registered oz, ranked inverted (falls = tight). */
async function computeDrawdown(pool: Pool, metal: string): Promise<TightnessComponent> {
  const base = {
    key: "drawdown" as const,
    label: "Registered stock drawdown (21d)",
    weight: WEIGHTS.drawdown,
    note: "How fast deliverable metal is leaving the registered category vs history.",
  };
  const res = await pool.query(
    `SELECT date, registered_oz FROM warehouse_stocks
      WHERE metal = $1 AND registered_oz > 0 ORDER BY date ASC`,
    [metal]
  );
  const rows = res.rows.map((r) => ({ date: r.date as string, oz: Number(r.registered_oz) }));
  const changes: number[] = [];
  for (let i = 21; i < rows.length; i++) {
    changes.push((rows[i].oz - rows[i - 21].oz) / rows[i - 21].oz);
  }
  if (changes.length < MIN_OBS.drawdown) {
    return { ...base, status: "WARMING_UP", pctl: null, raw: null, n: changes.length, window: `need ${MIN_OBS.drawdown}+ rolling-21d observations, have ${changes.length}` };
  }
  const cur = changes[changes.length - 1];
  return {
    ...base,
    status: "LIVE",
    pctl: 100 - pctlRank(changes), // biggest falls = highest tightness
    raw: `${(cur * 100).toFixed(1)}% in 21 trading days (${fmtOz(rows[rows.length - 1].oz)} registered)`,
    n: changes.length,
    window: `${rows[21].date} → ${rows[rows.length - 1].date}`,
  };
}

/** Delivery pace: MTD deliveries vs the same day-of-month in prior months. */
async function computeDeliveryPace(pool: Pool, metal: string): Promise<TightnessComponent> {
  const base = {
    key: "deliveryPace" as const,
    label: "Delivery pace (month-to-date)",
    weight: WEIGHTS.deliveryPace,
    note: "This month's deliveries at this point in the month vs prior months.",
  };
  const res = await pool.query(
    `SELECT date, mtd FROM metals_summary
      WHERE metal = $1 AND report_type = 'MTD' AND mtd IS NOT NULL
      ORDER BY date ASC`,
    [metal]
  );
  const rows = res.rows.map((r) => ({ date: r.date as string, mtd: Number(r.mtd) }));
  if (!rows.length) {
    return { ...base, status: "WARMING_UP", pctl: null, raw: null, n: 0, window: "no MTD summary rows yet" };
  }
  const last = rows[rows.length - 1];
  const dom = Number(last.date.slice(8, 10));
  const curMonth = last.date.slice(0, 7);
  // For each prior month: MTD on the last report at or before this day-of-month.
  const priorByMonth = new Map<string, number>();
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    if (m === curMonth) continue;
    if (Number(r.date.slice(8, 10)) <= dom) priorByMonth.set(m, r.mtd);
  }
  const priors = [...priorByMonth.values()];
  if (priors.length < MIN_OBS.deliveryPace) {
    return { ...base, status: "WARMING_UP", pctl: null, raw: null, n: priors.length, window: `need ${MIN_OBS.deliveryPace}+ prior months at day ${dom}, have ${priors.length}` };
  }
  return {
    ...base,
    status: "LIVE",
    pctl: pctlRank([...priors, last.mtd]),
    raw: `${last.mtd.toLocaleString()} contracts MTD by day ${dom}`,
    n: priors.length + 1,
    window: `${priors.length} prior months`,
  };
}

/** House stops: 5-day share of stopped contracts landing in dealer house accounts. */
async function computeHouseStops(pool: Pool, metal: string): Promise<TightnessComponent> {
  const base = {
    key: "houseStops" as const,
    label: "Dealer house-account stops (5d)",
    weight: WEIGHTS.houseStops,
    note: "Dealers taking delivery for their own book — historically a conviction signal.",
  };
  const res = await pool.query(
    `SELECT date,
            SUM(stopped) FILTER (WHERE account_type = 'HOUSE') AS house,
            SUM(stopped) AS total
       FROM delivery_notices
      WHERE metal = $1
      GROUP BY date HAVING SUM(stopped) > 0
      ORDER BY date ASC`,
    [metal]
  );
  const days = res.rows.map((r) => ({ house: Number(r.house ?? 0), total: Number(r.total) }));
  // rolling 5-day share
  const shares: number[] = [];
  for (let i = 4; i < days.length; i++) {
    const w = days.slice(i - 4, i + 1);
    const tot = w.reduce((s, d) => s + d.total, 0);
    if (tot > 0) shares.push(w.reduce((s, d) => s + d.house, 0) / tot);
  }
  if (shares.length < MIN_OBS.houseStops) {
    return { ...base, status: "WARMING_UP", pctl: null, raw: null, n: shares.length, window: `need ${MIN_OBS.houseStops}+ rolling-5d observations, have ${shares.length}` };
  }
  const cur = shares[shares.length - 1];
  return {
    ...base,
    status: "LIVE",
    pctl: pctlRank(shares),
    raw: `${(cur * 100).toFixed(0)}% of stops to house accounts (5d)`,
    n: shares.length,
    window: `${res.rows[0].date} → ${res.rows[res.rows.length - 1].date}`,
  };
}

/** GLD flow: 21-day change in GLD tonnes, ranked over history since 2004. */
async function computeGldFlow(pool: Pool, metal: string): Promise<TightnessComponent> {
  const base = {
    key: "gldFlow" as const,
    label: "ETF metal demand (GLD, 21d)",
    weight: WEIGHTS.gldFlow,
    note: "Physical metal flowing into (or out of) the largest gold trust vs 20 years of history.",
  };
  if (metal !== "GOLD") {
    return { ...base, status: "WARMING_UP", pctl: null, raw: null, n: 0, window: "GOLD only (no silver trust series yet)" };
  }
  const res = await pool.query(
    `SELECT date, tonnes FROM gold_history.gld_holdings WHERE tonnes IS NOT NULL ORDER BY date ASC`
  );
  const rows = res.rows.map((r) => ({ date: String(r.date).slice(0, 10), t: Number(r.tonnes) }));
  const changes: number[] = [];
  for (let i = 21; i < rows.length; i++) changes.push(rows[i].t - rows[i - 21].t);
  if (changes.length < MIN_OBS.gldFlow) {
    return { ...base, status: "WARMING_UP", pctl: null, raw: null, n: changes.length, window: `need ${MIN_OBS.gldFlow}+ observations, have ${changes.length}` };
  }
  const cur = changes[changes.length - 1];
  return {
    ...base,
    status: "LIVE",
    pctl: pctlRank(changes),
    raw: `${cur >= 0 ? "+" : ""}${cur.toFixed(1)} tonnes in 21 sessions (${rows[rows.length - 1].t.toFixed(0)}t held)`,
    n: changes.length,
    window: `${rows[21].date} → ${rows[rows.length - 1].date}`,
  };
}

// ── composite ────────────────────────────────────────────────────────

export async function ensureTightnessTables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tightness_daily (
      id BIGSERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      metal TEXT NOT NULL,
      score REAL,
      confidence REAL NOT NULL,
      zone TEXT,
      definition TEXT NOT NULL,
      components JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(date, metal)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_tightness_metal_date ON tightness_daily(metal, date DESC)`
  );
}

export async function computeTightness(pool: Pool, metal: string): Promise<TightnessResult> {
  const m = metal.toUpperCase();
  const components = await Promise.all([
    computeCoverage(pool, m),
    computeDrawdown(pool, m),
    computeDeliveryPace(pool, m),
    computeHouseStops(pool, m),
    computeGldFlow(pool, m),
  ]);

  const live = components.filter((c) => c.status === "LIVE" && c.pctl != null);
  const liveWeight = live.reduce((s, c) => s + c.weight, 0);
  const score =
    liveWeight > 0
      ? Math.round(live.reduce((s, c) => s + (c.pctl as number) * c.weight, 0) / liveWeight)
      : null;

  // data date = latest warehouse date if present, else today's latest input
  const d = await pool.query(
    `SELECT MAX(date) AS d FROM warehouse_stocks WHERE metal = $1`,
    [m]
  );
  const date: string =
    d.rows[0]?.d ?? new Date().toISOString().slice(0, 10);

  return {
    metal: m,
    date,
    score,
    confidence: Number(liveWeight.toFixed(2)),
    zone: score == null ? null : zoneFor(score),
    definition: DEFINITION,
    components,
  };
}

export async function runAndStoreTightness(pool: Pool, metal: string): Promise<TightnessResult> {
  const result = await computeTightness(pool, metal);
  await pool.query(
    `INSERT INTO tightness_daily (date, metal, score, confidence, zone, definition, components)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (date, metal) DO UPDATE SET
       score = EXCLUDED.score,
       confidence = EXCLUDED.confidence,
       zone = EXCLUDED.zone,
       definition = EXCLUDED.definition,
       components = EXCLUDED.components,
       created_at = CURRENT_TIMESTAMP`,
    [result.date, result.metal, result.score, result.confidence, result.zone, result.definition, JSON.stringify(result.components)]
  );
  return result;
}

export async function getTightnessHistory(pool: Pool, metal: string, days = 90) {
  const res = await pool.query(
    `SELECT date, score, confidence, zone FROM tightness_daily
      WHERE metal = $1 AND score IS NOT NULL
      ORDER BY date DESC LIMIT $2`,
    [metal.toUpperCase(), days]
  );
  return res.rows.reverse();
}
