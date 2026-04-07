import React, { useEffect, useState, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Cell, AreaChart, Area
} from 'recharts';
import { Globe, TrendingUp, TrendingDown, RefreshCw, Loader2, Info, ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';
import { cn } from '../utils/cn';

const FLAGS: Record<string, string> = {
  US: '\u{1F1FA}\u{1F1F8}', DE: '\u{1F1E9}\u{1F1EA}', IT: '\u{1F1EE}\u{1F1F9}', FR: '\u{1F1EB}\u{1F1F7}',
  RU: '\u{1F1F7}\u{1F1FA}', CN: '\u{1F1E8}\u{1F1F3}', JP: '\u{1F1EF}\u{1F1F5}', IN: '\u{1F1EE}\u{1F1F3}',
  CH: '\u{1F1E8}\u{1F1ED}', PL: '\u{1F1F5}\u{1F1F1}', GB: '\u{1F1EC}\u{1F1E7}', TR: '\u{1F1F9}\u{1F1F7}',
  KZ: '\u{1F1F0}\u{1F1FF}', UZ: '\u{1F1FA}\u{1F1FF}', TH: '\u{1F1F9}\u{1F1ED}', SG: '\u{1F1F8}\u{1F1EC}',
  CZ: '\u{1F1E8}\u{1F1FF}', HU: '\u{1F1ED}\u{1F1FA}', QA: '\u{1F1F6}\u{1F1E6}', SA: '\u{1F1F8}\u{1F1E6}',
  AE: '\u{1F1E6}\u{1F1EA}', AU: '\u{1F1E6}\u{1F1FA}', PT: '\u{1F1F5}\u{1F1F9}', ES: '\u{1F1EA}\u{1F1F8}',
  NL: '\u{1F1F3}\u{1F1F1}', SE: '\u{1F1F8}\u{1F1EA}', AT: '\u{1F1E6}\u{1F1F9}', BE: '\u{1F1E7}\u{1F1EA}',
  PH: '\u{1F1F5}\u{1F1ED}', EG: '\u{1F1EA}\u{1F1EC}', IQ: '\u{1F1EE}\u{1F1F6}', LY: '\u{1F1F1}\u{1F1FE}',
};

// Central bank name for each country code
const CB_NAMES: Record<string, string> = {
  US: 'Federal Reserve', DE: 'Deutsche Bundesbank', IT: 'Banca d\'Italia', FR: 'Banque de France',
  RU: 'Bank of Russia', CN: 'People\'s Bank of China (PBOC)', JP: 'Bank of Japan',
  IN: 'Reserve Bank of India (RBI)', CH: 'Swiss National Bank', PL: 'National Bank of Poland (NBP)',
  GB: 'Bank of England', TR: 'Central Bank of Turkey (CBRT)', KZ: 'National Bank of Kazakhstan',
  UZ: 'Central Bank of Uzbekistan', TH: 'Bank of Thailand', SG: 'Monetary Authority of Singapore (MAS)',
  CZ: 'Czech National Bank', HU: 'Magyar Nemzeti Bank', QA: 'Qatar Central Bank',
  SA: 'Saudi Central Bank (SAMA)', AE: 'Central Bank of the UAE', AU: 'Reserve Bank of Australia',
  PT: 'Banco de Portugal', ES: 'Banco de España', NL: 'De Nederlandsche Bank',
  SE: 'Sveriges Riksbank', AT: 'Oesterreichische Nationalbank', BE: 'National Bank of Belgium',
  PH: 'Bangko Sentral ng Pilipinas', EG: 'Central Bank of Egypt', IQ: 'Central Bank of Iraq',
  LY: 'Central Bank of Libya',
};

// Shorten country names for chart axis
const SHORT_NAMES: Record<string, string> = {
  'United States': 'United States',
  'Russian Federation': 'Russia',
  'United Kingdom': 'UK',
  'United Arab Emirates': 'UAE',
  'Czech Republic': 'Czech Rep.',
  'Saudi Arabia': 'Saudi Arabia',
};

interface ReserveRow {
  country_code: string;
  country_name: string;
  period: string;
  tonnes: number;
  change_tonnes: number;
}

// Format period: "2024-03" → "Mar 2024", "2024" → "2024"
function formatPeriod(p: string): string {
  if (p.length === 4) return p;
  const [year, month] = p.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(month)] || month} ${year}`;
}

// Short format for chart X axis: "2024-03" → "Mar'24", "2024" → "'24"
function shortPeriod(p: string): string {
  if (p.length === 4) return `'${p.slice(2)}`;
  const [year, month] = p.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(month)] || month}'${year.slice(2)}`;
}

