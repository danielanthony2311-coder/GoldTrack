import { useEffect, useState } from 'react';
import { cn } from '../utils/cn';

// Prediction scoreboard — the roadmap's graded track record. High-conviction
// alerts fire only when a pattern that already SURVIVED the backtest goes active
// (rare by design, not daily coin-flips). Each call is graded against the LBMA
// fix at its horizon. Two honest numbers: the LEDGER hit-rate (every firing,
// historical + live, auditable) and the LIVE hit-rate (out-of-sample, from
// go-live). Not a promise — a scoreboard the product is held to.

type Backtest = { hitRate: number | null; n: number | null; wilsonLo: number | null; wilsonHi: number | null; medianPct: number | null };
type Live = { graded: number; hits: number; open: number; hitRate: number | null };
type PatternRow = { patternId: string; name: string; family: string; direction: 'UP' | 'DOWN'; horizonDays: number; backtest: Backtest; live: Live };
type Scoreboard = {
  metal: string;
  patterns: PatternRow[];
  overallLive: { graded: number; hits: number; open: number; hitRate: number | null; wilson: [number, number] | null; since: string | null };
  ledger: { graded: number; hits: number; hitRate: number | null; wilson: [number, number] | null };
};
type ActiveAlert = { patternId: string; name: string; direction: 'UP' | 'DOWN'; createdDate: string; horizonDays: number; tradingDaysRemaining: number | null; expectedHitRate: number | null; moveSinceEntryPct: number | null; thesis: string; tripwire: string };
type RecentCall = { name: string; direction: 'UP' | 'DOWN'; status: string; source: string; created: string; graded: string | null; returnPct: number | null };
type Latest = { spot: number | null; active: ActiveAlert[]; recent: RecentCall[] };

const DirBadge = ({ dir }: { dir: 'UP' | 'DOWN' }) => (
  <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide',
    dir === 'UP' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400')}>
    {dir === 'UP' ? '▲ GOLD UP' : '▼ GOLD DOWN'}
  </span>
);

