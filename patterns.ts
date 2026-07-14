// patterns.ts — pre-registered pattern backtest engine over the gold_history DB.
//
// Every statistical guardrail lives HERE, in one shared engine, so no pattern
// can dodge them:
//
//   • Point-in-time only — every input series is shifted by its real-world
//     publication lag (COT +3 days, dollar index +7, etc.) before any signal
//     is computed, and all percentiles are EXPANDING-WINDOW (a day is ranked
//     only against days that came before it). The engine cannot see the future.
//   • Episodes, not days — consecutive signal-days collapse into one episode;
//     new episodes require 63 trading days of separation. n = episodes.
//   • Wilson confidence intervals on every hit rate; n < 15 episodes is
//     reported as INSUFFICIENT with no percentage at all.
//   • One-shot pre-registration — hypotheses are frozen in code; the engine
//     stores a hash of each definition and refuses to overwrite a pattern
//     whose definition changed (that's a new pattern, with visible lineage).
//   • Holdout — stats are computed on the first and second halves of the
//     episode history separately; the effect must hold in both.
//   • Adjacent-horizon consistency — the effect must have the same sign on at
//     least two adjacent horizons (1m/3m/6m); one lucky horizon doesn't count.
//   • Robustness — every thresholded pattern is re-run with perturbed
//     thresholds (its `variants`); the effect direction must be stable.
//   • Pre-float exclusion — nothing before 1971-08-16 (Nixon closed the gold
//     window on the 15th); pegged prices are not market data.
//   • Library-level honesty — the summary reports how many "survivors" would
//     be expected by pure chance across all patterns tested.
//
// GOLD only in v1 (silver's industrial-demand profile needs its own
// pre-registered list — patterns must not be blindly copy-pasted across).

import crypto from "crypto";
import type pg from "pg";

type Pool = pg.Pool;

const PRE_FLOAT_CUTOFF = "1971-08-16";
const HORIZONS = [21, 63, 126]; // trading days ≈ 1m / 3m / 6m
const MIN_EPISODES = 15;
const EPISODE_SEPARATION = 63; // trading days between episode starts
const PCTL_WARMUP = 504; // ~2 years of observations before percentiles exist
// Rough probability that a null pattern passes all sign-based checks by luck
// (direction, holdout, adjacent-horizon ≈ three coin flips). Used only for the
// library-level "expected by chance" disclosure.
const CHANCE_PASS_RATE = 0.125;

// Publication lags (calendar days): how long after its "as of" date each
// series actually becomes public knowledge. Backtests only ever see data
// through this lens.
const LAG_DAYS = {
  LBMA: 0,      // fixed and published same afternoon; entry is next day's price anyway
  FRED_DAILY: 1, // DFII10/VIX etc. post next business day
  DOLLAR: 7,     // Fed H.10 dollar indexes are released weekly
  FED_TARGET: 1, // announced same day; +1 conservative
  COT: 3,        // measured Tuesday, published Friday
  GLD: 1,        // trust publishes after the close
};

// ── Pattern registry (PRE-REGISTERED — do not tweak after seeing results) ─────
//
// Changing any definition changes its hash; the engine will refuse to
// overwrite the old row and you must give the revision a NEW id (lineage stays
// visible in the library). Failed patterns stay in the library as NO_EDGE —
// the graveyard is part of the product.

interface Hypothesis {
  id: string;
  family: string;
  name: string;
  description: string; // plain English, shown on the card
  rationale: string;   // the ex-ante economic reason this could work
  direction: "UP" | "DOWN"; // expected gold direction after the signal
  primaryHorizon: number;
  params: Record<string, number>;
  variants: Record<string, number>[]; // perturbed params for the robustness check
  build: (ctx: Ctx, p: Record<string, number>) => boolean[];
}

