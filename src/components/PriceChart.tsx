import { useState, useEffect } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Loader2, Info } from 'lucide-react';
import { cn } from '../utils/cn';

type PriceRow = {
  date: string;
  close: number;
  changeUsd: number | null;
  changePct: number | null;
};

const RANGES = [
  { label: '1W', days: 7 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
] as const;

export default function PriceChart() {
  const [data, setData] = useState<PriceRow[]>([]);
  const [range, setRange] = useState<number>(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/prices/latest?metal=GOLD', { signal: controller.signal })
      .then(r => r.json())
      .then(json => {
        const rows: PriceRow[] = (json?.prices ?? []).reverse();
        setData(rows);
      })
      .catch(e => { if (e.name !== 'AbortError') console.error(e); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const filtered = data.slice(-range);
  const closes = filtered.map(d => d.close).filter(Boolean);
  const min = closes.length > 0 ? Math.min(...closes) : 0;
  const max = closes.length > 0 ? Math.max(...closes) : 5000;
  const pad = Math.max((max - min) * 0.1, 20);
  const first = filtered[0]?.close ?? 0;
  const last = filtered[filtered.length - 1]?.close ?? 0;
  const totalChange = first > 0 ? ((last - first) / first) * 100 : 0;
  const isUp = totalChange >= 0;

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div>
            <h3 className="font-semibold text-lg">Gold Price History</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              CME settlement — {filtered.length} trading days
            </p>
          </div>
          <div className="group relative">
            <Info className="w-4 h-4 text-zinc-600 cursor-help" />
            <div className="absolute top-full left-0 mt-2 w-72 p-3 bg-zinc-900 border border-zinc-700 rounded-lg text-[11px] text-zinc-400 leading-relaxed opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
              <p className="mb-2"><strong>Settlement Price</strong> = the official daily closing price set by CME Group. Tracks within $1-2 of spot.</p>
              <p className="mb-2">Green fill = price is up over the selected period. Red fill = price is down.</p>
              <p>Use the 1W/1M/3M toggles to check short-term momentum vs longer trends. A rising 3M trend with a dipping 1W can be a buy-the-dip opportunity.</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {filtered.length > 1 && (
            <span className={cn(
              "text-sm font-bold",
              isUp ? "text-emerald-400" : "text-rose-400"
            )}>
              {isUp ? '+' : ''}{totalChange.toFixed(2)}%
            </span>
          )}
          <div className="flex bg-zinc-950 p-0.5 rounded-lg border border-zinc-800">
            {RANGES.map(r => (
              <button
                key={r.label}
                onClick={() => setRange(r.days)}
                className={cn(
                  "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                  range === r.days
                    ? "bg-gold-500 text-black shadow-sm"
                    : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="h-[220px] w-full">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 text-gold-500 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-zinc-500">
            No price data — click Sync All to fetch
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={filtered}>
              <defs>
                <linearGradient id="gradPrice" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={isUp ? '#10B981' : '#EF4444'} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={isUp ? '#10B981' : '#EF4444'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="date"
                stroke="#71717a"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val) => {
                  const d = new Date(val);
                  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                }}
                interval={Math.max(Math.floor(filtered.length / 6), 0)}
              />
              <YAxis
                stroke="#71717a"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                domain={[min - pad, max + pad]}
                tickFormatter={(val) => `$${val.toLocaleString()}`}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                labelStyle={{ color: '#71717a', fontSize: '10px' }}
                formatter={(value: number) => [`$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 'Settlement']}
              />
              <Area
                type="monotone"
                dataKey="close"
                stroke={isUp ? '#10B981' : '#EF4444'}
                strokeWidth={2}
                fill="url(#gradPrice)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: isUp ? '#10B981' : '#EF4444' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
