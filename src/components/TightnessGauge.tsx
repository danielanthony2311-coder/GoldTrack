import { useEffect, useState } from 'react';
import { cn } from '../utils/cn';

// COMEX Tightness gauge — dashboard centerpiece. One 0-100 number:
// "how physically tight is COMEX vs its own history?" Every component is a
// percentile with its n and window shown; warming-up components are named,
// not hidden; the composite's confidence (share of live weight) is always
// visible and the score dims below 50% confidence. Not a forecast — the
// method line says so on the card.

type Component = {
  key: string;
  label: string;
  status: 'LIVE' | 'WARMING_UP';
  weight: number;
  pctl: number | null;
  raw: string | null;
  n: number;
  window: string;
  note: string;
};

type Tightness = {
  date: string;
  metal: string;
  score: number | null;
  confidence: number;
  zone: 'LOOSE' | 'NEUTRAL' | 'ELEVATED' | 'TIGHT' | null;
  definition: string;
  components: Component[];
  history?: { date: string; score: number }[];
};

const ZONES: Record<string, { color: string; text: string; desc: string }> = {
  LOOSE: { color: '#3b82f6', text: 'text-blue-400', desc: 'Looser than most of measured history' },
  NEUTRAL: { color: '#a1a1aa', text: 'text-zinc-400', desc: 'Around the middle of measured history' },
  ELEVATED: { color: '#f59e0b', text: 'text-amber-400', desc: 'Tighter than most of measured history' },
  TIGHT: { color: '#f43f5e', text: 'text-rose-400', desc: 'Near the tightest conditions measured' },
};

function GaugeArc({ score, zone, dimmed }: { score: number | null; zone: string | null; dimmed: boolean }) {
  // Semicircle from 180° to 0°, radius 84, stroke 14.
  const R = 84;
  const CIRC = Math.PI * R;
  const frac = score == null ? 0 : score / 100;
  const color = zone ? ZONES[zone].color : '#3f3f46';
  return (
    <svg viewBox="0 0 200 116" className="w-full max-w-[260px]">
      {/* track */}
      <path
        d={`M 16 108 A ${R} ${R} 0 0 1 184 108`}
        fill="none"
        stroke="rgba(255,255,255,0.07)"
        strokeWidth="14"
        strokeLinecap="round"
      />
      {/* zone boundary ticks at 40 / 60 / 80 */}
      {[40, 60, 80].map((t) => {
        const a = Math.PI * (1 - t / 100);
        const x1 = 100 + (R - 11) * Math.cos(a);
        const y1 = 108 - (R - 11) * Math.sin(a);
        const x2 = 100 + (R + 11) * Math.cos(a);
        const y2 = 108 - (R + 11) * Math.sin(a);
        return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />;
      })}
      {/* value arc */}
      <path
        d={`M 16 108 A ${R} ${R} 0 0 1 184 108`}
        fill="none"
        stroke={color}
        strokeWidth="14"
        strokeLinecap="round"
        strokeDasharray={`${CIRC * frac} ${CIRC}`}
        opacity={dimmed ? 0.4 : 1}
        style={{ transition: 'stroke-dasharray 0.9s cubic-bezier(0.22,1,0.36,1), stroke 0.5s' }}
      />
      {/* endpoints */}
      <text x="16" y="115" textAnchor="middle" fontSize="8" fill="#71717a" fontFamily="JetBrains Mono, monospace">0</text>
      <text x="184" y="115" textAnchor="middle" fontSize="8" fill="#71717a" fontFamily="JetBrains Mono, monospace">100</text>
    </svg>
  );
}