export default function PredictionsScoreboard({ metal }: { metal: string }) {
  const [sb, setSb] = useState<Scoreboard | null>(null);
  const [latest, setLatest] = useState<Latest | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const [s, l] = await Promise.all([
          fetch('/api/predictions/scoreboard', { signal: ac.signal }),
          fetch('/api/predictions/latest', { signal: ac.signal }),
        ]);
        if (!s.ok || !l.ok) throw new Error('scoreboard fetch failed');
        setSb(await s.json());
        setLatest(await l.json());
      } catch (e: any) {
        if (e.name !== 'AbortError') setErr(e.message);
      }
    })();
    return () => ac.abort();
  }, [metal]);

  if (err) return <div className="glass-card p-6 text-rose-400 text-sm">Scoreboard error: {err}</div>;
  if (!sb || !latest) return <div className="glass-card p-6 text-zinc-500 text-sm animate-pulse">Loading prediction scoreboard…</div>;

  const ledgerRate = sb.ledger.hitRate;
  const survived = sb.patterns;

  return (
    <div className="glass-card p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Prediction Scoreboard</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            High-conviction alerts, fired only when a backtest-survived pattern activates. Graded against the gold fix at each horizon.
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-zinc-600 mt-1">{sb.metal}</span>
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <div className="rounded-xl border border-gold-500/20 bg-gold-500/[0.04] p-4">
          <div className="text-[11px] uppercase tracking-wider text-gold-500/80 mb-1">Track record (all graded calls)</div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-gold-500">{ledgerRate != null ? `${ledgerRate}%` : '—'}</span>
            <span className="text-sm text-zinc-400">of {sb.ledger.graded} calls hit</span>
          </div>
          {sb.ledger.wilson && (
            <div className="text-[11px] text-zinc-500 mt-1">95% CI {sb.ledger.wilson[0]}–{sb.ledger.wilson[1]}% · auditable ledger below</div>
          )}
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Live (out-of-sample)</div>
          {sb.overallLive.graded > 0 ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-zinc-100">{sb.overallLive.hitRate}%</span>
                <span className="text-sm text-zinc-400">of {sb.overallLive.graded} live calls</span>
              </div>
              <div className="text-[11px] text-zinc-500 mt-1">since {sb.overallLive.since} · {sb.overallLive.open} open</div>
            </>
          ) : (
            <div className="text-sm text-zinc-500 mt-2">
              Live tracking armed. No graded calls yet — the forward record starts the next time an alert fires and matures.
            </div>
          )}
        </div>
      </div>

      {/* Active alerts */}
      <div className="mb-6">
        <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Active alerts</div>
        {latest.active.length === 0 ? (
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.01] px-4 py-3 text-sm text-zinc-500">
            No high-conviction alert active right now. This is normal — alerts are rare by design (only fire when a survived pattern triggers).
          </div>
        ) : (
          <div className="space-y-2">
            {latest.active.map((a) => (
              <div key={a.patternId} className="rounded-lg border border-gold-500/20 bg-gold-500/[0.03] p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-zinc-100">{a.name}</span>
                  <div className="flex items-center gap-2">
                    <DirBadge dir={a.direction} />
                    {a.tradingDaysRemaining != null && (
                      <span className="text-[11px] text-zinc-400">{a.tradingDaysRemaining} td left</span>
                    )}
                  </div>
                </div>
                <p className="text-xs text-zinc-400">{a.thesis}</p>
                <p className="text-[11px] text-rose-400/80 mt-1">{a.tripwire}</p>
                {a.moveSinceEntryPct != null && (
                  <p className="text-[11px] text-zinc-500 mt-1">Since entry: {a.moveSinceEntryPct > 0 ? '+' : ''}{a.moveSinceEntryPct}%</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-pattern scoreboard */}
      <div className="mb-6">
        <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">By signal (backtested)</div>
        <div className="space-y-2">
          {survived.map((p) => {
            const rate = p.backtest.hitRate ?? 0;
            return (
              <div key={p.patternId} className="flex items-center gap-3">
                <div className="w-44 shrink-0">
                  <div className="text-[13px] text-zinc-200 truncate">{p.name}</div>
                  <div className="text-[10px] text-zinc-600">{p.direction} · {p.horizonDays}td · n={p.backtest.n}</div>
                </div>
                <div className="flex-1 h-5 rounded bg-white/[0.03] overflow-hidden relative">
                  <div className="h-full rounded" style={{ width: `${rate}%`, background: rate >= 65 ? '#10b981' : rate >= 55 ? '#F39C12' : '#71717a' }} />
                  <span className="absolute inset-0 flex items-center px-2 text-[11px] font-semibold text-zinc-100">{p.backtest.hitRate}%</span>
                </div>
                <div className="w-16 shrink-0 text-right text-[10px] text-zinc-500">
                  {p.live.graded > 0 ? `live ${p.live.hitRate}%` : p.live.open > 0 ? `${p.live.open} open` : 'live —'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent graded calls */}
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Recent graded calls</div>
        <div className="space-y-1">
          {latest.recent.map((r, i) => (
            <div key={i} className="flex items-center gap-3 text-xs py-1 border-b border-white/[0.03] last:border-0">
              <span className={cn('w-14 shrink-0 font-bold text-[10px]',
                r.status === 'HIT' ? 'text-emerald-400' : r.status === 'MISS' ? 'text-rose-400' : 'text-amber-400')}>
                {r.status}
              </span>
              <span className="flex-1 text-zinc-300 truncate">{r.name}</span>
              <span className={cn('shrink-0 tabular-nums', (r.returnPct ?? 0) >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80')}>
                {r.returnPct != null ? `${r.returnPct > 0 ? '+' : ''}${r.returnPct}%` : '—'}
              </span>
              <span className="w-20 shrink-0 text-right text-zinc-600">{r.graded ?? r.created}</span>
              {r.source === 'backtest' && <span className="w-14 shrink-0 text-right text-[9px] text-zinc-700 uppercase">hist</span>}
              {r.source === 'live' && <span className="w-14 shrink-0 text-right text-[9px] text-gold-500/70 uppercase">live</span>}
            </div>
          ))}
        </div>
      </div>

      <p className="text-[10px] text-zinc-600 mt-4 leading-relaxed">
        Ledger = every historical firing of the survived patterns, graded (in-sample evidence). Live = out-of-sample calls since go-live, the real forward test. Alerts are rare by design; this is a scoreboard, not a daily signal.
      </p>
    </div>
  );
}
