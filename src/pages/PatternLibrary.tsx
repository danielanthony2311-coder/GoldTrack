import { useEffect, useState } from "react";
import {
  FlaskConical,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  Skull,
  HelpCircle,
  Radio,
} from "lucide-react";
import { cn } from "../utils/cn";

// One horizon's backtest stats, as stored by the pattern engine.
interface HorizonStats {
  n: number;
  hits: number;
  hitRate: number | null;
  wilsonLo: number | null;
  wilsonHi: number | null;
  median: number | null;
  mean: number | null;
  best: number | null;
  worst: number | null;
  medianMae: number | null;
}

interface PatternRow {
  pattern_id: string;
  family: string;
  name: string;
  description: string;
  rationale: string;
  expected_direction: "UP" | "DOWN";
  primary_horizon: number;
  status: "SURVIVED" | "NO_EDGE" | "INSUFFICIENT";
  n_episodes: number;
  checks: { direction: boolean; holdout: boolean; adjacent: boolean; robust: boolean };
  results: Record<"full" | "firstHalf" | "secondHalf" | "recent", Record<string, HorizonStats | null>>;
  variants: { params: Record<string, number>; n: number; median: number | null }[];
  active_today: boolean;
  computed_at: string;
}

interface Library {
  summary: {
    totalPatterns: number;
    tested: number;
    survived: number;
    insufficient: number;
    expectedSurvivorsByChance: number;
    activeToday: string[];
    computedAt: string | null;
  };
  patterns: PatternRow[];
}

const HORIZON_LABEL: Record<string, string> = { "21": "1 month", "63": "3 months", "126": "6 months" };

function fmtPct(v: number | null | undefined, signed = false) {
  if (v === null || v === undefined) return "—";
  const s = signed && v > 0 ? "+" : "";
  return `${s}${v.toFixed(1)}%`;
}

function StatusBadge({ status }: { status: PatternRow["status"] }) {
  if (status === "SURVIVED")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
        <ShieldCheck className="h-3.5 w-3.5" /> Survived every test
      </span>
    );
  if (status === "NO_EDGE")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400">
        <Skull className="h-3.5 w-3.5" /> No real edge found
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-500/10 px-2.5 py-1 text-xs font-medium text-slate-400">
      <HelpCircle className="h-3.5 w-3.5" /> Too few examples to judge
    </span>
  );
}

function CheckChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[11px] font-medium",
        ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
      )}
    >
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}

