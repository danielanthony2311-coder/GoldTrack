// ─────────────────────────────────────────────────────────────────────────────
// Predictions & scoreboard  (roadmap: high-conviction alerts + graded track record)
//
// A "prediction" is a high-conviction ALERT, opened only when a pattern that has
// already SURVIVED the backtest (patterns.ts) goes active. It is deliberately NOT
// a daily directional guess — those are coin flips. Each alert inherits the
// pattern's direction, horizon, and its BACKTESTED hit-rate, states a falsifiable
// thesis + a tripwire (invalidation), and is graded against the LBMA gold fix when
// its horizon matures.
//
// The scoreboard reports two honest numbers side by side:
//   • BACKTEST  — the pattern's historical hit-rate (immediately meaningful, with
//                 sample size n and a Wilson 95% interval). This is the evidence base.
//   • LIVE      — the out-of-sample track record of alerts fired since this went
//                 live, graded as they mature. Starts small, accumulates, and is
//                 the real credibility test over time.
// ─────────────────────────────────────────────────────────────────────────────
import type pg from "pg";
type Pool = pg.Pool;

export async function ensurePredictionTables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_history.predictions (
      id BIGSERIAL PRIMARY KEY,
      pattern_id TEXT NOT NULL,
      pattern_name TEXT,
      metal TEXT NOT NULL DEFAULT 'GOLD',
      direction TEXT NOT NULL,               -- UP / DOWN
      created_date DATE NOT NULL,            -- the signal (fire) date
      entry_price NUMERIC,                   -- gold USD fix on the signal date
      horizon_days INT NOT NULL,             -- trading days to maturity
      expected_hit_rate NUMERIC,             -- backtested, snapshotted at creation
      expected_median_pct NUMERIC,           -- backtested median move over the horizon
      tripwire_pct NUMERIC,                  -- adverse move (abs %) that invalidates early
      thesis TEXT,
      tripwire TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN / HIT / MISS / INVALIDATED
      graded_date DATE,
      exit_price NUMERIC,
      actual_return_pct NUMERIC,             -- signed return over the horizon
      outcome_detail TEXT,
      source TEXT NOT NULL DEFAULT 'live',   -- 'live' = out-of-sample forward alert; 'backtest' = materialized history
      UNIQUE (pattern_id, created_date, metal)
    );
    CREATE INDEX IF NOT EXISTS idx_predictions_status ON gold_history.predictions(metal, status);
    CREATE INDEX IF NOT EXISTS idx_predictions_created ON gold_history.predictions(created_date DESC);
  `);
  // Column added after first release — backfill for tables created earlier.
  await pool.query(`ALTER TABLE gold_history.predictions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'live'`);
}

// Materialize every historical firing of each survived pattern as a graded call
// (source='backtest'), so the ledger is auditable from day one. Idempotent:
// re-running only inserts firings not already recorded, and never touches 'live'
// rows. `ledger` comes from patterns.survivedEpisodeLedger(pool).
export async function backfillFromBacktest(pool: Pool, ledger: any[]) {
  await ensurePredictionTables(pool);
  let inserted = 0;
  for (const e of ledger) {
    const dir: string = e.direction;
    const thesis = `${e.name} fired (${e.createdDate}).`;
    const detail = `Gold ${e.returnPct >= 0 ? "+" : ""}${e.returnPct}% over ${e.horizonDays} trading days; call was ${dir}.`;
    const ins = await pool.query(
      `INSERT INTO gold_history.predictions
        (pattern_id, pattern_name, metal, direction, created_date, entry_price, horizon_days,
         status, graded_date, exit_price, actual_return_pct, outcome_detail, thesis, source)
       VALUES ($1,$2,'GOLD',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'backtest')
       ON CONFLICT (pattern_id, created_date, metal) DO NOTHING
       RETURNING id`,
      [
        e.patternId, e.name, dir, e.createdDate, e.entryPrice, e.horizonDays,
        e.hit ? "HIT" : "MISS", e.exitDate, e.exitPrice, e.returnPct, detail, thesis,
      ]
    );
    if (ins.rows.length) inserted++;
  }
  return { inserted, total: ledger.length };
}

// The same gold price series the pattern engine measures against: the LBMA PM fix.
async function goldSeries(pool: Pool): Promise<{ date: string; usd: number }[]> {
  // lbma_prices.date is stored as ISO text ('YYYY-MM-DD'); ISO text sorts
  // chronologically, so no cast needed (and to_char would reject a text arg).
  const r = await pool.query(
    `SELECT date, usd
       FROM gold_history.lbma_prices
      WHERE metal = 'GOLD' AND usd IS NOT NULL
      ORDER BY date ASC`
  );
  return r.rows.map((x: any) => ({ date: iso(x.date), usd: Number(x.usd) }));
}

const iso = (d: any) => (typeof d === "string" ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
const round2 = (x: number) => Math.round(x * 100) / 100;

// ── Open new alerts for any SURVIVED pattern that is active today ──────────────
export async function runPredictions(pool: Pool, metal = "GOLD") {
  await ensurePredictionTables(pool);
  const series = await goldSeries(pool);
  if (series.length < 2) return { created: 0, note: "no gold price series" };
  const last = series[series.length - 1];
  const signalDate = last.date;

  const pats = await pool.query(
    `SELECT pattern_id, name, expected_direction, primary_horizon, results
       FROM gold_history.pattern_stats
      WHERE status = 'SURVIVED' AND active_today = TRUE AND metal = $1`,
    [metal]
  );

  let created = 0;
  const opened: string[] = [];
  for (const p of pats.rows) {
    const ph: number = p.primary_horizon;
    const stat = p.results?.full?.[ph] ?? p.results?.full?.[String(ph)] ?? null;
    if (!stat) continue;
    const dir: string = p.expected_direction;
    const hitRate = stat.hitRate ?? null;
    const medianPct = stat.median ?? null;
    const medianMae = stat.medianMae ?? null; // typical adverse drawdown (negative %)
    // Tripwire = 1.5x the pattern's normal adverse wobble, min 2%.
    const tripwirePct = medianMae != null ? Math.max(2, round2(Math.abs(medianMae) * 1.5)) : null;

    const thesis =
      `${p.name} fired. In backtesting, gold moved ${dir === "UP" ? "up" : "down"}` +
      (hitRate != null ? ` ${hitRate}% of the time` : "") +
      ` over the next ${ph} trading days` +
      (medianPct != null ? ` (median ${medianPct > 0 ? "+" : ""}${medianPct}%, n=${stat.n}).` : `.`);
    const tripwire =
      tripwirePct != null
        ? `Invalidated early if gold moves ${tripwirePct}% against the call (${dir === "UP" ? "down" : "up"}) before the horizon.`
        : "No tripwire set.";

    const ins = await pool.query(
      `INSERT INTO gold_history.predictions
        (pattern_id, pattern_name, metal, direction, created_date, entry_price,
         horizon_days, expected_hit_rate, expected_median_pct, tripwire_pct, thesis, tripwire)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (pattern_id, created_date, metal) DO NOTHING
       RETURNING id`,
      [p.pattern_id, p.name, metal, dir, signalDate, last.usd, ph, hitRate, medianPct, tripwirePct, thesis, tripwire]
    );
    if (ins.rows.length) {
      created++;
      opened.push(p.pattern_id);
    }
  }
  return { created, signalDate, opened };
}

// ── Grade matured / invalidated open alerts against actual gold moves ──────────
export async function gradePredictions(pool: Pool, metal = "GOLD") {
  await ensurePredictionTables(pool);
  const series = await goldSeries(pool);
  const idxByDate = new Map(series.map((s, i) => [s.date, i]));
  const open = await pool.query(
    `SELECT * FROM gold_history.predictions WHERE metal = $1 AND status = 'OPEN'`,
    [metal]
  );

  let graded = 0;
  for (const p of open.rows) {
    const entryDate = iso(p.created_date);
    const eIdx = idxByDate.get(entryDate);
    if (eIdx == null) continue;
    const entry = Number(p.entry_price);
    const exitIdx = eIdx + Number(p.horizon_days);
    const nowIdx = series.length - 1;
    const reach = Math.min(exitIdx, nowIdx);

    // Worst adverse move so far (for the tripwire).
    let adverse = 0; // positive number = how far against the call, in %
    for (let j = eIdx + 1; j <= reach; j++) {
      const ret = (series[j].usd / entry - 1) * 100;
      const against = p.direction === "UP" ? -ret : ret; // adverse if positive
      adverse = Math.max(adverse, against);
    }

    const tw = p.tripwire_pct != null ? Number(p.tripwire_pct) : null;
    if (tw != null && adverse >= tw) {
      // Tripwire hit before maturity → invalidated (counts as a miss).
      const jHit = (() => {
        for (let j = eIdx + 1; j <= reach; j++) {
          const ret = (series[j].usd / entry - 1) * 100;
          const against = p.direction === "UP" ? -ret : ret;
          if (against >= tw) return j;
        }
        return reach;
      })();
      await pool.query(
        `UPDATE gold_history.predictions
            SET status='INVALIDATED', graded_date=$2, exit_price=$3, actual_return_pct=$4,
                outcome_detail=$5
          WHERE id=$1`,
        [
          p.id,
          series[jHit].date,
          series[jHit].usd,
          round2((series[jHit].usd / entry - 1) * 100),
          `Tripwire hit: moved ${round2(adverse)}% against the call before the horizon.`,
        ]
      );
      graded++;
      continue;
    }

    if (exitIdx > nowIdx) continue; // not matured yet, tripwire not hit

    const exit = series[exitIdx].usd;
    const ret = (exit / entry - 1) * 100;
    const hit = p.direction === "UP" ? ret > 0 : ret < 0;
    await pool.query(
      `UPDATE gold_history.predictions
          SET status=$2, graded_date=$3, exit_price=$4, actual_return_pct=$5, outcome_detail=$6
        WHERE id=$1`,
      [
        p.id,
        hit ? "HIT" : "MISS",
        series[exitIdx].date,
        exit,
        round2(ret),
        `Gold ${ret >= 0 ? "+" : ""}${round2(ret)}% over ${p.horizon_days} trading days; call was ${p.direction}.`,
      ]
    );
    graded++;
  }
  return { graded };
}

function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 100];
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [round2((100 * (c - m)) / d), round2((100 * (c + m)) / d)];
}

// ── Scoreboard: backtest odds per pattern + the live out-of-sample track record ─
export async function getScoreboard(pool: Pool, metal = "GOLD") {
  await ensurePredictionTables(pool);
  // Backtest odds from the pattern engine (survived patterns only).
  const pats = await pool.query(
    `SELECT pattern_id, name, family, expected_direction, primary_horizon, results, n_episodes
       FROM gold_history.pattern_stats
      WHERE status='SURVIVED' AND metal=$1
      ORDER BY family, pattern_id`,
    [metal]
  );
  // Live (out-of-sample, forward) results per pattern — source='live' only.
  const live = await pool.query(
    `SELECT pattern_id,
            COUNT(*) FILTER (WHERE status IN ('HIT','MISS','INVALIDATED')) AS graded,
            COUNT(*) FILTER (WHERE status='HIT') AS hits,
            COUNT(*) FILTER (WHERE status='OPEN') AS open
       FROM gold_history.predictions WHERE metal=$1 AND source='live' GROUP BY pattern_id`,
    [metal]
  );
  const liveBy = new Map(live.rows.map((r: any) => [r.pattern_id, r]));

  const patterns = pats.rows.map((p: any) => {
    const ph = p.primary_horizon;
    const stat = p.results?.full?.[ph] ?? p.results?.full?.[String(ph)] ?? {};
    const l = liveBy.get(p.pattern_id) || { graded: 0, hits: 0, open: 0 };
    const lg = Number(l.graded), lh = Number(l.hits);
    return {
      patternId: p.pattern_id,
      name: p.name,
      family: p.family,
      direction: p.expected_direction,
      horizonDays: ph,
      backtest: {
        hitRate: stat.hitRate ?? null,
        n: stat.n ?? p.n_episodes ?? null,
        wilsonLo: stat.wilsonLo ?? null,
        wilsonHi: stat.wilsonHi ?? null,
        medianPct: stat.median ?? null,
      },
      live: {
        graded: lg,
        hits: lh,
        open: Number(l.open),
        hitRate: lg > 0 ? round2((100 * lh) / lg) : null,
      },
    };
  });

  // Overall LIVE aggregate (out-of-sample only).
  const agg = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('HIT','MISS','INVALIDATED')) AS graded,
            COUNT(*) FILTER (WHERE status='HIT') AS hits,
            COUNT(*) FILTER (WHERE status='OPEN') AS open,
            to_char(MIN(created_date),'YYYY-MM-DD') AS since
       FROM gold_history.predictions WHERE metal=$1 AND source='live'`,
    [metal]
  );
  const a = agg.rows[0];
  const ag = Number(a.graded), ah = Number(a.hits);
  const overallLive = {
    graded: ag,
    hits: ah,
    open: Number(a.open),
    hitRate: ag > 0 ? round2((100 * ah) / ag) : null,
    wilson: ag > 0 ? wilson(ah, ag) : null,
    since: a.since,
  };

  // Full auditable ledger headline (every graded firing, historical + live).
  const led = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('HIT','MISS','INVALIDATED')) AS graded,
            COUNT(*) FILTER (WHERE status='HIT') AS hits
       FROM gold_history.predictions WHERE metal=$1`,
    [metal]
  );
  const lg = Number(led.rows[0].graded), lh = Number(led.rows[0].hits);
  const ledger = {
    graded: lg,
    hits: lh,
    hitRate: lg > 0 ? round2((100 * lh) / lg) : null,
    wilson: lg > 0 ? wilson(lh, lg) : null,
  };

  return {
    metal,
    patterns,
    overallLive,
    ledger,
    note: "Backtest = historical hit-rate per pattern. Ledger = every firing graded (auditable). Live = out-of-sample calls since go-live.",
  };
}

// ── Currently open alerts (with days remaining) ───────────────────────────────
export async function getActivePredictions(pool: Pool, metal = "GOLD") {
  await ensurePredictionTables(pool);
  const series = await goldSeries(pool);
  const idxByDate = new Map(series.map((s, i) => [s.date, i]));
  const nowIdx = series.length - 1;
  const spot = series[nowIdx]?.usd ?? null;

  const open = await pool.query(
    `SELECT * FROM gold_history.predictions WHERE metal=$1 AND status='OPEN' ORDER BY created_date DESC`,
    [metal]
  );
  const active = open.rows.map((p: any) => {
    const eIdx = idxByDate.get(iso(p.created_date));
    const elapsed = eIdx != null ? nowIdx - eIdx : null;
    const remaining = elapsed != null ? Math.max(0, Number(p.horizon_days) - elapsed) : null;
    const sinceEntry = spot != null ? round2((spot / Number(p.entry_price) - 1) * 100) : null;
    return {
      patternId: p.pattern_id,
      name: p.pattern_name,
      direction: p.direction,
      createdDate: iso(p.created_date),
      entryPrice: Number(p.entry_price),
      horizonDays: Number(p.horizon_days),
      tradingDaysRemaining: remaining,
      expectedHitRate: p.expected_hit_rate != null ? Number(p.expected_hit_rate) : null,
      moveSinceEntryPct: sinceEntry,
      thesis: p.thesis,
      tripwire: p.tripwire,
    };
  });

  // Recently graded (last 10) for a live feed.
  const recent = await pool.query(
    `SELECT pattern_name, direction, status, source, created_date, graded_date, actual_return_pct, outcome_detail
       FROM gold_history.predictions
      WHERE metal=$1 AND status IN ('HIT','MISS','INVALIDATED')
      ORDER BY graded_date DESC NULLS LAST LIMIT 12`,
    [metal]
  );
  return {
    metal,
    spot,
    active,
    recent: recent.rows.map((r: any) => ({
      name: r.pattern_name,
      direction: r.direction,
      status: r.status,
      source: r.source,
      created: iso(r.created_date),
      graded: r.graded_date ? iso(r.graded_date) : null,
      returnPct: r.actual_return_pct != null ? Number(r.actual_return_pct) : null,
      detail: r.outcome_detail,
    })),
  };
}