const HYPOTHESES: Hypothesis[] = [
  {
    id: "first-fed-cut",
    family: "RATES",
    name: "First Fed cut of a cycle",
    description:
      "The Federal Reserve cuts its target rate for the first time in at least a year (data starts 1982 — the Fed target series begins there).",
    rationale: "Easing cycles lower the opportunity cost of holding gold and usually accompany a weakening economy.",
    direction: "UP",
    primaryHorizon: 126,
    params: { quietDays: 252 },
    variants: [{ quietDays: 189 }, { quietDays: 315 }],
    build: (ctx, p) => firstMoveSignal(ctx.fedTarget, "CUT", p.quietDays),
  },
  {
    id: "first-fed-hike",
    family: "RATES",
    name: "First Fed hike of a cycle",
    description: "The Fed raises its target rate for the first time in at least a year (data starts 1982).",
    rationale: "Tightening raises the opportunity cost of holding gold.",
    direction: "DOWN",
    primaryHorizon: 126,
    params: { quietDays: 252 },
    variants: [{ quietDays: 189 }, { quietDays: 315 }],
    build: (ctx, p) => firstMoveSignal(ctx.fedTarget, "HIKE", p.quietDays),
  },
  {
    id: "real-yields-plunge",
    family: "RATES",
    name: "Real yields falling hard",
    description:
      "The 10-year real (inflation-adjusted) Treasury yield has fallen over the past 3 months by more than it did in 90% of history (data starts 2003 — TIPS yields begin there).",
    rationale: "Falling real yields are gold's most documented driver: gold pays no interest, so it competes best when bonds pay least in real terms.",
    direction: "UP",
    primaryHorizon: 63,
    params: { pctl: 10 },
    variants: [{ pctl: 5 }, { pctl: 15 }],
    build: (ctx, p) => pctlBelow(ctx.realYieldChg63Pctl, p.pctl),
  },
  {
    id: "dollar-slide",
    family: "DOLLAR",
    name: "Dollar sliding hard",
    description:
      "The trade-weighted dollar index has fallen over the past 3 months by more than it did in 90% of history.",
    rationale: "Gold is priced in dollars; a weaker dollar mechanically supports it and signals easier global conditions.",
    direction: "UP",
    primaryHorizon: 63,
    params: { pctl: 10 },
    variants: [{ pctl: 5 }, { pctl: 15 }],
    build: (ctx, p) => pctlBelow(ctx.dollarChg63Pctl, p.pctl),
  },
  {
    id: "double-tailwind",
    family: "DOLLAR",
    name: "Double tailwind: dollar + real yields both falling",
    description:
      "Both the dollar and real yields have fallen over the past 3 months — gold's two classic drivers pushing the same way (data starts 2003).",
    rationale: "Each driver alone helps; both together is the textbook bullish macro configuration.",
    direction: "UP",
    primaryHorizon: 63,
    params: { pctl: 25 },
    variants: [{ pctl: 20 }, { pctl: 30 }],
    build: (ctx, p) =>
      and(pctlBelow(ctx.realYieldChg63Pctl, p.pctl), pctlBelow(ctx.dollarChg63Pctl, p.pctl)),
  },
  {
    id: "specs-crowded-long",
    family: "POSITIONING",
    name: "Speculators crowded long",
    description:
      "Futures speculators' net long position (as a share of open interest) is in the top 10% of history (weekly data since 1986).",
    rationale: "When everyone who could buy already has, there's nobody left to push the price up — a contrarian warning.",
    direction: "DOWN",
    primaryHorizon: 63,
    params: { pctl: 90 },
    variants: [{ pctl: 85 }, { pctl: 95 }],
    build: (ctx, p) => pctlAbove(ctx.cotNetPctl, p.pctl),
  },
  {
    id: "specs-washed-out",
    family: "POSITIONING",
    name: "Speculators washed out",
    description:
      "Futures speculators' net long position (as a share of open interest) is in the bottom 10% of history.",
    rationale: "When speculative money has given up, selling pressure is exhausted — a contrarian buy setup.",
    direction: "UP",
    primaryHorizon: 63,
    params: { pctl: 10 },
    variants: [{ pctl: 5 }, { pctl: 15 }],
    build: (ctx, p) => pctlBelow(ctx.cotNetPctl, p.pctl),
  },
  {
    id: "gld-inflow-surge",
    family: "FLOWS",
    name: "ETF inflow surge",
    description:
      "Gold held by the GLD trust grew over the past month by more than in 90% of history (data starts 2004).",
    rationale: "Strong ETF inflows show Western investment demand arriving in size; flows tend to persist.",
    direction: "UP",
    primaryHorizon: 63,
    params: { pctl: 90 },
    variants: [{ pctl: 85 }, { pctl: 95 }],
    build: (ctx, p) => pctlAbove(ctx.gldChg21Pctl, p.pctl),
  },
  {
    id: "gld-exodus",
    family: "FLOWS",
    name: "ETF exodus",
    description: "Gold held by the GLD trust shrank over the past month by more than in 90% of history.",
    rationale: "Heavy ETF outflows show Western investment demand leaving; flows tend to persist.",
    direction: "DOWN",
    primaryHorizon: 63,
    params: { pctl: 10 },
    variants: [{ pctl: 5 }, { pctl: 15 }],
    build: (ctx, p) => pctlBelow(ctx.gldChg21Pctl, p.pctl),
  },
  {
    id: "fresh-52w-high",
    family: "MOMENTUM",
    name: "Fresh 52-week high",
    description: "Gold closes above every close of the previous year, for the first time in at least 3 months.",
    rationale: "Breakouts to new highs mean no overhead sellers sitting at breakeven; gold historically trends.",
    direction: "UP",
    primaryHorizon: 126,
    params: { lookback: 252 },
    variants: [{ lookback: 189 }, { lookback: 315 }],
    build: (ctx, p) => freshHighSignal(ctx.gold, p.lookback),
  },
  {
    id: "deep-pullback",
    family: "MOMENTUM",
    name: "Deep pullback in a structural bull",
    description: "Gold has dropped 15% or more below its 52-week high (measured the first day it crosses the line).",
    rationale: "Gold's long-run drift is up; deep dips in a structurally rising asset have tended to be buying panics, not new information.",
    direction: "UP",
    primaryHorizon: 126,
    params: { ddPct: 15 },
    variants: [{ ddPct: 12 }, { ddPct: 18 }],
    build: (ctx, p) => drawdownSignal(ctx.gold, 252, p.ddPct),
  },
  {
    id: "vix-spike",
    family: "FEAR",
    name: "Equity fear spike",
    description: "The VIX (stock-market fear index) is in the top 5% of its history (data starts 1990).",
    rationale: "Panic in equities sends safe-haven flows toward gold.",
    direction: "UP",
    primaryHorizon: 63,
    params: { pctl: 95 },
    variants: [{ pctl: 92 }, { pctl: 98 }],
    build: (ctx, p) => pctlAbove(ctx.vixPctl, p.pctl),
  },
  {
    id: "september-seasonal",
    family: "SEASONALITY",
    name: "September seasonal",
    description: "Buy on the first trading day of September (the folklore 'wedding season' trade).",
    rationale: "Folklore: festival/wedding gold demand in India lifts autumn prices. Included to be tested honestly, not because we believe it.",
    direction: "UP",
    primaryHorizon: 63,
    params: { month: 9 },
    variants: [{ month: 8 }, { month: 10 }],
    build: (ctx, p) => firstDayOfMonthSignal(ctx.timeline, p.month),
  },
];

