import { useState, useEffect } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Loader2, Info, Target } from 'lucide-react';
import { cn } from '../utils/cn';

type OIRow = {
  date: string;
  oiContracts: number;
  oiOz: number;
  registeredOz: number | null;
  coverageRatio: number | null;
};

type Props = {
  refreshKey?: number;
};

export default function OpenInterest({ refreshKey }: Props) {
  const [data, setData] = useState<OIRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/oi/latest?metal=GOLD', { signal: controller.signal })
      .then(r => r.json())
      .then(json => setData((json?.data ?? []).reverse()))
      .catch(e => { if (e.name !== 'AbortError') console.error(e); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [refreshKey]);

  if (loading) {
    return (
      <div className="glass-card p-8 flex items-center justify-center">
        <Loader2 className="w-5 h-5 text-gold-500 animate-spin" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="glass-card p-6">
        <h3 className="font-semibold text-lg mb-2">Open Interest & Coverage</h3>
        <p className="text-sm text-zinc-500">No data — click Sync All to fetch.</p>
      </div>
    );
  }

  const latest = data[data.length - 1];
  const prev = data.length > 1 ? data[data.length - 2] : null;
  const oiChange = prev ? latest.oiContracts - prev.oiContracts : null;
  const coverage = latest.coverageRatio;

  const coverageColor = coverage != null
    ? coverage < 3 ? 'text-rose-400' : coverage < 5 ? 'text-amber-400' : 'text-zinc-100'
    : 'text-zinc-400';
  const coverageLabel = coverage != null
    ? coverage < 3 ? 'Critical' : coverage < 5 ? 'Tight' : 'Normal'
    : '—';

  const chartData = data.map(d => ({
    date: d.date,
    oi: d.oiContracts,
    coverage: d.coverageRatio,
  }));

  return (
    <div className="glass-card p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Target className="w-5 h-5 text-gold-500" />
            <h3 className="font-semibold text-lg">Open Interest & Coverage Ratio</h3>
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            Outstanding COMEX gold contracts vs physical supply available for delivery
          </p>
        </div>
        <div className="group relative">
          <Info className="w-4 h-4 text-zinc-600 cursor-help" />
          <div className="absolute top-full right-0 mt-2 w-72 p-3 bg-zinc-900 border border-zinc-700 rounded-lg text-[11px] text-zinc-400 leading-relaxed opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
            <p className="mb-2"><strong>Open Interest</strong> = total outstanding futures contracts. Each contract = 100 oz gold.</p>
            <p className="mb-2"><strong>Coverage Ratio</strong> = registered gold ÷ OI gold × 100. Shows what % of outstanding claims can actually be delivered.</p>
            <p>Below 3% = critical squeeze territory. If even a small fraction of holders demand delivery, there isn't enough metal.</p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Open Interest</p>
          <p className="text-xl font-black text-zinc-100">
            {(latest.oiContracts / 1000).toFixed(1)}k
          </p>
          <p className="text-[10px] text-zinc-600">contracts</p>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">OI in Ounces</p>
          <p className="text-xl font-black text-zinc-100">
            {(latest.oiOz / 1_000_000).toFixed(1)}M
          </p>
          <p className="text-[10px] text-zinc-600">oz claimed</p>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Daily Δ</p>
          <p className={cn(
            "text-xl font-black",
            oiChange != null && oiChange > 0 ? "text-zinc-100" : oiChange != null && oiChange < 0 ? "text-zinc-400" : "text-zinc-500"
          )}>
            {oiChange != null ? `${oiChange > 0 ? '+' : ''}${(oiChange / 1000).toFixed(1)}k` : '—'}
          </p>
          <p className="text-[10px] text-zinc-600">contracts</p>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Coverage</p>
          <p className={cn("text-xl font-black", coverageColor)}>
            {coverage != null ? `${coverage.toFixed(1)}%` : '—'}
          </p>
          <p className={cn("text-[10px] font-bold", coverageColor)}>{coverageLabel}</p>
        </div>
      </div>

      {/* Chart — OI as area, coverage as line */}
      <div className="h-[250px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData}>
            <defs>
              <linearGradient id="gradOI" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#F39C12" stopOpacity={0.15} />
                <stop offset="100%" stopColor="#F39C12" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              interval={Math.max(Math.floor(chartData.length / 6), 0)}
              tickFormatter={(val) => new Date(val).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            />
            <YAxis
              yAxisId="oi"
              stroke="#F39C12"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
              label={{ value: 'OI', angle: -90, position: 'insideLeft', style: { fill: '#F39C12', fontSize: 9, fontWeight: 700 }, offset: 10 }}
            />
            <YAxis
              yAxisId="cov"
              orientation="right"
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => `${v}%`}
              domain={[0, 'dataMax + 2']}
              label={{ value: 'Coverage %', angle: 90, position: 'insideRight', style: { fill: '#71717a', fontSize: 9, fontWeight: 700 }, offset: 10 }}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
              labelStyle={{ color: '#71717a', fontSize: '10px' }}
              formatter={(value: number, name: string) => {
                if (name === 'oi') return [`${(value / 1000).toFixed(1)}k contracts`, 'Open Interest'];
                return [`${value.toFixed(2)}%`, 'Coverage Ratio'];
              }}
            />
            <Area
              yAxisId="oi"
              type="monotone"
              dataKey="oi"
              stroke="#F39C12"
              strokeWidth={2}
              fill="url(#gradOI)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: '#F39C12' }}
            />
            <Line
              yAxisId="cov"
              type="monotone"
              dataKey="coverage"
              stroke="#EF4444"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: '#EF4444' }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-4 mt-3 text-[10px] font-bold uppercase text-zinc-500">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 bg-gold-500 rounded-full" />
          <span>Open Interest</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 bg-rose-500 rounded-full" />
          <span>Coverage Ratio</span>
        </div>
      </div>
    </div>
  );
}
