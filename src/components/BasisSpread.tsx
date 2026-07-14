import { useState, useEffect } from 'react';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Loader2, Info, GitCompareArrows } from 'lucide-react';
import { cn } from '../utils/cn';

type PriceRow = {
  date: string;
  close: number;
  changeUsd: number | null;
  changePct: number | null;
};

export default function BasisSpread() {
  const [data, setData] = useState<PriceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
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

  if (loading) {
    return (
      <div className="glass-card p-8 flex items-center justify-center">
        <Loader2 className="w-5 h-5 text-gold-500 animate-spin" />
      </div>
    );
  }

  if (data.length < 3) {
    return (
      <div className="glass-card p-6">
        <h3 className="font-semibold text-lg mb-2">Daily Price Momentum</h3>
        <p className="text-sm text-zinc-500">Not enough data — click Sync All.</p>
      </div>
    );
  }

  // Show daily $ change as bars — positive = green, negative = red
  const chartData = data
    .filter(d => d.changeUsd != null)
    .map(d => ({
      date: d.date,
      change: Number(d.changeUsd!.toFixed(2)),
      close: d.close,
    }));

  // Count consecutive up/down days
  let streak = 0;
  let streakDir = '';
  if (chartData.length > 0) {
    const last = chartData[chartData.length - 1].change;
    streakDir = last >= 0 ? 'up' : 'down';
    for (let i = chartData.length - 1; i >= 0; i--) {
      if ((streakDir === 'up' && chartData[i].change >= 0) ||
          (streakDir === 'down' && chartData[i].change < 0)) {
        streak++;
      } else break;
    }
  }

  const avgChange = chartData.reduce((s, d) => s + d.change, 0) / chartData.length;
  const maxUp = Math.max(...chartData.map(d => d.change));
  const maxDown = Math.min(...chartData.map(d => d.change));

  return (
    <div className="glass-card p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <GitCompareArrows className="w-5 h-5 text-gold-500" />
            <h3 className="font-semibold text-lg">Daily Price Momentum</h3>
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            Settlement daily changes — streak detection and momentum bias
          </p>
        </div>
        <div className="group relative">
          <Info className="w-4 h-4 text-zinc-600 cursor-help" />
          <div className="absolute top-full right-0 mt-2 w-64 p-3 bg-zinc-900 border border-zinc-700 rounded-lg text-[11px] text-zinc-400 leading-relaxed opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
            Shows whether gold is in an up or down streak. Multiple consecutive green bars suggest momentum building. A streak reversal after a run of red can signal an inflection point.
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Streak</p>
          <p className={cn(
            "text-lg font-black",
            streakDir === 'up' ? "text-emerald-400" : "text-rose-400"
          )}>
            {streak} {streakDir === 'up' ? '▲' : '▼'}
          </p>
          <p className="text-[10px] text-zinc-600">consecutive {streakDir} days</p>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Avg Daily Δ</p>
          <p className={cn(
            "text-lg font-black",
            avgChange > 0 ? "text-emerald-400" : avgChange < 0 ? "text-rose-400" : "text-zinc-400"
          )}>
            {avgChange > 0 ? '+' : ''}${avgChange.toFixed(1)}
          </p>
          <p className="text-[10px] text-zinc-600">over {chartData.length} days</p>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Range</p>
          <p className="text-lg font-black text-zinc-100">
            ${Math.abs(maxDown).toFixed(0)} — ${maxUp.toFixed(0)}
          </p>
          <p className="text-[10px] text-zinc-600">max down / max up</p>
        </div>
      </div>

      {/* Bar chart */}
      <div className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              interval={Math.max(Math.floor(chartData.length / 6), 0)}
              tickFormatter={(val) => {
                const d = new Date(val);
                return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
              }}
            />
            <YAxis
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => `$${v}`}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
              labelStyle={{ color: '#71717a', fontSize: '10px' }}
              formatter={(value: number) => [`${value > 0 ? '+' : ''}$${value.toFixed(2)}`, 'Daily Change']}
            />
            <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
            <Bar dataKey="change" radius={[2, 2, 0, 0]} barSize={12}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.change >= 0 ? '#10B981' : '#EF4444'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
