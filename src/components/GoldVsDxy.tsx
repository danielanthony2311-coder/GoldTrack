import { useState, useEffect } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Loader2, Info, DollarSign } from 'lucide-react';
import { cn } from '../utils/cn';

type Row = {
  date: string;
  goldPrice: number | null;
  dxy: number | null;
};

type Props = {
  refreshKey?: number;
};

export default function GoldVsDxy({ refreshKey }: Props) {
  const [data, setData] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [goldRes, dxyRes] = await Promise.all([
          fetch('/api/prices/latest?metal=GOLD', { signal: controller.signal }),
          fetch('/api/dxy/latest', { signal: controller.signal }),
        ]);
        if (!goldRes.ok || !dxyRes.ok) return;

        const goldJson = await goldRes.json();
        const dxyJson = await dxyRes.json();
        const goldPrices: any[] = goldJson?.prices ?? [];
        const dxyPrices: any[] = dxyJson?.data ?? [];

        const dxyMap = new Map(dxyPrices.map((d: any) => [d.date, d.close]));

        const allDates = new Set([
          ...goldPrices.map((p: any) => p.date),
          ...dxyPrices.map((d: any) => d.date),
        ]);

        const goldMap = new Map(goldPrices.map((p: any) => [p.date, p.close]));

        const merged: Row[] = [...allDates]
          .sort()
          .map(date => ({
            date,
            goldPrice: goldMap.get(date) ?? null,
            dxy: dxyMap.get(date) ?? null,
          }))
          .filter(r => r.goldPrice !== null || r.dxy !== null);

        setData(merged);
      } catch (e: any) {
        if (e.name !== 'AbortError') console.error(e);
      } finally {
        setLoading(false);
      }
    };
    load();
    return () => controller.abort();
  }, [refreshKey]);

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
        <h3 className="font-semibold text-lg mb-2">Gold vs DXY</h3>
        <p className="text-sm text-zinc-500">No data — click Sync All to fetch.</p>
      </div>
    );
  }

  const goldValues = data.map(d => d.goldPrice).filter((v): v is number => v !== null);
  const dxyValues = data.map(d => d.dxy).filter((v): v is number => v !== null);
  const latestGold = goldValues[goldValues.length - 1];
  const latestDxy = dxyValues[dxyValues.length - 1];
  const firstGold = goldValues[0];
  const firstDxy = dxyValues[0];
  const goldChange = firstGold > 0 ? ((latestGold - firstGold) / firstGold) * 100 : 0;
  const dxyChange = firstDxy > 0 ? ((latestDxy - firstDxy) / firstDxy) * 100 : 0;
  const inversely = (goldChange > 0 && dxyChange < 0) || (goldChange < 0 && dxyChange > 0);

  return (
    <div className="glass-card p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-gold-500" />
            <h3 className="font-semibold text-lg">Gold vs US Dollar Index (DXY)</h3>
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            Inverse correlation — when the dollar weakens, gold typically rises
          </p>
        </div>
        <div className="group relative">
          <Info className="w-4 h-4 text-zinc-600 cursor-help" />
          <div className="absolute top-full right-0 mt-2 w-72 p-3 bg-zinc-900 border border-zinc-700 rounded-lg text-[11px] text-zinc-400 leading-relaxed opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
            <p className="mb-2"><strong>DXY</strong> = US Dollar Index, measuring the dollar against a basket of 6 major currencies (EUR, JPY, GBP, CAD, SEK, CHF).</p>
            <p className="mb-2">Gold and the dollar usually move <strong>inversely</strong>. When DXY drops, gold gets cheaper in other currencies, boosting global demand.</p>
            <p>A <strong>divergence</strong> — gold flat while DXY drops — can signal a pending gold breakout. Gold rising WITH a strong dollar is an even more bullish signal.</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Gold</p>
          <p className="text-xl font-black text-gold-500">${latestGold?.toLocaleString()}</p>
          <p className={cn("text-[10px] font-bold", goldChange >= 0 ? "text-emerald-400" : "text-rose-400")}>
            {goldChange >= 0 ? '+' : ''}{goldChange.toFixed(1)}%
          </p>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">DXY</p>
          <p className="text-xl font-black text-zinc-100">{latestDxy?.toFixed(1)}</p>
          <p className={cn("text-[10px] font-bold", dxyChange >= 0 ? "text-emerald-400" : "text-rose-400")}>
            {dxyChange >= 0 ? '+' : ''}{dxyChange.toFixed(1)}%
          </p>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Correlation</p>
          <p className={cn("text-xl font-black", inversely ? "text-emerald-400" : "text-amber-400")}>
            {inversely ? 'Inverse' : 'Aligned'}
          </p>
          <p className="text-[10px] text-zinc-600">{inversely ? 'Normal pattern' : 'Unusual — watch closely'}</p>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
          <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Signal</p>
          <p className={cn("text-xl font-black",
            goldChange > 0 && dxyChange < 0 ? "text-emerald-400" :
            goldChange > 0 && dxyChange > 0 ? "text-gold-500" :
            "text-zinc-400"
          )}>
            {goldChange > 0 && dxyChange < 0 ? 'Bullish' :
             goldChange > 0 && dxyChange > 0 ? 'Very Bullish' :
             goldChange < 0 && dxyChange > 0 ? 'Bearish' : 'Neutral'}
          </p>
          <p className="text-[10px] text-zinc-600">
            {goldChange > 0 && dxyChange > 0 ? 'Gold rising despite strong dollar' : 'dollar-gold dynamic'}
          </p>
        </div>
      </div>

      <div className="h-[250px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <defs>
              <linearGradient id="gradGoldDxy" x1="0" y1="0" x2="0" y2="1">
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
              interval={Math.max(Math.floor(data.length / 6), 0)}
              tickFormatter={(val) => new Date(val).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            />
            <YAxis
              yAxisId="gold"
              stroke="#F39C12"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => `$${(v / 1000).toFixed(1)}k`}
              label={{ value: 'Gold', angle: -90, position: 'insideLeft', style: { fill: '#F39C12', fontSize: 9, fontWeight: 700 }, offset: 10 }}
            />
            <YAxis
              yAxisId="dxy"
              orientation="right"
              stroke="#60a5fa"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              domain={['dataMin - 1', 'dataMax + 1']}
              label={{ value: 'DXY', angle: 90, position: 'insideRight', style: { fill: '#60a5fa', fontSize: 9, fontWeight: 700 }, offset: 10 }}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
              labelStyle={{ color: '#71717a', fontSize: '10px' }}
              formatter={(value: number, name: string) => {
                if (name === 'goldPrice') return [`$${value.toLocaleString()}`, 'Gold'];
                return [value.toFixed(1), 'DXY'];
              }}
            />
            <Area
              yAxisId="gold"
              type="monotone"
              dataKey="goldPrice"
              stroke="#F39C12"
              strokeWidth={2}
              fill="url(#gradGoldDxy)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: '#F39C12' }}
              connectNulls
            />
            <Line
              yAxisId="dxy"
              type="monotone"
              dataKey="dxy"
              stroke="#60a5fa"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: '#60a5fa' }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-4 mt-3 text-[10px] font-bold uppercase text-zinc-500">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 bg-gold-500 rounded-full" />
          <span>Gold Price</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 bg-blue-400 rounded-full" />
          <span>US Dollar Index (DXY)</span>
        </div>
      </div>
    </div>
  );
}