// ── Signal helpers ─────────────────────────────────────────────────────────────

const and = (a: boolean[], b: boolean[]) => a.map((v, i) => v && b[i]);
const pctlBelow = (pctl: (number | null)[], t: number) => pctl.map((v) => v !== null && v <= t);
const pctlAbove = (pctl: (number | null)[], t: number) => pctl.map((v) => v !== null && v >= t);

function firstMoveSignal(target: (number | null)[], kind: "CUT" | "HIKE", quietDays: number): boolean[] {
  const move = target.map((v, i) => {
    const prev = i > 0 ? target[i - 1] : null;
    if (v === null || prev === null) return false;
    return kind === "CUT" ? v < prev : v > prev;
  });
  return move.map((m, i) => {
    if (!m) return false;
    for (let j = Math.max(0, i - quietDays); j < i; j++) if (move[j]) return false;
    return true;
  });
}

function freshHighSignal(price: (number | null)[], lookback: number): boolean[] {
  return price.map((v, i) => {
    if (v === null || i < lookback) return false;
    for (let j = i - lookback; j < i; j++) {
      const pj = price[j];
      if (pj !== null && pj >= v) return false;
    }
    return true;
  });
}

function drawdownSignal(price: (number | null)[], lookback: number, ddPct: number): boolean[] {
  const dd = price.map((v, i) => {
    if (v === null || i < lookback) return null;
    let max = -Infinity;
    for (let j = i - lookback; j <= i; j++) {
      const pj = price[j];
      if (pj !== null && pj > max) max = pj;
    }
    return max > 0 ? (v / max - 1) * 100 : null;
  });
  // fire on the day the drawdown first crosses the threshold
  return dd.map((v, i) => {
    const prev = i > 0 ? dd[i - 1] : null;
    return v !== null && v <= -ddPct && (prev === null || prev > -ddPct);
  });
}

