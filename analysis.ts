// analysis.ts — GoldTrack interpretation engine.
//
// Two layers:
//   1. computeSignals()   — deterministic math over the real DB rows. Every
//      number the AI is allowed to talk about is computed here first.
//   2. generateNarrative() — sends those signals (plus yesterday's theory) to
//      Claude with live web search, and stores a plain-English explanation +
//      an evolving "current theory" in market_narratives.
//
// The AI never sees the database directly and is instructed to use ONLY the
// numbers in the signals payload — it cannot invent inventory figures.

import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { getRegimeContext } from "./patterns.ts";

type Pool = pg.Pool;

const OZ_PER_CONTRACT: Record<string, number> = { GOLD: 100, SILVER: 5000 };

export interface NarrativeSource {
  title: string;
  url: string;
}

export interface NarrativeRow {
  date: string;
  metal: string;
  headline: string;
  narrative: string;
  theory: string;
  what_changed: string | null;
  confidence: string | null;
  watch_next: string | null;
  sources: NarrativeSource[];
  signals: any;
  model: string | null;
  created_at: string;
}

export async function ensureAnalysisTables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_narratives (
      id BIGSERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      metal TEXT NOT NULL,
      headline TEXT NOT NULL,
      narrative TEXT NOT NULL,
      theory TEXT NOT NULL,
      what_changed TEXT,
      confidence TEXT,
      watch_next TEXT,
      sources JSONB DEFAULT '[]',
      signals JSONB,
      model TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(date, metal)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_narratives_metal_date ON market_narratives(metal, date DESC)`
  );
}

// ── Signal computation (pure DB math, no AI) ──────────────────────────────────

export async function computeSignals(pool: Pool, metal: string) {
  const m = metal.toUpperCase();

  const stocksRes = await pool.query(
    `SELECT date, registered_oz, eligible_oz, total_oz,
            daily_change_registered, daily_change_eligible
     FROM warehouse_stocks WHERE metal = $1 ORDER BY date DESC LIMIT 30`,
    [m]
  );
  if (stocksRes.rows.length === 0) return null;

  const rows = stocksRes.rows.map((r) => ({
    date: r.date as string,
    registeredOz: Number(r.registered_oz),
    eligibleOz: Number(r.eligible_oz),
    totalOz: Number(r.total_oz),
    changeRegistered: r.daily_change_registered != null ? Number(r.daily_change_registered) : null,
    changeEligible: r.daily_change_eligible != null ? Number(r.daily_change_eligible) : null,
  }));
  const latest = rows[0];
  const asOfDate = latest.date;

  // Consecutive-day streak on registered stocks (sign of daily change)
  let streakDays = 0;
  let streakDir: "FALLING" | "RISING" | "FLAT" = "FLAT";
  for (const r of rows) {
    const c = r.changeRegistered;
    if (c == null || c === 0) break;
    const dir = c < 0 ? "FALLING" : "RISING";
    if (streakDays === 0) streakDir = dir;
    if (dir !== streakDir) break;
    streakDays++;
  }

  const back5 = rows[Math.min(5, rows.length - 1)];
  const change1dOz = latest.changeRegistered;
  const change5dOz = rows.length > 1 ? latest.registeredOz - back5.registeredOz : null;

  // Coverage: registered oz vs open-interest oz (how many "coupons" per "pizza")
  let coverage: any = null;
  const oiRes = await pool.query(
    `SELECT date, oi_contracts, oi_oz FROM open_interest
     WHERE metal = $1 ORDER BY date DESC LIMIT 1`,
    [m]
  );
  if (oiRes.rows[0]) {
    const oi = oiRes.rows[0];
    const oiOz = oi.oi_oz != null ? Number(oi.oi_oz) : Number(oi.oi_contracts) * OZ_PER_CONTRACT[m];
    if (oiOz > 0) {
      coverage = {
        date: oi.date,
        oiContracts: Number(oi.oi_contracts),
        oiOz,
        registeredCoveragePct: Math.round((latest.registeredOz / oiOz) * 1000) / 10,
      };
    }
  }

  // Vault movers: latest date vs the report before it
  let vaults: any = null;
  const vaultDatesRes = await pool.query(
    `SELECT DISTINCT date FROM vault_stocks WHERE metal = $1 ORDER BY date DESC LIMIT 2`,
    [m]
  );
  if (vaultDatesRes.rows.length === 2) {
    const [d0, d1] = vaultDatesRes.rows.map((r) => r.date);
    const vres = await pool.query(
      `SELECT a.vault,
              a.registered_oz::bigint - COALESCE(b.registered_oz, 0)::bigint AS reg_change,
              a.registered_oz::bigint AS reg_now
       FROM vault_stocks a
       LEFT JOIN vault_stocks b ON b.vault = a.vault AND b.metal = a.metal AND b.date = $3
       WHERE a.metal = $1 AND a.date = $2
       ORDER BY ABS(a.registered_oz::bigint - COALESCE(b.registered_oz, 0)::bigint) DESC
       LIMIT 5`,
      [m, d0, d1]
    );
    vaults = {
      date: d0,
      movers: vres.rows
        .map((r) => ({
          vault: r.vault,
          registeredChangeOz: Number(r.reg_change),
          registeredOz: Number(r.reg_now),
        }))
        .filter((v) => v.registeredChangeOz !== 0),
    };
  }

  // Delivery notices over the last 15 report dates: top stoppers/issuers and
  // house-account stop streaks (a bank's own book taking metal repeatedly).
  let deliveries: any = null;
  const dateRes = await pool.query(
    `SELECT DISTINCT date FROM delivery_notices WHERE metal = $1 ORDER BY date DESC LIMIT 15`,
    [m]
  );
  const noticeDates: string[] = dateRes.rows.map((r) => r.date);
  if (noticeDates.length > 0) {
    const nres = await pool.query(
      `SELECT date, firm, account_type, issued, stopped
       FROM delivery_notices WHERE metal = $1 AND date = ANY($2)`,
      [m, noticeDates]
    );

    const agg = new Map<string, { firm: string; accountType: string; issued: number; stopped: number }>();
    const houseStopsByFirm = new Map<string, Map<string, number>>();
    for (const r of nres.rows) {
      const key = `${r.firm}|${r.account_type}`;
      const a = agg.get(key) ?? { firm: r.firm, accountType: r.account_type, issued: 0, stopped: 0 };
      a.issued += Number(r.issued) || 0;
      a.stopped += Number(r.stopped) || 0;
      agg.set(key, a);
      if (r.account_type === "HOUSE" && Number(r.stopped) > 0) {
        const byDate = houseStopsByFirm.get(r.firm) ?? new Map<string, number>();
        byDate.set(r.date, (byDate.get(r.date) ?? 0) + Number(r.stopped));
        houseStopsByFirm.set(r.firm, byDate);
      }
    }

    // Streak = consecutive report dates (newest first) where the firm's house
    // account stopped contracts. Only streaks of 3+ are worth flagging.
    const houseStopStreaks: { firm: string; days: number; totalContracts: number }[] = [];
    for (const [firm, byDate] of houseStopsByFirm) {
      let days = 0;
      let total = 0;
      for (const d of noticeDates) {
        const c = byDate.get(d);
        if (!c) break;
        days++;
        total += c;
      }
      if (days >= 3) houseStopStreaks.push({ firm, days, totalContracts: total });
    }
    houseStopStreaks.sort((a, b) => b.days - a.days || b.totalContracts - a.totalContracts);

    const all = [...agg.values()];
    deliveries = {
      windowDays: noticeDates.length,
      latestDate: noticeDates[0],
      oldestDate: noticeDates[noticeDates.length - 1],
      topStoppers: all
        .filter((a) => a.stopped > 0)
        .sort((a, b) => b.stopped - a.stopped)
        .slice(0, 5)
        .map((a) => ({ firm: a.firm, accountType: a.accountType, contractsStopped: a.stopped })),
      topIssuers: all
        .filter((a) => a.issued > 0)
        .sort((a, b) => b.issued - a.issued)
        .slice(0, 5)
        .map((a) => ({ firm: a.firm, accountType: a.accountType, contractsIssued: a.issued })),
      houseStopStreaks: houseStopStreaks.slice(0, 5),
    };
  }

  // Recent settlement closes (same source as /api/prices/latest)
  const priceRes = await pool.query(
    `SELECT DISTINCT ON (date) date, settlement
     FROM metals_summary
     WHERE metal = $1 AND settlement IS NOT NULL
     ORDER BY date DESC,
       CASE report_type WHEN 'DAILY' THEN 0 WHEN 'MTD' THEN 1 ELSE 2 END
     LIMIT 7`,
    [m]
  );
  const closes = [...priceRes.rows].reverse();
  const price = closes.map((r, i) => {
    const prev = i > 0 ? Number(closes[i - 1].settlement) : null;
    const close = Number(r.settlement);
    return {
      date: r.date,
      settlement: close,
      change1dPct: prev ? Math.round(((close - prev) / prev) * 10000) / 100 : null,
    };
  });

  return {
    metal: m,
    asOfDate,
    stocks: {
      registeredOz: latest.registeredOz,
      eligibleOz: latest.eligibleOz,
      totalOz: latest.totalOz,
      change1dOz,
      change1dPct:
        change1dOz != null && latest.registeredOz - change1dOz !== 0
          ? Math.round((change1dOz / (latest.registeredOz - change1dOz)) * 10000) / 100
          : null,
      change5dOz,
      change5dPct:
        change5dOz != null && back5.registeredOz !== 0
          ? Math.round((change5dOz / back5.registeredOz) * 10000) / 100
          : null,
      registeredStreak: { direction: streakDir, days: streakDays },
      eligibleChange1dOz: latest.changeEligible,
      daysOfHistory: rows.length,
    },
    coverage,
    vaults,
    deliveries,
    price,
  };
}

// ── Narrative generation (Claude + web search) ────────────────────────────────

const SYSTEM_PROMPT = `You are the built-in market analyst of GoldTrack, a COMEX gold & silver warehouse-stocks dashboard. Your job: explain what the user is looking at, in plain English, and maintain a running theory of what is happening in the physical gold/silver market.

HARD RULES:
1. Every inventory, delivery, coverage or price figure you state MUST come verbatim from the SIGNALS JSON you are given. Never estimate, extrapolate, or invent a number. If a figure is missing, say the data isn't available.
2. Use the web_search tool (2 to 4 searches) to find news from roughly the past week that could explain the data: gold/silver market moves, COMEX or LBMA inventory stories, central bank buying, ETF flows, tariffs, rates, geopolitics. Only cite stories you actually found in search results, with their real titles and URLs.
3. Be honest and balanced. Falling registered stocks have triggered false "COMEX default" alarms for a decade. Give the boring explanation fair weight, state what would DISPROVE the current theory, and never hype.
4. Write for an intelligent non-expert. Short sentences. First time you use a term, explain it in a few words in parentheses — e.g. "registered stocks (metal sitting in the vault, ready to be handed to buyers)".
5. If YESTERDAY'S THEORY is provided, treat it as your own prior view: keep what still holds, revise what the new data or news contradicts, and describe the delta in whatChanged. If nothing material changed, say so plainly.
6. NEVER give trading advice. No imperative verbs about positions — no "buy", "sell", "add", "take profits", "get in/out". Frame everything as scenarios: "if X happens, history suggests Y; if Z happens instead, the theory is wrong." Every theory MUST include its invalidation — the specific observable thing that would prove it wrong.
7. Do not invent probabilities or percentages. If a HISTORICAL PATTERNS or REGIME section is provided below, you may cite those backtested numbers exactly as given (always alongside their episode counts); those are the ONLY odds you may state. Describe them as "in N similar past episodes" — never as a prediction.
8. If the REGIME section says the classic driver correlation is broken, say so and weight rate/dollar-based reasoning accordingly — an honest "the usual playbook isn't working right now" beats a confident story.

After your research, respond with ONLY a single JSON object (no markdown fences, no commentary) with exactly these fields:
{
  "headline": "one punchy sentence summarising today's picture",
  "whatYoureLookingAt": "2-4 short paragraphs explaining today's numbers and what they mean, for a non-expert",
  "currentTheory": "your single running theory of what is happening in this market right now and why, 1-2 paragraphs, including what would disprove it",
  "whatChanged": "what changed vs yesterday's theory, or 'No material change.' if nothing did",
  "confidence": "LOW" | "MEDIUM" | "HIGH",
  "watchNext": "the 1-3 specific things in the data to watch over the coming days",
  "sources": [{ "title": "...", "url": "..." }]
}`;

function extractJson(text: string): any {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response contained no JSON object");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

const inFlight = new Map<string, Promise<NarrativeRow>>();

export async function generateNarrative(
  pool: Pool,
  metal: string,
  opts: { force?: boolean } = {}
): Promise<NarrativeRow> {
  const m = metal.toUpperCase();
  const existing = inFlight.get(m);
  if (existing) return existing;

  const run = (async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env.local (get a key at console.anthropic.com) and restart the server."
      );
    }

    const signals = await computeSignals(pool, m);
    if (!signals) {
      throw new Error(`No warehouse data for ${m} yet — run a CME sync first.`);
    }

    // Idempotent per data-date: don't re-bill Claude for a date we've done,
    // unless force is set.
    if (!opts.force) {
      const done = await pool.query(
        `SELECT * FROM market_narratives WHERE metal = $1 AND date = $2 LIMIT 1`,
        [m, signals.asOfDate]
      );
      if (done.rows[0]) return rowToNarrative(done.rows[0]);
    }

    const prevRes = await pool.query(
      `SELECT date, theory FROM market_narratives
       WHERE metal = $1 AND date < $2 ORDER BY date DESC LIMIT 1`,
      [m, signals.asOfDate]
    );
    const prev = prevRes.rows[0] ?? null;

    // Regime watcher (gold vs real yields) — computed from the history DB.
    // Optional: if the history backfill hasn't run yet, we just omit it.
    let regime: Awaited<ReturnType<typeof getRegimeContext>> = null;
    if (m === "GOLD") {
      try {
        regime = await getRegimeContext(pool);
      } catch {
        regime = null;
      }
    }

    const userContent =
      `SIGNALS (all figures are real, computed from CME COMEX reports; ounces are troy oz):\n` +
      JSON.stringify(signals, null, 1) +
      (regime
        ? `\n\nREGIME (computed from the long-run history DB — see hard rule 8):\n${JSON.stringify(regime, null, 1)}`
        : "") +
      (prev ? `\n\nYESTERDAY'S THEORY (from ${prev.date}):\n${prev.theory}` : "\n\nYESTERDAY'S THEORY: none yet — this is the first analysis.") +
      `\n\nWrite today's analysis for ${m}.`;

    const MODEL = "claude-opus-4-8";
    const client = new Anthropic();
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
      messages: [{ role: "user", content: userContent }],
    });
    const message = await stream.finalMessage();

    let text = "";
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
    }
    const parsed = extractJson(text);

    const sources: NarrativeSource[] = Array.isArray(parsed.sources)
      ? parsed.sources
          .filter((s: any) => s && typeof s.url === "string" && typeof s.title === "string")
          .slice(0, 8)
      : [];

    const insert = await pool.query(
      `INSERT INTO market_narratives
         (date, metal, headline, narrative, theory, what_changed, confidence, watch_next, sources, signals, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (date, metal) DO UPDATE SET
         headline = EXCLUDED.headline,
         narrative = EXCLUDED.narrative,
         theory = EXCLUDED.theory,
         what_changed = EXCLUDED.what_changed,
         confidence = EXCLUDED.confidence,
         watch_next = EXCLUDED.watch_next,
         sources = EXCLUDED.sources,
         signals = EXCLUDED.signals,
         model = EXCLUDED.model,
         created_at = NOW()
       RETURNING *`,
      [
        signals.asOfDate,
        m,
        String(parsed.headline ?? "Analysis"),
        String(parsed.whatYoureLookingAt ?? ""),
        String(parsed.currentTheory ?? ""),
        parsed.whatChanged != null ? String(parsed.whatChanged) : null,
        parsed.confidence != null ? String(parsed.confidence) : null,
        parsed.watchNext != null ? String(parsed.watchNext) : null,
        JSON.stringify(sources),
        JSON.stringify(signals),
        MODEL,
      ]
    );
    console.log(`[analysis] ${m} narrative stored for ${signals.asOfDate} (${message.usage.output_tokens} output tokens)`);
    return rowToNarrative(insert.rows[0]);
  })();

  inFlight.set(m, run);
  try {
    return await run;
  } finally {
    inFlight.delete(m);
  }
}

export async function getLatestNarrative(pool: Pool, metal: string): Promise<NarrativeRow | null> {
  const res = await pool.query(
    `SELECT * FROM market_narratives WHERE metal = $1 ORDER BY date DESC LIMIT 1`,
    [metal.toUpperCase()]
  );
  return res.rows[0] ? rowToNarrative(res.rows[0]) : null;
}

function rowToNarrative(row: any): NarrativeRow {
  return {
    date: row.date,
    metal: row.metal,
    headline: row.headline,
    narrative: row.narrative,
    theory: row.theory,
    what_changed: row.what_changed,
    confidence: row.confidence,
    watch_next: row.watch_next,
    sources: Array.isArray(row.sources) ? row.sources : [],
    signals: row.signals,
    model: row.model,
    created_at: row.created_at,
  };
}
