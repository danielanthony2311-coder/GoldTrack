import { useState, useEffect } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Loader2, Info, Scale } from 'lucide-react';
import { cn } from '../utils/cn';
import GoldVsDxy from '../components/GoldVsDxy';

type RatioDay = {
  date: string;
  goldPrice: number;
  silverPrice: number;
  ratio: number;
};

export default function Positioning() {
  const [ratioData, setRatioData] = useState<RatioDay[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [goldRes, silverRes] = await Promise.all([
          fetch('/api/prices/latest?metal=GOLD', { signal: controller.signal }),
          fetch('/api/prices/latest?metal=SILVER', { signal: controller.signal }),
        ]);
        if (!goldRes.ok || !silverRes.ok) return;

        const goldJson = await goldRes.json();
        const silverJson = await silverRes.json();
        const goldPrices: any[] = goldJson?.prices ?? [];
        const silverPrices: any[] = silverJson?.prices ?? [];

        const silverMap = new Map(silverPrices.map((p: any) => [p.date, p.close]));

        const merged: RatioDay[] = [];
        for (const gp of goldPrices) {
          const sp = silverMap.get(gp.date);
          if (sp && sp > 0) {
            merged.push({
              date: gp.date,
              goldPrice: gp.close,
              silverPrice: sp,
              ratio: Number((gp.close / sp).toFixed(1)),
            });
          }
        }

        setRatioData(merged.reverse());
      } catch (e: any) {
        if (e.name !== 'AbortError') console.error(e);
      } finally {
        setLoading(false);
      }
    };
    load();
    return () => controller.abort();
  }, []);

  const latest = ratioData.length > 0 ? ratioData[ratioData.length - 1] : null;
  const avg = ratioData.length > 0 ? ratioData.reduce((s, d) => s + d.ratio, 0) / ratioData.length : 0;

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-1">Positioning & Ratios</h1>
        <p className="text-sm text-zinc-500">Key ratios and positioning data for gold and silver markets.</p>
      </div>

      {/* Gold/Silver Ratio */}
      <div className="glass-card p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <Scale className="w-5 h-5 text-gold-500" />
              <h3 className="font-semibold text-lg">Gold / Silver Ratio</h3>
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              Ounces of silver needed to buy one ounce of gold — historical average ~65
            </p>
          </div>
          <div className="group relative">
            <Info className="w-4 h-4 text-zinc-600 cursor-help" />
            <div className="absolute top-full right-0 mt-2 w-64 p-3 bg-zinc-900 border border-zinc-700 rounded-lg text-[11px] text-zinc-400 leading-relaxed opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
              When the ratio is high (&gt;80), silver is historically cheap vs gold. Mean-reversion traders overweight silver expecting it to catch up. Extremely high ratios (&gt;100) often coincide with crisis periods.
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 text-gold-500 animate-spin" />
          </div>
        ) : ratioData.length < 3 ? (
          <p className="text-sm text-zinc-500 py-8 text-center">
            Need both gold and silver price data — sync both metals to see the ratio.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
                <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Current</p>
                <p className={cn(
                  "text-2xl font-black",
                  latest && latest.ratio > 80 ? "text-gold-500" : "text-zinc-100"
                )}>
                  {latest?.ratio ?? '—'}
                </p>
                <p className="text-[10px] text-zinc-600">oz Ag per oz Au</p>
              </div>
              <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
                <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Period Avg</p>
                <p className="text-2xl font-black text-zinc-100">{avg.toFixed(1)}</p>
                <p className="text-[10px] text-zinc-600">{ratioData.length} days</p>
              </div>
              <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
                <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Vs Average</p>
                <p className={cn(
                  "text-2xl font-black",
                  latest && latest.ratio > avg ? "text-gold-500" : "text-zinc-400"
                )}>
                  {latest ? (latest.ratio > avg ? 'Silver Cheap' : 'Silver Rich') : '—'}
                </p>
                <p className="text-[10px] text-zinc-600">relative value</p>
              </div>
            </div>

            <div className="h-[250px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={ratioData}>
                  <defs>
                    <linearGradient id="gradRatio" x1="0" y1="0" x2="0" y2="1">
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
                    interval={Math.max(Math.floor(ratioData.length / 6), 0)}
                    tickFormatter={(val) => new Date(val).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  />
                  <YAxis
                    stroke="#71717a"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    domain={['dataMin - 3', 'dataMax + 3']}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                    labelStyle={{ color: '#71717a', fontSize: '10px' }}
                    formatter={(value: number) => [value.toFixed(1), 'Au/Ag Ratio']}
                  />
                  <ReferenceLine y={65} stroke="#52525b" strokeDasharray="4 4" strokeWidth={1} label={{ value: 'Hist. Avg (65)', position: 'right', style: { fill: '#52525b', fontSize: 9 } }} />
                  <Area
                    type="monotone"
                    dataKey="ratio"
                    stroke="#F39C12"
                    strokeWidth={2}
                    fill="url(#gradRatio)"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0, fill: '#F39C12' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>

      {/* Gold vs DXY */}
      <GoldVsDxy />

      {/* COT Placeholder */}
      <div className="glass-card p-6">
        <h3 className="font-semibold text-lg mb-2">COT Positioning</h3>
        <p className="text-sm text-zinc-500">
          Commitment of Traders data (CFTC weekly report) — coming soon. Will show commercial, managed money, and small spec net positioning.
        </p>
      </div>
    </div>
  );
}