function firstDayOfMonthSignal(timeline: string[], month: number): boolean[] {
  return timeline.map((d, i) => {
    const m = parseInt(d.slice(5, 7), 10);
    if (m !== month) return false;
    const prev = i > 0 ? parseInt(timeline[i - 1].slice(5, 7), 10) : null;
    return prev !== m;
  });
}

// ── Point-in-time machinery ───────────────────────────────────────────────────

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Forward-fill a raw (asOfDate, value) series onto the trading-day timeline,
// but only make each value visible from its PUBLICATION date onward.
function alignToTimeline(
  timeline: string[],
  raw: [string, number][],
  lagDays: number
): (number | null)[] {
  const known: [string, number][] = raw
    .map(([d, v]) => [addDays(d, lagDays), v] as [string, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const out: (number | null)[] = new Array(timeline.length).fill(null);
  let j = 0;
  let cur: number | null = null;
  for (let i = 0; i < timeline.length; i++) {
    while (j < known.length && known[j][0] <= timeline[i]) {
      cur = known[j][1];
      j++;
    }
    out[i] = cur;
  }
  return out;
}

// Expanding-window percentile: each day is ranked ONLY against prior days.
function expandingPctl(vals: (number | null)[], warmup = PCTL_WARMUP): (number | null)[] {
  const sorted: number[] = [];
  const out: (number | null)[] = [];
  for (const v of vals) {
    if (v === null) {
      out.push(null);
      continue;
    }
    if (sorted.length >= warmup) {
      let lo = 0, hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= v) lo = mid + 1;
        else hi = mid;
      }
      out.push((100 * lo) / sorted.length);
    } else {
      out.push(null);
    }
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    sorted.splice(lo, 0, v);
  }
  return out;
}

function changeOver(vals: (number | null)[], k: number): (number | null)[] {
  return vals.map((v, i) => {
    const prev = i >= k ? vals[i - k] : null;
    return v !== null && prev !== null ? v - prev : null;
  });
}

// Deduplicate: only the LAST value per timeline day survives forward-fill, so
// series sampled less often than daily (COT weekly, monthly data) are fine.

// ── Data context ──────────────────────────────────────────────────────────────

interface Ctx {
  timeline: string[];
  gold: (number | null)[]; // LBMA PM fix, the return series
  fedTarget: (number | null)[];
  realYieldChg63Pctl: (number | null)[];
  dollarChg63Pctl: (number | null)[];
  cotNetPctl: (number | null)[];
  gldChg21Pctl: (number | null)[];
  vixPctl: (number | null)[];
}