export default function CBTracker() {
  const [data, setData] = useState<Record<string, ReserveRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/cb/reserves');
      if (res.ok) {
        const json = await res.json();
        setData(json.periods || {});
      }
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch('/api/cb/sync');
      const json = await res.json();
      setSyncMsg(json.message || `Synced ${json.recordsInserted} records`);
      await fetchData();
    } catch (e: any) {
      setSyncMsg('Sync failed: ' + e.message);
    }
    setSyncing(false);
  };

  // Sort periods chronologically
  const periods = useMemo(() => Object.keys(data).sort(), [data]);
  const periodsDesc = useMemo(() => [...periods].reverse(), [periods]);
  const latestPeriod = periodsDesc[0] || '';

  // Separate monthly vs annual periods
  const monthlyPeriods = useMemo(() => periods.filter(p => p.includes('-')), [periods]);
  const hasMonthlyData = monthlyPeriods.length > 0;

  // Latest snapshot — countries sorted by tonnes, using the most recent period per country
  const latestSnapshot = useMemo(() => {
    // For each country, find their most recent data point
    const countryLatest: Record<string, ReserveRow> = {};
    for (const period of periodsDesc) {
      const rows = data[period] || [];
      for (const row of rows) {
        if (!countryLatest[row.country_code]) {
          countryLatest[row.country_code] = row;
        }
      }
    }
    return Object.values(countryLatest).sort((a, b) => Number(b.tonnes) - Number(a.tonnes));
  }, [data, periodsDesc]);

  // Global total
  const globalTotal = useMemo(() => {
    return latestSnapshot.reduce((s, r) => s + Number(r.tonnes), 0);
  }, [latestSnapshot]);

  // Monthly buying chart — aggregate net change per month across all countries
  const monthlyBuyingData = useMemo(() => {
    if (!hasMonthlyData) return [];
    return monthlyPeriods.map(period => {
      const rows = data[period] || [];
      let totalBuying = 0;
      let totalSelling = 0;
      let buyerCount = 0;
      let sellerCount = 0;
      for (const r of rows) {
        const change = Number(r.change_tonnes);
        if (change > 0.1) { totalBuying += change; buyerCount++; }
        if (change < -0.1) { totalSelling += Math.abs(change); sellerCount++; }
      }
      return { period, label: shortPeriod(period), buying: Math.round(totalBuying * 10) / 10, selling: Math.round(totalSelling * 10) / 10, net: Math.round((totalBuying - totalSelling) * 10) / 10, buyerCount, sellerCount };
    });
  }, [data, monthlyPeriods, hasMonthlyData]);

  // Biggest movers — last month-over-month change
  const biggestMovers = useMemo(() => {
    // Get the latest period that has change data
    const recentPeriod = periodsDesc.find(p => {
      const rows = data[p] || [];
      return rows.some(r => Number(r.change_tonnes) !== 0);
    });
    if (!recentPeriod) return [];
    return [...(data[recentPeriod] || [])]
      .filter(r => Number(r.change_tonnes) !== 0)
      .sort((a, b) => Math.abs(Number(b.change_tonnes)) - Math.abs(Number(a.change_tonnes)))
      .slice(0, 10);
  }, [data, periodsDesc]);

  // Historical data for selected country — all periods
  const countryHistory = useMemo(() => {
    if (!selectedCountry) return [];
    const history: { period: string; label: string; tonnes: number; change: number }[] = [];
    for (const period of periods) {
      const row = data[period]?.find(r => r.country_code === selectedCountry);
      if (row) {
        history.push({
          period,
          label: shortPeriod(period),
          tonnes: Number(row.tonnes),
          change: Number(row.change_tonnes)
        });
      }
    }
    return history;
  }, [selectedCountry, data, periods]);

  // Accumulation streaks — consecutive months/periods of buying
  const whaleStreaks = useMemo(() => {
    const results: { name: string; code: string; streak: number; totalAdded: number; unit: string }[] = [];
    const checkPeriods = hasMonthlyData ? [...monthlyPeriods].reverse() : [...periodsDesc];

    for (const row of latestSnapshot) {
      let streak = 0;
      let totalAdded = 0;
      for (const period of checkPeriods) {
        const r = data[period]?.find(d => d.country_code === row.country_code);
        if (r && Number(r.change_tonnes) > 0.1) {
          streak++;
          totalAdded += Number(r.change_tonnes);
        } else if (r) {
          break;
        }
      }
      if (streak >= 3) {
        results.push({
          name: row.country_name,
          code: row.country_code,
          streak,
          totalAdded: Math.round(totalAdded * 10) / 10,
          unit: hasMonthlyData ? 'months' : 'years'
        });
      }
    }
    return results.sort((a, b) => b.totalAdded - a.totalAdded).slice(0, 6);
  }, [data, periodsDesc, monthlyPeriods, latestSnapshot, hasMonthlyData]);

  const hasData = latestSnapshot.length > 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Central Bank Gold Tracker</h1>
          <p className="text-zinc-400">Which countries are buying and selling gold — tracked by their central banks' official reserve changes.</p>
        </div>
        <div className="flex items-center gap-4">
          {hasData && (
            <div className="glass-card px-4 py-2 border-gold-500/20 bg-gold-500/5">
              <span className="text-[10px] text-zinc-500 uppercase font-bold block mb-1">Tracked Total</span>
              <span className="text-xl font-black text-gold-500">{Math.round(globalTotal).toLocaleString()}t</span>
            </div>
          )}
          <button
            onClick={handleSync}
            disabled={syncing}
            className={cn(
              "flex items-center gap-2 px-4 py-2 bg-gold-500 text-black font-bold rounded-lg hover:bg-gold-400 transition-all",
              syncing && "opacity-50 cursor-not-allowed"
            )}
          >
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {syncing ? 'Syncing...' : 'Sync Data'}
          </button>
        </div>
      </div>

      {syncMsg && (
        <div className={cn(
          "p-3 rounded-lg text-sm font-medium",
          syncMsg.includes('fail') ? "bg-rose-500/10 text-rose-400 border border-rose-500/20" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
        )}>
          {syncMsg}
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-gold-500" />
        </div>
      )}

      {!loading && !hasData && (
        <div className="glass-card p-12 text-center">
          <Globe className="w-16 h-16 text-zinc-700 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-zinc-400 mb-2">No Reserve Data Yet</h3>
          <p className="text-zinc-600 text-sm mb-6">Click "Sync Data" to load official gold reserve data from IMF / World Gold Council sources.</p>
        </div>
      )}

      {hasData && (
        <>
          {/* Monthly Net Buying Chart */}
          {monthlyBuyingData.length > 0 && (
            <div className="glass-card p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-bold text-lg">Global Central Bank Buying</h3>
                  <p className="text-xs text-zinc-500 uppercase tracking-widest mt-1">Monthly net gold purchases across all tracked countries (tonnes)</p>
                </div>
                <div className="flex items-center gap-4 text-[10px] font-bold uppercase text-zinc-500">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-2 rounded-sm bg-emerald-500" />
                    <span>Buying</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-2 rounded-sm bg-rose-500/60" />
                    <span>Selling</span>
                  </div>
                </div>
              </div>
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyBuyingData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                    <XAxis dataKey="label" stroke="#555" fontSize={9} tickLine={false} axisLine={false} interval={2} />
                    <YAxis stroke="#555" fontSize={10} tickLine={false} axisLine={false} tickFormatter={v => `${v}t`} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (active && payload && payload.length) {
                          const d = payload[0]?.payload;
                          return (
                            <div className="bg-[#121212] border border-[#333] p-3 rounded-lg shadow-xl">
                              <p className="text-zinc-400 text-xs font-bold uppercase mb-2">{formatPeriod(d.period)}</p>
                              <p className="text-emerald-400 font-bold text-xs">+{d.buying}t bought ({d.buyerCount} countries)</p>
                              {d.selling > 0 && <p className="text-rose-400 font-bold text-xs">-{d.selling}t sold ({d.sellerCount} countries)</p>}
                              <p className={cn("text-sm font-black mt-1", d.net > 0 ? "text-emerald-400" : "text-rose-400")}>
                                Net: {d.net > 0 ? '+' : ''}{d.net}t
                              </p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Bar dataKey="buying" fill="#10b981" radius={[3, 3, 0, 0]} barSize={14} />
                    <Bar dataKey="selling" fill="#ef444480" radius={[3, 3, 0, 0]} barSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Top Section: Leaderboard + Whale Tracker */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Leaderboard Chart */}
            <div className="lg:col-span-2 glass-card p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-bold text-lg">Global Leaderboard: Official Gold Reserves</h3>
                  <p className="text-xs text-zinc-500 uppercase tracking-widest mt-1">
                    Top 15 Holders (Tonnes) — Latest Available Data
                  </p>
                </div>
              </div>
              <div className="h-[460px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={latestSnapshot.slice(0, 15).map(r => ({
                      ...r,
                      displayName: SHORT_NAMES[r.country_name] || r.country_name,
                    }))}
                    layout="vertical"
                    margin={{ left: 20, right: 40 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={false} />
                    <XAxis type="number" hide />
                    <YAxis
                      dataKey="displayName"
                      type="category"
                      stroke="#71717a"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      width={150}
                      tick={({ x, y, payload }: any) => {
                        const row = latestSnapshot.find(r => (SHORT_NAMES[r.country_name] || r.country_name) === payload.value);
                        const code = row?.country_code || '';
                        const flag = FLAGS[code] || '';
                        return (
                          <g transform={`translate(${x},${y})`}>
                            <text x={-8} y={0} dy={4} textAnchor="end" fill="#a1a1aa" fontSize={11} fontWeight={600}>
                              {flag} {payload.value}
                            </text>
                          </g>
                        );
                      }}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(212, 175, 55, 0.05)' }}
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const d = payload[0].payload as ReserveRow & { displayName: string };
                          const change = Number(d.change_tonnes);
                          const cbName = CB_NAMES[d.country_code];
                          return (
                            <div className="bg-[#121212] border border-[#333] p-3 rounded-lg shadow-xl min-w-[220px]">
                              <p className="text-zinc-400 text-xs font-bold uppercase mb-1">
                                {FLAGS[d.country_code] || ''} {d.country_name}
                              </p>
                              {cbName && <p className="text-zinc-600 text-[10px] mb-2">{cbName}</p>}
                              <p className="text-gold-500 font-black text-sm">{Number(d.tonnes).toLocaleString(undefined, { maximumFractionDigits: 1 })} tonnes</p>
                              {change !== 0 && (
                                <p className={cn("text-[10px] font-bold mt-1", change > 0 ? "text-emerald-400" : "text-rose-400")}>
                                  {change > 0 ? '+' : ''}{change.toFixed(1)}t vs previous period
                                </p>
                              )}
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Bar dataKey="tonnes" radius={[0, 4, 4, 0]} barSize={22}>
                      {latestSnapshot.slice(0, 15).map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={Number(entry.change_tonnes) > 5 ? '#F39C12' : Number(entry.change_tonnes) > 0 ? '#a37714' : '#3f3f46'}
                          className="cursor-pointer"
                          onClick={() => setSelectedCountry(entry.country_code)}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 flex items-center gap-6 px-2 text-[10px] font-bold uppercase text-zinc-500">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-2 rounded-sm bg-[#F39C12]" />
                  <span>Actively Buying</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-2 rounded-sm bg-[#a37714]" />
                  <span>Modest Buyer</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-2 rounded-sm bg-[#3f3f46]" />
                  <span>Flat / Selling</span>
                </div>
              </div>
            </div>

            {/* Whale Tracker + Biggest Movers */}
            <div className="space-y-6">
              {/* Accumulation Streaks */}
              <div className="glass-card p-6">
                <h3 className="font-bold text-lg mb-1">Buying Streaks</h3>
                <p className="text-[10px] text-zinc-500 uppercase tracking-widest mb-4">
                  Consecutive {hasMonthlyData ? 'months' : 'years'} of net buying
                </p>
                <div className="space-y-4">
                  {whaleStreaks.length === 0 && (
                    <p className="text-zinc-600 text-xs italic">Need more data to detect streaks</p>
                  )}
                  {whaleStreaks.map(w => (
                    <div key={w.code} className="relative pl-4 border-l-2 border-gold-500/30">
                      <div className="flex items-center justify-between mb-1">
                        <h4 className="font-bold text-zinc-100 text-sm">{FLAGS[w.code] || ''} {SHORT_NAMES[w.name] || w.name}</h4>
                        <span className="text-[9px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded uppercase">
                          {w.streak} {w.unit}
                        </span>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-lg font-black text-gold-500">+{w.totalAdded.toLocaleString()}t</span>
                        <span className="text-[10px] text-zinc-500 uppercase font-bold">added</span>
                      </div>
                      {CB_NAMES[w.code] && (
                        <p className="text-[9px] text-zinc-600 mt-0.5">{CB_NAMES[w.code]}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Biggest Movers */}
              <div className="glass-card p-6">
                <h3 className="font-bold text-lg mb-1">Latest Movers</h3>
                <p className="text-[10px] text-zinc-500 uppercase tracking-widest mb-4">Most recent period changes</p>
                <div className="space-y-2">
                  {biggestMovers.map(row => {
                    const change = Number(row.change_tonnes);
                    return (
                      <div
                        key={row.country_code}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-zinc-800/30 transition-colors cursor-pointer"
                        onClick={() => setSelectedCountry(row.country_code)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{FLAGS[row.country_code] || ''}</span>
                          <span className="text-xs font-bold text-zinc-300">{SHORT_NAMES[row.country_name] || row.country_name}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          {change > 0 ? (
                            <ArrowUpRight className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <ArrowDownRight className="w-3 h-3 text-rose-400" />
                          )}
                          <span className={cn("text-xs font-black", change > 0 ? "text-emerald-400" : "text-rose-400")}>
                            {change > 0 ? '+' : ''}{change.toFixed(1)}t
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Country History Chart */}
          {selectedCountry && countryHistory.length > 0 && (
            <div className="glass-card p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-bold text-lg">
                    {FLAGS[selectedCountry] || ''} {latestSnapshot.find(r => r.country_code === selectedCountry)?.country_name || selectedCountry}
                  </h3>
                  <p className="text-xs text-zinc-500 uppercase tracking-widest mt-1">
                    {CB_NAMES[selectedCountry] || 'Central Bank'} — Gold reserves over time (tonnes)
                  </p>
                </div>
                <button
                  onClick={() => setSelectedCountry(null)}
                  className="text-zinc-500 hover:text-zinc-300 text-xs font-bold uppercase px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-all"
                >
                  Close
                </button>
              </div>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={countryHistory} margin={{ top: 10, right: 30, left: 10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#F39C12" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#F39C12" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                    <XAxis
                      dataKey="label"
                      stroke="#555"
                      fontSize={9}
                      tickLine={false}
                      axisLine={false}
                      interval={countryHistory.length > 20 ? 3 : 0}
                    />
                    <YAxis stroke="#555" fontSize={10} tickLine={false} axisLine={false} tickFormatter={v => `${v.toLocaleString()}t`} domain={['dataMin - 10', 'dataMax + 10']} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (active && payload && payload.length) {
                          const tonnes = Number(payload[0].value);
                          const entry = countryHistory.find(h => h.label === label);
                          const change = entry?.change || 0;
                          return (
                            <div className="bg-[#121212] border border-[#333] p-3 rounded-lg shadow-xl">
                              <p className="text-zinc-400 text-xs font-bold uppercase mb-1">{formatPeriod(entry?.period || '')}</p>
                              <p className="text-gold-500 font-black text-sm">{tonnes.toLocaleString(undefined, { maximumFractionDigits: 1 })} tonnes</p>
                              {change !== 0 && (
                                <p className={cn("text-[10px] font-bold mt-1", change > 0 ? "text-emerald-400" : "text-rose-400")}>
                                  {change > 0 ? '+' : ''}{change.toFixed(1)}t vs previous
                                </p>
                              )}
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Area type="monotone" dataKey="tonnes" stroke="#F39C12" strokeWidth={2} fill="url(#goldGrad)" dot={{ r: countryHistory.length > 20 ? 0 : 3, fill: '#F39C12' }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Full Country Table */}
          <div className="glass-card overflow-hidden">
            <div className="p-6 border-b border-zinc-800">
              <h3 className="font-semibold text-lg">All Tracked Countries & Their Central Banks</h3>
              <p className="text-xs text-zinc-500 mt-1">Click any row to view full history. Each country's central bank manages its gold reserves as part of foreign exchange holdings.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-zinc-900/50 text-zinc-500 text-xs uppercase tracking-wider">
                    <th className="px-4 py-4 font-semibold w-8">#</th>
                    <th className="px-4 py-4 font-semibold">Country</th>
                    <th className="px-4 py-4 font-semibold">Central Bank</th>
                    <th className="px-4 py-4 font-semibold text-right">Holdings (t)</th>
                    <th className="px-4 py-4 font-semibold text-right">Last Change</th>
                    <th className="px-4 py-4 font-semibold text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {latestSnapshot.map((row, i) => {
                    const change = Number(row.change_tonnes);
                    return (
                      <tr
                        key={row.country_code}
                        className={cn(
                          "hover:bg-zinc-900/30 transition-colors cursor-pointer",
                          selectedCountry === row.country_code && "bg-gold-500/5"
                        )}
                        onClick={() => setSelectedCountry(row.country_code)}
                      >
                        <td className="px-4 py-3 text-xs text-zinc-600 font-bold">{i + 1}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-base">{FLAGS[row.country_code] || ''}</span>
                            <span className="text-sm font-medium text-zinc-200">{SHORT_NAMES[row.country_name] || row.country_name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-[11px] text-zinc-500">{CB_NAMES[row.country_code] || '—'}</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-sm font-mono text-zinc-300 font-bold">
                            {Number(row.tonnes).toLocaleString(undefined, { maximumFractionDigits: 1 })}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {change !== 0 ? (
                            <span className={cn("text-sm font-mono font-bold", change > 0 ? "text-emerald-400" : "text-rose-400")}>
                              {change > 0 ? '+' : ''}{change.toFixed(1)}t
                            </span>
                          ) : (
                            <span className="text-sm font-mono text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {change > 5 ? (
                            <span className="inline-flex items-center gap-1 text-[9px] font-black text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded uppercase">
                              <TrendingUp className="w-3 h-3" /> Buying
                            </span>
                          ) : change > 0 ? (
                            <span className="inline-flex items-center gap-1 text-[9px] font-black text-emerald-400/60 bg-emerald-500/5 px-2 py-0.5 rounded uppercase">
                              <ArrowUpRight className="w-3 h-3" /> Adding
                            </span>
                          ) : change < -5 ? (
                            <span className="inline-flex items-center gap-1 text-[9px] font-black text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded uppercase">
                              <TrendingDown className="w-3 h-3" /> Selling
                            </span>
                          ) : change < 0 ? (
                            <span className="inline-flex items-center gap-1 text-[9px] font-black text-rose-400/60 bg-rose-500/5 px-2 py-0.5 rounded uppercase">
                              <ArrowDownRight className="w-3 h-3" /> Reducing
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[9px] font-black text-zinc-600 bg-zinc-800/50 px-2 py-0.5 rounded uppercase">
                              <Minus className="w-3 h-3" /> Holding
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Explainer */}
          <div className="bg-gold-500/10 border border-gold-500/20 p-6 rounded-2xl flex gap-4">
            <div className="w-12 h-12 bg-gold-500/20 rounded-xl flex items-center justify-center shrink-0">
              <Info className="text-gold-500 w-6 h-6" />
            </div>
            <div>
              <h4 className="text-gold-500 font-bold text-lg mb-1">What Does This Mean?</h4>
              <p className="text-zinc-300 text-sm leading-relaxed">
                Every country has a <span className="font-bold">central bank</span> (like the Federal Reserve in the US, or the People's Bank of China).
                These banks hold gold as part of their country's foreign reserves — a safety net backing their currency.
                When a central bank <span className="text-emerald-400 font-bold">buys gold</span>, it signals confidence in gold as a store of value and often indicates they're diversifying away from the US dollar.
                When they <span className="text-rose-400 font-bold">sell</span>, they may need cash or are rebalancing reserves.
              </p>
              <p className="text-zinc-400 text-xs mt-3 leading-relaxed">
                Data sourced from IMF International Financial Statistics and World Gold Council. Active buyers (China, India, Poland, Turkey, etc.) report monthly.
                Some countries — notably China — may hold more gold than officially reported through non-disclosed channels.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
