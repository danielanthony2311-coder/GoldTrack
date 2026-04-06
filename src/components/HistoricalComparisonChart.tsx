import React, { useState, useMemo, useEffect } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell
} from 'recharts';
import { ChevronDown } from 'lucide-react';
import { cn } from '../utils/cn';

const HISTORICAL_DATA: any = {
  "averages": {
    "Jan": 11663, "Feb": 25759, "Mar": 12015, "Apr": 11088, "May": 17535,
    "Jun": 8663, "Jul": 10838, "Aug": 12950, "Sep": 12225, "Oct": 12525,
    "Nov": 13650, "Dec": 16550
  },
  "years": {
    "2021": { "Jan": 4600, "Feb": 4100, "Mar": 4750, "Apr": 4050, "May": 3800, "Jun": 4300, "Jul": 3900, "Aug": 4550, "Sep": 4250, "Oct": 4150, "Nov": 4450, "Dec": 5000 },
    "2022": { "Jan": 4550, "Feb": 4250, "Mar": 4850, "Apr": 4150, "May": 4000, "Jun": 4450, "Jul": 4050, "Aug": 4650, "Sep": 4350, "Oct": 4250, "Nov": 4550, "Dec": 5200 },
    "2024": { "Jan": 13500, "Feb": 18118, "Mar": 15360, "Apr": 14350, "May": 37050, "Jun": 4400, "Jul": 12000, "Aug": 18400, "Sep": 16500, "Oct": 17200, "Nov": 19500, "Dec": 25000 },
    "2025": {
      "Jan": 24000,
      "Feb": 76567,
      "Mar": 23100, "Apr": 21800, "May": 25291, "Jun": 21500, "Jul": 23400, "Aug": 24200, "Sep": 23800, "Oct": 24500, "Nov": 26100, "Dec": 37098
    },
    "2026": { "Jan": 11862, "Feb": 40711, "Mar": 14559, "Apr": null, "May": null, "Jun": null, "Jul": null, "Aug": null, "Sep": null, "Oct": null, "Nov": null, "Dec": null }
  }
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ALL_TIME_HIGH = 76567;

// Active COMEX gold delivery months (traditionally even months — Feb, Apr, Jun, Aug, Oct, Dec)
// But data shows Feb, May, Dec as the real heavy hitters
const ACTIVE_DELIVERY_MONTHS = new Set(["Feb", "Apr", "Jun", "Aug", "Oct", "Dec"]);
const PEAK_MONTHS = new Set(["Feb", "Dec"]); // Historically highest volume

const CustomTooltip = ({ active, payload, label, year }: any) => {
  if (active && payload && payload.length) {
    const yearData = payload.find((p: any) => p.dataKey === 'yearValue');
    const avgData = payload.find((p: any) => p.dataKey === 'averageValue');
    
    const yearVal = yearData?.value;
    const avgVal = avgData?.value;
    
    if (yearVal === undefined || yearVal === null) return null;
    if (avgVal === undefined || avgVal === null) return null;

    const diffPercent = (((yearVal - avgVal) / avgVal) * 100).toFixed(0);
    const isAbove = yearVal > avgVal;
    const isNearRecord = yearVal >= ALL_TIME_HIGH * 0.95;

    const isActive = ACTIVE_DELIVERY_MONTHS.has(label);
    const isPeak = PEAK_MONTHS.has(label);

    return (
      <div className="bg-[#121212] border border-[#333] p-3 rounded-lg shadow-xl min-w-[200px]">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <p className="text-zinc-400 text-xs font-bold uppercase tracking-wider">{label} {year}</p>
            {isPeak && (
              <span className="bg-gold-500/20 text-gold-500 text-[8px] font-black px-1.5 py-0.5 rounded uppercase">
                Peak Month
              </span>
            )}
            {isActive && !isPeak && (
              <span className="bg-zinc-700/50 text-zinc-400 text-[8px] font-black px-1.5 py-0.5 rounded uppercase">
                Active
              </span>
            )}
          </div>
          {isNearRecord && (
            <span className="bg-rose-500 text-white text-[8px] font-black px-1.5 py-0.5 rounded uppercase animate-pulse">
              Near Record
            </span>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-gold-500 font-black text-sm">
            {year}: {yearVal.toLocaleString()} contracts
          </p>
          <p className="text-[#4B5563] font-bold text-xs">
            5Y Avg: {avgVal.toLocaleString()}
          </p>
          <div className={cn(
            "mt-2 pt-2 border-t border-[#333] text-[10px] font-black uppercase flex items-center justify-between",
            isAbove ? "text-emerald-500" : "text-rose-500"
          )}>
            <span>{isAbove ? '+' : ''}{diffPercent}% {isAbove ? 'above' : 'below'} average</span>
          </div>
        </div>
      </div>
    );
  }
  return null;
};

export default function HistoricalComparisonChart() {
  const [selectedYear, setSelectedYear] = useState('2026');
  const [liveMtd, setLiveMtd] = useState<Record<string, number>>({});

  // Fetch live YTD + MTD data from the API
  useEffect(() => {
    const controller = new AbortController();
    const YTD_MONTH_MAP: Record<string, string> = {
      PREV_DEC: "Dec", JAN: "Jan", FEB: "Feb", MAR: "Mar", APR: "Apr",
      MAY: "May", JUN: "Jun", JUL: "Jul", AUG: "Aug", SEP: "Sep", OCT: "Oct", NOV: "Nov", DEC: "Dec"
    };

    // Try YTD first (has full monthly breakdown), fall back to MTD for current month
    Promise.all([
      fetch('/api/cme/summary?metal=GOLD&type=YTD', { signal: controller.signal }).then(r => r.ok ? r.json() : []),
      fetch('/api/cme/summary?metal=GOLD&type=MTD', { signal: controller.signal }).then(r => r.ok ? r.json() : [])
    ]).then(([ytdRows, mtdRows]: [any[], any[]]) => {
      const byMonth: Record<string, number> = {};

      // YTD data: get the latest row's ytd_by_month
      const sortedYtd = ytdRows.sort((a: any, b: any) => b.date.localeCompare(a.date));
      if (sortedYtd.length > 0 && sortedYtd[0].ytd_json) {
        try {
          const ytdMonths = JSON.parse(sortedYtd[0].ytd_json);
          for (const [key, val] of Object.entries(ytdMonths)) {
            const monthName = YTD_MONTH_MAP[key];
            if (monthName && key !== "PREV_DEC") {
              byMonth[monthName] = val as number;
            }
          }
        } catch {}
      }

      // MTD data: get current month's latest cumulative (fills in live data)
      for (const row of mtdRows) {
        const d = new Date(row.date);
        const monthKey = MONTH_NAMES[d.getUTCMonth()];
        const val = Number(row.mtd) || 0;
        if (val > (byMonth[monthKey] || 0)) {
          byMonth[monthKey] = val;
        }
      }

      setLiveMtd(byMonth);
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  const chartData = useMemo(() => {
    // Merge live MTD into 2026 data
    const yearData = { ...HISTORICAL_DATA.years[selectedYear] };
    if (selectedYear === '2026') {
      for (const [month, val] of Object.entries(liveMtd)) {
        if (val && (yearData[month] === null || yearData[month] === undefined)) {
          yearData[month] = val;
        }
      }
    }

    return MONTH_NAMES
      .map(month => ({
        name: month,
        yearValue: yearData[month],
        averageValue: HISTORICAL_DATA.averages[month],
        isActiveDelivery: ACTIVE_DELIVERY_MONTHS.has(month),
        isPeak: PEAK_MONTHS.has(month)
      }))
      .filter(item => item.yearValue !== null && item.yearValue !== undefined && item.yearValue !== 0);
  }, [selectedYear, liveMtd]);

  const CustomXTick = ({ x, y, payload }: any) => {
    const month = payload.value;
    const isActive = ACTIVE_DELIVERY_MONTHS.has(month);
    const isPeak = PEAK_MONTHS.has(month);
    return (
      <g transform={`translate(${x},${y})`}>
        <text
          dy={16}
          textAnchor="middle"
          fill={isPeak ? '#F39C12' : isActive ? '#9CA3AF' : '#555'}
          fontSize={11}
          fontFamily="JetBrains Mono"
          fontWeight={isActive ? 700 : 400}
        >
          {month}
        </text>
        {isActive && (
          <circle cx={0} cy={28} r={2.5} fill={isPeak ? '#F39C12' : '#6B7280'} />
        )}
      </g>
    );
  };

  return (
    <div className="glass-card p-6 bg-[#121212] border-[#333] rounded-2xl w-full">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h3 className="text-xl font-black text-zinc-100 tracking-tight">COMEX Delivery Comparison</h3>
          <p className="text-zinc-500 text-xs font-medium uppercase tracking-widest mt-1">Historical vs. 5Y Average</p>
        </div>

        <div className="relative group">
          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(e.target.value)}
            className="appearance-none bg-zinc-900 border border-[#333] text-zinc-100 text-sm font-bold py-2 pl-4 pr-10 rounded-lg focus:outline-none focus:border-gold-500 transition-colors cursor-pointer"
          >
            {Object.keys(HISTORICAL_DATA.years).sort().reverse().map(year => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none group-hover:text-zinc-300 transition-colors" />
        </div>
      </div>

      <div className="h-[400px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            barGap={8}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
            <XAxis
              dataKey="name"
              stroke="#444"
              tickLine={false}
              axisLine={false}
              tick={<CustomXTick />}
              height={45}
            />
            <YAxis 
              stroke="#444" 
              fontSize={10} 
              tickLine={false} 
              axisLine={false}
              tickFormatter={(value) => `${value / 1000}k`}
              fontFamily="JetBrains Mono"
              domain={[0, 'auto']}
            />
            <Tooltip 
              content={<CustomTooltip year={selectedYear} />}
              cursor={{ fill: 'rgba(255,255,255,0.03)' }}
            />
            <Legend 
              verticalAlign="top" 
              align="right" 
              iconType="circle"
              wrapperStyle={{ paddingBottom: '20px', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}
            />
            <Bar 
              name={`${selectedYear} Deliveries`} 
              dataKey="yearValue" 
              fill="#F39C12" 
              radius={[4, 4, 0, 0]} 
              barSize={24}
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.yearValue === null ? 'transparent' : '#F39C12'} />
              ))}
            </Bar>
            <Bar 
              name="5Y Average" 
              dataKey="averageValue" 
              fill="#4B5563" 
              radius={[4, 4, 0, 0]} 
              barSize={24}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Delivery Month Legend */}
      <div className="mt-4 flex items-center gap-6 px-2">
        <div className="flex items-center gap-2">
          <circle className="inline-block w-2 h-2 rounded-full bg-gold-500" />
          <div className="w-2 h-2 rounded-full bg-gold-500" />
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Peak Delivery Month (Feb, Dec)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-zinc-500" />
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Active Delivery Month (Even months)</span>
        </div>
      </div>

      <div className="mt-4 p-4 bg-zinc-900/50 rounded-xl border border-[#222]">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1 h-4 bg-gold-500 rounded-full" />
          <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Market Insight</span>
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed font-medium">
          COMEX gold active delivery months are Feb, Apr, Jun, Aug, Oct, Dec (dots below axis).
          Feb and Dec historically see the heaviest volume. Odd months (Jan, Mar, May, Jul, Sep, Nov) typically see lower delivery activity, though the 2024-2025 physical squeeze elevated all months.
          {selectedYear === '2026' ? ' Feb 2026 saw 40,711 contracts — the second-highest on record behind Feb 2025 (76,567).' : ''}
          {selectedYear === '2025' ? ' February 2025 set an all-time record of 76,567 contracts. December closed at 37,098.' : ''}
          {selectedYear === '2024' ? ' May 2024 (37,050) broke the even-month pattern, signaling the start of the physical squeeze.' : ''}
          {['2021', '2022'].includes(selectedYear) ? ' During 2021-2022, delivery volumes were uniformly low across all months.' : ''}
        </p>
      </div>
    </div>
  );
}