async function loadCtx(pool: Pool): Promise<Ctx> {
  const lbma = await pool.query(
    `SELECT date, usd FROM gold_history.lbma_prices
     WHERE metal='GOLD' AND date >= $1 ORDER BY date`,
    [PRE_FLOAT_CUTOFF]
  );
  const timeline: string[] = lbma.rows.map((r: any) => r.date);
  const gold: (number | null)[] = lbma.rows.map((r: any) => Number(r.usd));

  const fred = await pool.query(
    `SELECT series_id, date, value FROM gold_history.fred_series
     WHERE series_id IN ('DFII10','DTWEXBGS','DTWEXM','DFEDTAR','DFEDTARU','VIXCLS')
     ORDER BY date`
  );
  const bySeries: Record<string, [string, number][]> = {};
  for (const r of fred.rows) {
    (bySeries[r.series_id] ??= []).push([r.date, Number(r.value)]);
  }

  // Fed target: DFEDTAR through 2008-12-15, DFEDTARU after (upper bound).
  const fedRaw = [
    ...(bySeries.DFEDTAR ?? []).filter(([d]) => d <= "2008-12-15"),
    ...(bySeries.DFEDTARU ?? []).filter(([d]) => d > "2008-12-15"),
  ];
  const fedTarget = alignToTimeline(timeline, fedRaw, LAG_DAYS.FED_TARGET);

  const realYield = alignToTimeline(timeline, bySeries.DFII10 ?? [], LAG_DAYS.FRED_DAILY);
  const realYieldChg63Pctl = expandingPctl(changeOver(realYield, 63));

  // Dollar composite: DTWEXM (1973–2005) then DTWEXBGS (2006+). Percentiles are
  // computed on 63-day CHANGES, so the level jump at the seam doesn't matter.
  const dollarRaw = [
    ...(bySeries.DTWEXM ?? []).filter(([d]) => d < "2006-01-01"),
    ...(bySeries.DTWEXBGS ?? []),
  ];
  const dollar = alignToTimeline(timeline, dollarRaw, LAG_DAYS.DOLLAR);
  const dollarChg63Pctl = expandingPctl(changeOver(dollar, 63));

  const cot = await pool.query(
    `SELECT report_date, noncomm_long, noncomm_short, open_interest
     FROM gold_history.cot_reports
     WHERE metal='GOLD' AND open_interest > 0 ORDER BY report_date`
  );
  // Net spec position as a share of open interest — normalizes 40 years of
  // market growth out of the number.
  const cotRaw: [string, number][] = cot.rows
    .filter((r: any) => r.noncomm_long !== null && r.noncomm_short !== null)
    .map((r: any) => [
      r.report_date,
      (Number(r.noncomm_long) - Number(r.noncomm_short)) / Number(r.open_interest),
    ]);
  // weekly data → smaller warmup (~2 years of weekly prints ≈ 104 obs on the
  // raw series, but we align daily first so use the standard warmup on days)
  const cotNetPctl = expandingPctl(alignToTimeline(timeline, cotRaw, LAG_DAYS.COT));

  const gld = await pool.query(
    `SELECT date, tonnes FROM gold_history.gld_holdings WHERE tonnes IS NOT NULL ORDER BY date`
  );
  const gldRaw: [string, number][] = gld.rows.map((r: any) => [r.date, Number(r.tonnes)]);
  const gldChg21Pctl = expandingPctl(
    changeOver(alignToTimeline(timeline, gldRaw, LAG_DAYS.GLD), 21)
  );

  const vixPctl = expandingPctl(alignToTimeline(timeline, bySeries.VIXCLS ?? [], LAG_DAYS.FRED_DAILY));

  return { timeline, gold, fedTarget, realYieldChg63Pctl, dollarChg63Pctl, cotNetPctl, gldChg21Pctl, vixPctl };
}

// ── Backtest core ─────────────────────────────────────────────────────────────

function episodeStarts(signal: boolean[]): number[] {
  const starts: number[] = [];
  let lastStart = -Infinity;
  for (let i = 1; i < signal.length; i++) {
    if (signal[i] && !signal[i - 1] && i - lastStart >= EPISODE_SEPARATION) {
      starts.push(i);
      lastStart = i;
    }
  }
  return starts;
}

interface EpisodeOutcome {
  date: string;
  entryIdx: number;
  rets: Record<number, number | null>; // horizon → % return
  mae: Record<number, number | null>;  // worst % drawdown before the horizon
}