// `key` appears in the props type because this project has no @types/react —
// TS checks JSX attributes structurally, so React's special key prop must be
// declared here (React itself never passes it through).
function PatternCard({ p }: { p: PatternRow; key?: string }) {
  const [open, setOpen] = useState(false);
  const primary = p.results?.full?.[String(p.primary_horizon)];
  const halves = [p.results?.firstHalf?.[String(p.primary_horizon)], p.results?.secondHalf?.[String(p.primary_horizon)]];
  const recent = p.results?.recent?.[String(p.primary_horizon)];
  const dead = p.status === "NO_EDGE";

  return (
    <div className={cn("glass-card p-5", dead && "opacity-75")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "mt-0.5 rounded-lg p-2",
              p.expected_direction === "UP" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
            )}
          >
            {p.expected_direction === "UP" ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-white">{p.name}</h3>
              {p.active_today && (
                <span className="inline-flex items-center gap-1 rounded-full bg-gold-500/15 px-2 py-0.5 text-[11px] font-semibold text-gold-500">
                  <Radio className="h-3 w-3" /> ACTIVE TODAY
                </span>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">{p.description}</p>
          </div>
        </div>
        <StatusBadge status={p.status} />
      </div>

      {p.status !== "INSUFFICIENT" && primary && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <div className="text-xs text-slate-500">Past examples</div>
            <div className="font-mono text-lg text-white">{primary.n}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Went the expected way</div>
            <div className="font-mono text-lg text-white">
              {primary.hits} of {primary.n}
              <span className="ml-1 text-xs text-slate-500">
                ({fmtPct(primary.wilsonLo)}–{fmtPct(primary.wilsonHi)} plausible range)
              </span>
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Typical move ({HORIZON_LABEL[String(p.primary_horizon)]})</div>
            <div
              className={cn(
                "font-mono text-lg",
                (primary.median ?? 0) > 0 ? "text-emerald-400" : "text-red-400"
              )}
            >
              {fmtPct(primary.median, true)}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Typical worst dip on the way</div>
            <div className="font-mono text-lg text-red-400">{fmtPct(primary.medianMae, true)}</div>
          </div>
        </div>
      )}

      {p.status === "INSUFFICIENT" && (
        <p className="mt-3 text-sm text-slate-500">
          Only {p.n_episodes} usable examples in the whole historical record — below the minimum of 15, so no
          statistics are shown. A pattern this rare cannot be distinguished from luck.
        </p>
      )}

      <button
        onClick={() => setOpen(!open)}
        className="mt-4 text-xs font-medium text-gold-500 hover:text-gold-400"
      >
        {open ? "Hide the full test report ▲" : "Show the full test report ▼"}
      </button>

      {open && (
        <div className="mt-3 space-y-4 border-t border-white/5 pt-4 text-sm">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Why it could work</div>
            <p className="text-slate-400">{p.rationale}</p>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">The four tests</div>
            <div className="flex flex-wrap gap-2">
              <CheckChip ok={p.checks?.direction} label="Works overall" />
              <CheckChip ok={p.checks?.holdout} label="Works in both halves of history" />
              <CheckChip ok={p.checks?.adjacent} label="Works on neighbouring timeframes" />
              <CheckChip ok={p.checks?.robust} label="Survives tweaking the trigger" />
            </div>
          </div>

          {p.status !== "INSUFFICIENT" && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="py-1.5 pr-4 font-medium">Period</th>
                    <th className="py-1.5 pr-4 font-medium">Examples</th>
                    <th className="py-1.5 pr-4 font-medium">Hit rate</th>
                    <th className="py-1.5 pr-4 font-medium">Typical move</th>
                    <th className="py-1.5 pr-4 font-medium">Best</th>
                    <th className="py-1.5 font-medium">Worst</th>
                  </tr>
                </thead>
                <tbody className="text-slate-300">
                  {(
                    [
                      ["Full history", p.results?.full],
                      ["First half", p.results?.firstHalf],
                      ["Second half", p.results?.secondHalf],
                      ["Last 5 years", p.results?.recent],
                    ] as const
                  ).map(([label, era]) => {
                    const s = era?.[String(p.primary_horizon)];
                    return (
                      <tr key={label} className="border-t border-white/5">
                        <td className="py-1.5 pr-4">{label}</td>
                        <td className="py-1.5 pr-4 font-mono">{s?.n ?? "—"}</td>
                        <td className="py-1.5 pr-4 font-mono">{s?.hitRate != null ? `${s.hitRate.toFixed(0)}%` : "—"}</td>
                        <td className="py-1.5 pr-4 font-mono">{fmtPct(s?.median, true)}</td>
                        <td className="py-1.5 pr-4 font-mono text-emerald-400">{fmtPct(s?.best, true)}</td>
                        <td className="py-1.5 font-mono text-red-400">{fmtPct(s?.worst, true)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {p.variants?.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Trigger-tweak check (the effect must not vanish when the threshold moves)
              </div>
              <div className="flex flex-wrap gap-3 font-mono text-xs text-slate-400">
                {p.variants.map((v, i) => (
                  <span key={i}>
                    {Object.entries(v.params).map(([k, val]) => `${k}=${val}`).join(", ")} → {fmtPct(v.median, true)} ({v.n} ex.)
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PatternLibrary() {
  const [lib, setLib] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/patterns/library", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Server returned ${r.status}`);
        return r.json();
      })
      .then((data: Library) => setLib(data))
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, []);

  const survived = lib?.patterns.filter((p) => p.status === "SURVIVED") ?? [];
  const noEdge = lib?.patterns.filter((p) => p.status === "NO_EDGE") ?? [];
  const insufficient = lib?.patterns.filter((p) => p.status === "INSUFFICIENT") ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
          <FlaskConical className="h-6 w-6 text-gold-500" /> Pattern Library
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Every idea here was written down <em>before</em> testing, then run against 50+ years of official price
          history with strict rules: no peeking at the future, overlapping signals counted once, and no statistics
          shown for anything with fewer than 15 past examples. Failed ideas stay on this page — the graveyard is
          the proof we're not cherry-picking.
        </p>
      </div>

      {loading && <div className="glass-card p-6 text-slate-400">Loading the pattern library…</div>}

      {error && (
        <div className="glass-card border border-red-500/20 p-6 text-sm text-slate-400">
          Couldn't load the pattern library ({error}). If this is a fresh database, run the history backfill first
          (<span className="font-mono text-xs">/api/goldhistory/sync</span>), then the engine
          (<span className="font-mono text-xs">/api/patterns/run</span>).
        </div>
      )}

      {lib && lib.patterns.length === 0 && (
        <div className="glass-card p-6 text-sm text-slate-400">
          The pattern engine hasn't run yet. It runs automatically each night after the data sync, or hit{" "}
          <span className="font-mono text-xs">/api/patterns/run</span> once to compute it now.
        </div>
      )}

      {lib && lib.patterns.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="glass-card p-4">
              <div className="text-xs text-slate-500">Ideas tested</div>
              <div className="mt-1 font-mono text-2xl text-white">{lib.summary.tested}</div>
            </div>
            <div className="glass-card p-4">
              <div className="text-xs text-slate-500">Survived every test</div>
              <div className="mt-1 font-mono text-2xl text-emerald-400">{lib.summary.survived}</div>
            </div>
            <div className="glass-card p-4">
              <div className="text-xs text-slate-500">Expected to survive by pure luck</div>
              <div className="mt-1 font-mono text-2xl text-slate-300">~{lib.summary.expectedSurvivorsByChance}</div>
            </div>
            <div className="glass-card p-4">
              <div className="text-xs text-slate-500">Signalling right now</div>
              <div className="mt-1 font-mono text-2xl text-gold-500">{lib.summary.activeToday.length}</div>
            </div>
          </div>

          <div className="glass-card border border-gold-500/10 p-4 text-xs text-slate-500">
            <strong className="text-slate-400">Read this first:</strong> with {lib.summary.tested} ideas tested,
            roughly {lib.summary.expectedSurvivorsByChance} would pass every test by pure luck even if no real
            patterns existed. Survivors are "consistent with history", not guarantees — the real test is the live,
            timestamped record this app builds from today forward. Past patterns can stop working, and none of this
            is trading advice.
          </div>

          {survived.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-400">
                Survivors ({survived.length})
              </h2>
              {survived.map((p) => (
                <PatternCard key={p.pattern_id} p={p} />
              ))}
            </section>
          )}

          {noEdge.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-red-400">
                The graveyard — tested, no edge found ({noEdge.length})
              </h2>
              {noEdge.map((p) => (
                <PatternCard key={p.pattern_id} p={p} />
              ))}
            </section>
          )}

          {insufficient.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                Too rare to judge ({insufficient.length})
              </h2>
              {insufficient.map((p) => (
                <PatternCard key={p.pattern_id} p={p} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