function Sparkline({ history }: { history: { date: string; score: number }[] }) {
  if (history.length < 5) return null;
  const W = 120, H = 28;
  const xs = history.map((_, i) => (i / (history.length - 1)) * W);
  const ys = history.map((h) => H - (h.score / 100) * H);
  const points = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  return (
    <div className="flex items-center gap-2" title={`${history.length}-day score history`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-[120px] h-[28px]">
        <polyline points={points} fill="none" stroke="#F39C12" strokeWidth="1.5" />
      </svg>
      <span className="text-[10px] font-mono text-zinc-500">{history.length}d</span>
    </div>
  );
}

export default function TightnessGauge({ metal }: { metal: 'GOLD' | 'SILVER' }) {
  const [data, setData] = useState<Tightness | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        setError(null);
        let res = await fetch(`/api/tightness/latest?metal=${metal}`, { signal: ctrl.signal });
        if (res.status === 404) {
          // first visit on a fresh DB — compute once, then re-read
          await fetch(`/api/tightness/run?metal=${metal}`, { signal: ctrl.signal });
          res = await fetch(`/api/tightness/latest?metal=${metal}`, { signal: ctrl.signal });
        }
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        setData(await res.json());
      } catch (e: any) {
        if (e.name !== 'AbortError') setError(e.message);
      }
    })();
    return () => ctrl.abort();
  }, [metal]);

  if (error) {
    return (
      <div className="glass-card p-5">
        <p className="text-xs uppercase tracking-widest text-zinc-500 font-mono mb-2">COMEX Tightness</p>
        <p className="text-sm text-zinc-400">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="glass-card p-5 animate-pulse">
        <p className="text-xs uppercase tracking-widest text-zinc-500 font-mono">COMEX Tightness</p>
        <div className="h-40" />
      </div>
    );
  }

  const lowConfidence = data.confidence < 0.5;
  const liveCount = data.components.filter((c) => c.status === 'LIVE').length;
  const zone = data.zone ? ZONES[data.zone] : null;

  return (
    <div className="glass-card p-5">
      {/* header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-widest text-zinc-500 font-mono">
            COMEX Tightness · {data.metal}
          </p>
          <p className="text-[11px] text-zinc-500 mt-0.5 font-mono">
            as of {data.date} · percentile vs own history · not a forecast
          </p>
        </div>
        {data.history && <Sparkline history={data.history} />}
      </div>

      <div className="grid md:grid-cols-2 gap-6 mt-4 items-center">
        {/* gauge */}
        <div className="flex flex-col items-center">
          <div className="relative flex flex-col items-center">
            <GaugeArc score={data.score} zone={data.zone} dimmed={lowConfidence} />
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
              <span
                className={cn(
                  'text-5xl font-bold tabular-nums leading-none',
                  lowConfidence ? 'text-zinc-500' : 'text-zinc-50'
                )}
              >
                {data.score ?? '—'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3 flex-wrap justify-center">
            {zone && (
              <span
                className={cn('text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-white/5', zone.text)}
                title={zone.desc}
              >
                {data.zone}
              </span>
            )}
            <span
              className={cn(
                'text-[11px] font-mono px-2 py-0.5 rounded-md',
                lowConfidence ? 'bg-amber-500/10 text-amber-400' : 'bg-white/5 text-zinc-400'
              )}
            >
              confidence {(data.confidence * 100).toFixed(0)}% · {liveCount}/{data.components.length} components live
            </span>
          </div>
          {lowConfidence && (
            <p className="text-[11px] text-amber-400/90 mt-2 text-center max-w-[260px]">
              Warming up — most components need more collected history before this number means much.
            </p>
          )}
          {data.score == null && (
            <p className="text-[11px] text-zinc-500 mt-2 text-center max-w-[260px]">
              No component has enough history yet to score {data.metal}.
            </p>
          )}
        </div>

        {/* component breakdown */}
        <div className="space-y-2.5">
          {data.components.map((c) => (
            <div key={c.key} title={c.note}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-zinc-300 font-medium truncate">{c.label}</span>
                <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                  w {(c.weight * 100).toFixed(0)}%
                </span>
              </div>
              {c.status === 'LIVE' ? (
                <>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gold-500"
                        style={{ width: `${c.pctl ?? 0}%`, transition: 'width 0.8s cubic-bezier(0.22,1,0.36,1)' }}
                      />
                    </div>
                    <span className="text-[11px] font-mono text-zinc-200 tabular-nums w-8 text-right">
                      {Math.round(c.pctl ?? 0)}
                    </span>
                  </div>
                  <p className="text-[10.5px] text-zinc-500 mt-0.5 truncate" title={`${c.raw} · n=${c.n} · ${c.window}`}>
                    {c.raw} <span className="font-mono">· n={c.n.toLocaleString()}</span>
                  </p>
                </>
              ) : (
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex-1 h-1.5 rounded-full bg-white/[0.04]" />
                  <span
                    className="text-[10px] font-mono text-zinc-500 bg-white/5 px-1.5 py-0.5 rounded shrink-0"
                    title={c.window}
                  >
                    warming up
                  </span>
                </div>
              )}
            </div>
          ))}
          <p className="text-[10px] text-zinc-600 font-mono pt-1">
            score = weight-averaged percentile of live components · weights fixed ({Object.values(data.components.map((c) => (c.weight * 100).toFixed(0))).join('/')}) · {data.definition}
          </p>
        </div>
      </div>
    </div>
  );
}