function measureEpisodes(ctx: Ctx, starts: number[]): EpisodeOutcome[] {
  const out: EpisodeOutcome[] = [];
  for (const s of starts) {
    const entryIdx = s + 1; // enter at the NEXT day's price — no same-day fills
    const entry = ctx.gold[entryIdx];
    if (entryIdx >= ctx.gold.length || entry === null) continue;
    const rets: Record<number, number | null> = {};
    const mae: Record<number, number | null> = {};
    for (const h of HORIZONS) {
      const exitIdx = entryIdx + h;
      if (exitIdx >= ctx.gold.length || ctx.gold[exitIdx] === null) {
        rets[h] = null;
        mae[h] = null;
        continue;
      }
      rets[h] = ((ctx.gold[exitIdx]! / entry) - 1) * 100;
      let worst = 0;
      for (let j = entryIdx + 1; j <= exitIdx; j++) {
        const pj = ctx.gold[j];
        if (pj !== null) worst = Math.min(worst, (pj / entry - 1) * 100);
      }
      mae[h] = worst;
    }
    out.push({ date: ctx.timeline[s], entryIdx, rets, mae });
  }
  return out;
}

function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 100];
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [(100 * (c - m)) / d, (100 * (c + m)) / d];
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function horizonStats(episodes: EpisodeOutcome[], h: number, direction: "UP" | "DOWN") {
  const rets = episodes.map((e) => e.rets[h]).filter((r): r is number => r !== null);
  const maes = episodes.map((e) => e.mae[h]).filter((r): r is number => r !== null);
  const n = rets.length;
  if (n === 0) return null;
  const hits = rets.filter((r) => (direction === "UP" ? r > 0 : r < 0)).length;
  const [lo, hi] = wilson(hits, n);
  const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    n,
    hits,
    hitRate: r2((100 * hits) / n),
    wilsonLo: r2(lo),
    wilsonHi: r2(hi),
    median: r2(median(rets)),
    mean: r2(rets.reduce((a, b) => a + b, 0) / n),
    best: r2(Math.max(...rets)),
    worst: r2(Math.min(...rets)),
    medianMae: r2(median(maes)),
  };
}

function eraStats(episodes: EpisodeOutcome[], direction: "UP" | "DOWN") {
  const byHorizon: Record<string, any> = {};
  for (const h of HORIZONS) byHorizon[h] = horizonStats(episodes, h, direction);
  return byHorizon;
}

// ── Per-pattern evaluation with all checks ────────────────────────────────────

function evaluate(ctx: Ctx, hyp: Hypothesis, recentCutoffDate: string) {
  const signal = hyp.build(ctx, hyp.params);
  const episodes = measureEpisodes(ctx, episodeStarts(signal));
  const nFull = episodes.filter((e) => e.rets[hyp.primaryHorizon] !== null).length;

  const half = Math.floor(episodes.length / 2);
  const eras = {
    full: eraStats(episodes, hyp.direction),
    firstHalf: eraStats(episodes.slice(0, half), hyp.direction),
    secondHalf: eraStats(episodes.slice(half), hyp.direction),
    recent: eraStats(episodes.filter((e) => e.date >= recentCutoffDate), hyp.direction),
  };

  const sign = (x: number | null | undefined) =>
    x === null || x === undefined ? null : x > 0 ? 1 : x < 0 ? -1 : 0;
  const expected = hyp.direction === "UP" ? 1 : -1;
  const ph = hyp.primaryHorizon;

  // Check 1 — direction: full-sample median at the primary horizon has the
  // predicted sign AND the hit rate is above 50.
  const fullPrimary = eras.full[ph];
  const direction =
    !!fullPrimary && sign(fullPrimary.median) === expected && fullPrimary.hitRate! > 50;

  // Check 2 — holdout: both halves of the episode history agree on the sign.
  const holdout =
    sign(eras.firstHalf[ph]?.median) === expected && sign(eras.secondHalf[ph]?.median) === expected;

  // Check 3 — adjacent horizons: at least two ADJACENT horizons share the sign.
  const signs = HORIZONS.map((h) => sign(eras.full[h]?.median));
  const adjacent = signs.some((s, i) => i > 0 && s === expected && signs[i - 1] === expected);

  // Check 4 — robustness: every perturbed variant keeps the sign of the
  // full-sample median at the primary horizon.
  const variantResults = hyp.variants.map((vp) => {
    const vEpisodes = measureEpisodes(ctx, episodeStarts(hyp.build(ctx, vp)));
    const vStats = horizonStats(vEpisodes, ph, hyp.direction);
    return { params: vp, n: vStats?.n ?? 0, median: vStats?.median ?? null };
  });
  const robust = variantResults.every((v) => sign(v.median) === expected);

  const checks = { direction, holdout, adjacent, robust };
  const status =
    nFull < MIN_EPISODES ? "INSUFFICIENT" : Object.values(checks).every(Boolean) ? "SURVIVED" : "NO_EDGE";

  // Is the signal live right now? (last day of the timeline)
  const activeToday = signal[signal.length - 1] === true;

  return { eras, checks, status, nFull, variantResults, activeToday };
}

