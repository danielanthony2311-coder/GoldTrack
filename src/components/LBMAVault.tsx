import { useState, useEffect } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Loader2, Info, Warehouse } from 'lucide-react';
import { cn } from '../utils/cn';

type VaultRow = {
  month: string;
  goldOz: number;
  goldTonnes: number;
};

export default function LBMAVault() {
  const [data, setData] = useState<VaultRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/lbma/latest', { signal: controller.signal })
      .then(r => r.json())
      .then(json => setData((json?.vaults ?? []).reverse()))
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

  if (data.length === 0) {
    return (
      <div className="glass-card p-6">
        <h3 className="font-semibold text-lg mb-2">London Vault Holdings (LBMA)</h3>
        <p className="text-sm text-zinc-500">No data — click Sync All to fetch.</p>
      </div>
    );
  }

  const latest = data[data.length - 1];
  const prev = data.length > 1 ? data[data.length - 2] : null;
  const changeOz = prev ? latest.goldOz - prev.goldOz : null;
  const changePct = prev && prev.goldOz > 0 ? ((latest.goldOz - prev.goldOz) / prev.goldOz) * 100 : null;

  // Total drain from start of data
  const first = data[0];
  const totalDrain = latest.goldTonnes - first.goldTonnes;

  return (
    <div className="glass-card p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Warehouse className="w-5 h-5 text-gold-500" />
            <h3 className="font-semibold text-lg">London Vault Holdings</h3>
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            LBMA aggregate gold in London vaults — updated monthly
          </p>
        </div>
        <div className="group relative">
          <Info className="w-4 h-4 text-zinc-600 cursor-help" />
          <div className="absolute top-full right-0 mt-2 w-64 p-3 bg-zinc-900 border border-zinc-700 rounded-lg text-[11px] text-zinc-400 leading-relaxed opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
            London vaults hold far more gold than COMEX (~230M oz vs ~30M oz). A sustained drain from London signals global physical tightening — central banks, ETFs, and institutions are pulling metal.
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Current</p>
          <p className="text-lg font-black text-zinc-100">
            {(latest.goldOz / 1_000_000).toFixed(1)}M oz
          </p>
          <p className="text-[10px] text-zinc-600">{latest.goldTonnes.toLocaleString()}t</p>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Monthly Δ</p>
          <p className={cn(
            "text-lg font-black",
            changeOz != null && changeOz > 0 ? "text-emerald-400" : changeOz != null && changeOz < 0 ? "text-rose-400" : "text-zinc-400"
          )}>
            {changeOz != null ? `${changeOz > 0 ? '+' : ''}${(changeOz / 1_000_000).toFixed(1)}M` : '—'}
          </p>
          <p className="text-[10px] text-zinc-600">
            {changePct != null ? `${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%` : ''}
          </p>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Total Δ ({data.length}mo)</p>
          <p className={cn(
            "text-lg font-black",
            totalDrain > 0 ? "text-emerald-400" : totalDrain < 0 ? "text-rose-400" : "text-zinc-400"
          )}>
            {totalDrain > 0 ? '+' : ''}{totalDrain.toFixed(0)}t
          </p>
          <p className="text-[10px] text-zinc-600">{first.month} → {latest.month}</p>
        </div>
      </div>

      {/* Chart */}
      <div className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="gradLBMA" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#F39C12" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#F39C12" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="month"
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              interval={Math.max(Math.floor(data.length / 6), 0)}
            />
            <YAxis
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => `${(v / 1_000_000).toFixed(0)}M`}
              domain={['dataMin - 2000000', 'dataMax + 2000000']}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
              labelStyle={{ color: '#71717a', fontSize: '10px' }}
              formatter={(value: number) => [`${(value / 1_000_000).toFixed(1)}M oz (${(value / 32150.7).toFixed(0)}t)`, 'Gold']}
            />
            <Area
              type="monotone"
              dataKey="goldOz"
              stroke="#F39C12"
              strokeWidth={2}
              fill="url(#gradLBMA)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: '#F39C12' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
