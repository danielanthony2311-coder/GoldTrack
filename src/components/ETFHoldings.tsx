import { useState, useEffect } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { ArrowUpRight, ArrowDownRight, Minus, Loader2, Info, TrendingUp } from 'lucide-react';
import { cn } from '../utils/cn';

type Fund = {
  ticker: string;
  name: string;
  date: string;
  tonnes: number;
  changeTonnes: number | null;
  oz: number;
};

type HistoryRow = {
  ticker: string;
  date: string;
  tonnes: number;
  change: number | null;
};

type ETFData = {
  funds: Fund[];
  totalTonnes: number;
  totalOz: number;
  history: HistoryRow[];
};

const FUND_COLORS: Record<string, string> = {
  GLD: '#F39C12',
  IAU: '#3B82F6',
  SGOL: '#8B5CF6',
};

export default function ETFHoldings() {
  const [data, setData] = useState<ETFData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/etf/holdings', { signal: controller.signal })
      .then(r => r.json())
      .then(json => setData(json))
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

  if (!data || data.funds.length === 0) {
    return (
      <div className="glass-card p-6">
        <h3 className="font-semibold text-lg mb-2">ETF Gold Holdings</h3>
        <p className="text-sm text-zinc-500">No ETF data — click Sync All to fetch.</p>
      </div>
    );
  }

  // Build combined chart data
  const dateMap: Record<string, Record<string, number>> = {};
  for (const row of data.history) {
    if (!dateMap[row.date]) dateMap[row.date] = {};
    dateMap[row.date][row.ticker] = row.tonnes;
  }
  const chartData = Object.entries(dateMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tickers]) => ({ date, ...tickers }));

  const totalChange = data.funds.reduce((s, f) => s + (f.changeTonnes ?? 0), 0);
  const isUp = totalChange > 0;
  const isDown = totalChange < 0;

  return (
    <div className="glass-card p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-gold-500" />
            <h3 className="font-semibold text-lg">ETF Gold Holdings</h3>
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            Physical gold held by major ETFs — {data.totalTonnes.toLocaleString()} tonnes total
          </p>
        </div>
        <div className="group relative">
          <Info className="w-4 h-4 text-zinc-600 cursor-help" />
          <div className="absolute top-full right-0 mt-2 w-64 p-3 bg-zinc-900 border border-zinc-700 rounded-lg text-[11px] text-zinc-400 leading-relaxed opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
            Gold ETFs hold physical bullion in vaults on behalf of shareholders. Inflows signal institutional demand; outflows signal selling pressure. GLD alone holds ~970 tonnes.
          </div>
        </div>
      </div>

      {/* Fund cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {data.funds.map(fund => (
          <div key={fund.ticker} className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: FUND_COLORS[fund.ticker] ?? '#71717a' }} />
                <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">{fund.ticker}</span>
              </div>
              <span className="text-[10px] text-zinc-600">{fund.date}</span>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-xl font-black text-zinc-100">{fund.tonnes.toLocaleString(undefined, { maximumFractionDigits: 1 })}t</span>
              {fund.changeTonnes != null && (
                <span className={cn(
                  "flex items-center gap-0.5 text-xs font-bold pb-0.5",
                  fund.changeTonnes > 0 ? "text-emerald-400" : fund.changeTonnes < 0 ? "text-rose-400" : "text-zinc-500"
                )}>
                  {fund.changeTonnes > 0 ? <ArrowUpRight className="w-3 h-3" /> : fund.changeTonnes < 0 ? <ArrowDownRight className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                  {fund.changeTonnes > 0 ? '+' : ''}{fund.changeTonnes.toFixed(1)}t
                </span>
              )}
            </div>
            <p className="text-[10px] text-zinc-600 mt-1">{fund.name}</p>
          </div>
        ))}
      </div>

      {/* Combined trend chart */}
      {chartData.length > 2 && (
        <div className="h-[200px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                {Object.entries(FUND_COLORS).map(([ticker, color]) => (
                  <linearGradient key={ticker} id={`gradETF_${ticker}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="date"
                stroke="#71717a"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                interval={Math.max(Math.floor(chartData.length / 6), 0)}
              />
              <YAxis
                stroke="#71717a"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => `${v}t`}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                labelStyle={{ color: '#71717a', fontSize: '10px' }}
                formatter={(value: number, name: string) => [`${value.toLocaleString()} tonnes`, name]}
              />
              {Object.entries(FUND_COLORS).map(([ticker, color]) => (
                <Area
                  key={ticker}
                  type="monotone"
                  dataKey={ticker}
                  stroke={color}
                  strokeWidth={2}
                  fill={`url(#gradETF_${ticker})`}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0, fill: color }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Net flow indicator */}
      <div className={cn(
        "mt-4 p-3 rounded-lg border",
        isUp ? "bg-emerald-500/5 border-emerald-500/20" : isDown ? "bg-rose-500/5 border-rose-500/20" : "bg-zinc-500/5 border-zinc-500/20"
      )}>
        <p className={cn(
          "text-xs font-medium",
          isUp ? "text-emerald-400" : isDown ? "text-rose-400" : "text-zinc-400"
        )}>
          {isUp
            ? `Net inflow: +${totalChange.toFixed(1)} tonnes last month. Institutional demand rising.`
            : isDown
            ? `Net outflow: ${totalChange.toFixed(1)} tonnes last month. Selling pressure visible.`
            : 'Flat month-over-month. Watch for direction.'}
        </p>
      </div>
    </div>
  );
}