// ── Storage (frozen registry) ─────────────────────────────────────────────────

export async function ensurePatternTables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_history.pattern_stats (
      pattern_id TEXT PRIMARY KEY,
      definition_hash TEXT NOT NULL,
      family TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      rationale TEXT,
      metal TEXT NOT NULL DEFAULT 'GOLD',
      expected_direction TEXT,
      primary_horizon INT,
      status TEXT,
      n_episodes INT,
      checks JSONB,
      results JSONB,
      variants JSONB,
      active_today BOOLEAN DEFAULT FALSE,
      first_registered TIMESTAMP DEFAULT NOW(),
      computed_at TIMESTAMP
    )
  `);
}

function definitionHash(h: Hypothesis): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        id: h.id,
        direction: h.direction,
        primaryHorizon: h.primaryHorizon,
        params: h.params,
        variants: h.variants,
        build: h.build.toString(),
      })
    )
    .digest("hex")
    .slice(0, 16);
}

export async function runPatternEngine(pool: Pool) {
  const ctx = await loadCtx(pool);
  if (ctx.timeline.length < 2000) {
    throw new Error(
      `gold_history has only ${ctx.timeline.length} price days — run /api/goldhistory/sync first`
    );
  }
  const lastDate = ctx.timeline[ctx.timeline.length - 1];
  const recentCutoff = addDays(lastDate, -365 * 5);

  const report: any[] = [];
  for (const hyp of HYPOTHESES) {
    const hash = definitionHash(hyp);
    const existing = await pool.query(
      `SELECT definition_hash FROM gold_history.pattern_stats WHERE pattern_id = $1`,
      [hyp.id]
    );
    if (existing.rows.length > 0 && existing.rows[0].definition_hash !== hash) {
      // Pre-registration guard: a changed definition may NOT overwrite its own
      // history. Register the revision under a new id to keep lineage visible.
      console.warn(
        `[patterns] REFUSED to overwrite '${hyp.id}': definition changed since registration. ` +
          `Give the revision a new id (e.g. '${hyp.id}-r2').`
      );
      report.push({ id: hyp.id, status: "DEFINITION_CONFLICT" });
      continue;
    }

    const r = evaluate(ctx, hyp, recentCutoff);
    await pool.query(
      `INSERT INTO gold_history.pattern_stats
         (pattern_id, definition_hash, family, name, description, rationale, metal,
          expected_direction, primary_horizon, status, n_episodes, checks, results,
          variants, active_today, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'GOLD',$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (pattern_id) DO UPDATE SET
         status = EXCLUDED.status, n_episodes = EXCLUDED.n_episodes,
         checks = EXCLUDED.checks, results = EXCLUDED.results,
         variants = EXCLUDED.variants, active_today = EXCLUDED.active_today,
         computed_at = EXCLUDED.computed_at`,
      [
        hyp.id, hash, hyp.family, hyp.name, hyp.description, hyp.rationale,
        hyp.direction, hyp.primaryHorizon, r.status, r.nFull,
        JSON.stringify(r.checks), JSON.stringify(r.eras),
        JSON.stringify(r.variantResults), r.activeToday,
      ]
    );
    report.push({ id: hyp.id, status: r.status, episodes: r.nFull, activeToday: r.activeToday });
    console.log(`[patterns] ${hyp.id}: ${r.status} (${r.nFull} episodes)`);
  }
  return { asOf: lastDate, patterns: report };
}

export async function getPatternLibrary(pool: Pool) {
  const rows = await pool.query(`
    SELECT * FROM gold_history.pattern_stats
    ORDER BY CASE status WHEN 'SURVIVED' THEN 0 WHEN 'NO_EDGE' THEN 1 ELSE 2 END, family, pattern_id
  `);
  const tested = rows.rows.filter((r: any) => r.status !== "INSUFFICIENT").length;
  const survived = rows.rows.filter((r: any) => r.status === "SURVIVED").length;
  return {
    summary: {
      totalPatterns: rows.rows.length,
      tested,
      survived,
      insufficient: rows.rows.filter((r: any) => r.status === "INSUFFICIENT").length,
      // library-level honesty: how many survivors pure luck would produce
      expectedSurvivorsByChance: Math.round(tested * CHANCE_PASS_RATE * 10) / 10,
      activeToday: rows.rows.filter((r: any) => r.active_today).map((r: any) => r.pattern_id),
      computedAt: rows.rows[0]?.computed_at ?? null,
    },
    patterns: rows.rows,
  };
}

// ── Regime watcher ────────────────────────────────────────────────────────────
// Rolling 2-year correlation of weekly gold returns vs weekly real-yield
// changes. Textbook value is strongly NEGATIVE; when the current reading sits
// far from its own history (e.g. 2022+, when central-bank buying took over as
// the marginal driver), classic rate-based patterns deserve less weight — and
// that fact itself is worth narrating.
export async function getRegimeContext(pool: Pool) {
  const rows = await pool.query(`
    SELECT l.date, l.usd AS gold, f.value AS ry
    FROM gold_history.lbma_prices l
    JOIN gold_history.fred_series f ON f.date = l.date AND f.series_id = 'DFII10'
    WHERE l.metal = 'GOLD'
    ORDER BY l.date
  `);
  if (rows.rows.length < 600) return null;
  // weekly sampling (every 5th trading day)
  const gold: number[] = [];
  const ry: number[] = [];
  const dates: string[] = [];
  for (let i = 0; i < rows.rows.length; i += 5) {
    gold.push(Number(rows.rows[i].gold));
    ry.push(Number(rows.rows[i].ry));
    dates.push(rows.rows[i].date);
  }
  const goldRet = gold.slice(1).map((v, i) => v / gold[i] - 1);
  const ryChg = ry.slice(1).map((v, i) => v - ry[i]);
  const corr = (xs: number[], ys: number[]) => {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  };
  const WIN = 104; // 2 years of weeks
  const rolling: number[] = [];
  for (let i = WIN; i <= goldRet.length; i++) {
    rolling.push(corr(goldRet.slice(i - WIN, i), ryChg.slice(i - WIN, i)));
  }
  if (rolling.length < 10) return null;
  const current = rolling[rolling.length - 1];
  const sorted = [...rolling].sort((a, b) => a - b);
  const pctlOfCurrent =
    (100 * sorted.filter((v) => v <= current).length) / sorted.length;
  const historicalMedian = median(sorted);
  const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    description:
      "Rolling 2-year correlation between weekly gold returns and real-yield changes. Textbook is strongly negative; a reading far above its own history means the classic driver is not in charge right now.",
    currentCorrelation: r2(current),
    historicalMedian: r2(historicalMedian),
    percentileOfCurrent: r2(pctlOfCurrent),
    regimeBroken: current > -0.1 && pctlOfCurrent > 85,
    asOf: dates[dates.length - 1],
  };
}
