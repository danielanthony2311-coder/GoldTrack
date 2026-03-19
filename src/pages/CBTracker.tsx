import React from 'react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell
} from 'recharts';
import { Globe, Calculator, TrendingUp, Info, X } from 'lucide-react';
import { CB_PURCHASE_TRENDS, COUNTRY_BREAKDOWN, GLOBAL_OFFICIAL_HOLDINGS, WHALE_STREAKS } from '../data/mockData';
import { cn } from '../utils/cn';

export default function CBTracker() {
  const [supply, setSupply] = React.useState(4800);
  const [demand, setDemand] = React.useState(4700);
  const [useShadowMultiplier, setUseShadowMultiplier] = React.useState(false);
  const [selectedCountry, setSelectedCountry] = React.useState<any>(null);

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Sovereign Central Bank Tracker</h1>
          <p className="text-zinc-400">Monitoring global official gold reserves and purchase trends.</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="glass-card px-4 py-2 border-gold-500/20 bg-gold-500/5">
            <span className="text-[10px] text-zinc-500 uppercase font-bold block mb-1">Global Reserves (2026)</span>
            <span className="text-xl font-black text-gold-500">35,828.4t</span>
          </div>
        </div>
      </div>

      {/* Global Leaderboard & Whale Tracker */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 glass-card p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="font-bold text-lg">Global Leaderboard: Official Gold Reserves</h3>
              <p className="text-xs text-zinc-500 uppercase tracking-widest mt-1">Top Holders (Tonnes) - 2026 Verified</p>
            </div>
            <div className="flex items-center gap-4 text-[10px] font-bold uppercase">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 bg-gold-500 rounded-full" />
                <span className="text-zinc-400">High % Reserves</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 bg-zinc-700 rounded-full" />
                <span className="text-zinc-400">Low % Reserves</span>
              </div>
            </div>
          </div>
          <div className="h-[400px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart 
                data={GLOBAL_OFFICIAL_HOLDINGS} 
                layout="vertical"
                margin={{ left: 40, right: 40 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={false} />
                <XAxis type="number" hide />
                <YAxis 
                  dataKey="country" 
                  type="category" 
                  stroke="#71717a" 
                  fontSize={11} 
                  tickLine={false} 
                  axisLine={false}
                  width={100}
                />
                <Tooltip 
                  cursor={{ fill: 'rgba(212, 175, 55, 0.05)' }}
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      return (
                        <div className="bg-[#121212] border border-[#333] p-3 rounded-lg shadow-xl">
                          <p className="text-zinc-400 text-xs font-bold uppercase mb-2">{data.country}</p>
                          <div className="space-y-1">
                            <p className="text-gold-500 font-black text-sm">{data.tonnes.toLocaleString()}t</p>
                            {data.percent_reserves && (
                              <p className="text-zinc-500 text-[10px] font-bold uppercase">
                                % of Reserves: <span className={cn(
                                  data.percent_reserves > 70 ? "text-emerald-500" : "text-amber-500"
                                )}>{data.percent_reserves}%</span>
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Bar 
                  dataKey="tonnes" 
                  radius={[0, 4, 4, 0]} 
                  barSize={24}
                >
                  {GLOBAL_OFFICIAL_HOLDINGS.map((entry, index) => (
                    <Cell 
                      key={`cell-${index}`} 
                      fill={entry.percent_reserves && entry.percent_reserves > 70 ? "#F39C12" : "#3f3f46"} 
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 p-4 bg-gold-500/5 border border-gold-500/10 rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-gold-500" />
              <span className="text-[10px] font-black text-gold-500 uppercase tracking-widest">Upside Potential Analysis</span>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              While the <span className="text-gold-500 font-bold">United States</span> holds 82.5% of its reserves in gold, <span className="text-zinc-100 font-bold">China</span> remains at only 8.6%. To match the US reserve ratio, China would need to acquire an additional <span className="text-gold-500 font-bold">~20,000 tonnes</span>, representing a multi-decade bullish floor for physical demand.
            </p>
          </div>
        </div>

        <div className="space-y-6">
          <div className="glass-card p-6">
            <h3 className="font-bold text-lg mb-6">Whale Tracker: Buying Streaks</h3>
            <div className="space-y-6">
              {Object.entries(WHALE_STREAKS).map(([country, data]: [string, any]) => (
                <div key={country} className="relative pl-4 border-l-2 border-gold-500/30">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="font-bold text-zinc-100">{country}</h4>
                    <span className="text-[10px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded uppercase">
                      Active Whale
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="text-2xl font-black text-gold-500">
                      {data.Annual_Accumulation ? `${data.Annual_Accumulation}t` : `${data.Q3_Total}t`}
                    </span>
                    <span className="text-[10px] text-zinc-500 uppercase font-bold">
                      {data.Annual_Accumulation ? 'Annual Accumulation' : 'Q3 Total'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 italic">
                    {data.Note || data.Streak || `Aggressive accumulation detected in 2025.`}
                  </p>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>

      {/* Monthly Trends Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 glass-card p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-semibold text-lg">Monthly Purchase Trends (24 Months)</h3>
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
              <div className="w-3 h-3 bg-gold-500 rounded-sm" />
              Net Purchases (Tonnes)
            </div>
          </div>
          <div className="h-[350px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={CB_PURCHASE_TRENDS}>
                <defs>
                  <linearGradient id="colorAmount" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                <XAxis dataKey="month" stroke="#71717a" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis stroke="#71717a" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                />
                <Area type="monotone" dataKey="amount" stroke="#f59e0b" fillOpacity={1} fill="url(#colorAmount)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Selected Country History Chart */}
        <div className="glass-card p-6 flex flex-col">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-semibold text-lg">
              {selectedCountry ? `${selectedCountry.country} Purchase History` : 'Select a Country'}
            </h3>
            {selectedCountry && (
              <button 
                onClick={() => setSelectedCountry(null)}
                className="p-1 hover:bg-zinc-800 rounded-full transition-colors"
              >
                <X className="w-4 h-4 text-zinc-500" />
              </button>
            )}
          </div>
          
          <div className="flex-1 min-h-[250px]">
            {selectedCountry ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={[...selectedCountry.history].reverse()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="month" stroke="#71717a" fontSize={10} tickLine={false} axisLine={false} />
                  <YAxis stroke="#71717a" fontSize={10} tickLine={false} axisLine={false} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                  />
                  <Bar dataKey="amount" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-3 opacity-50">
                <Globe className="w-12 h-12 text-zinc-700" />
                <p className="text-sm text-zinc-500">Click a country in the table below to view its monthly purchase history.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Country Breakdown */}
        <div className="lg:col-span-2 glass-card overflow-hidden">
          <div className="p-6 border-b border-zinc-800">
            <h3 className="font-semibold text-lg">Country-by-Country Breakdown</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-zinc-900/50 text-zinc-500 text-xs uppercase tracking-wider">
                  <th className="px-6 py-4">Country</th>
                  <th className="px-6 py-4">Official (t) & Last Purchase</th>
                  <th className="px-6 py-4">Recent History</th>
                  <th className="px-6 py-4">YOY Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {COUNTRY_BREAKDOWN.map((row, i) => (
                  <tr 
                    key={i} 
                    className={cn(
                      "hover:bg-zinc-900/30 transition-colors cursor-pointer",
                      selectedCountry?.country === row.country && "bg-gold-500/5"
                    )}
                    onClick={() => setSelectedCountry(row)}
                  >
                    <td className="px-6 py-4 flex items-center gap-3">
                      <div className="w-6 h-4 bg-zinc-800 rounded-sm" />
                      <span className="text-sm font-medium">{row.country}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-mono text-zinc-400">{row.official}t</span>
                        <div className="h-4 w-px bg-zinc-800" />
                        <div className="flex flex-col">
                          <span className="text-[10px] text-zinc-500 uppercase tracking-tighter font-bold">Last Purchase</span>
                          <span className="text-xs text-zinc-300">{row.lastPurchaseDate}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-1.5">
                        {(row as any).history?.map((h: any, idx: number) => (
                          <div key={idx} className="flex flex-col items-center">
                            <div 
                              className={cn(
                                "w-4 h-4 rounded-sm mb-1",
                                h.amount > 10 ? "bg-gold-500" : h.amount > 0 ? "bg-gold-500/40" : "bg-zinc-800"
                              )} 
                              title={`${h.month}: ${h.amount}t`}
                            />
                            <span className="text-[8px] text-zinc-600 font-mono">{h.month.split(' ')[0]}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm font-bold text-emerald-500">{row.change}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* China Special Section */}
        <div className="glass-card p-6 bg-gradient-to-br from-zinc-900 to-zinc-950">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-rose-500/10 rounded-xl flex items-center justify-center">
                <TrendingUp className="text-rose-500 w-6 h-6" />
              </div>
              <h3 className="font-bold text-lg">China Special Report</h3>
            </div>
          </div>
          
          <div className="space-y-6">
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold mb-2">
                Official vs Estimated Holdings
              </p>
              <div className="flex items-end gap-4">
                <div className="flex-1">
                  <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
                    <div className="h-full bg-zinc-400 w-[20%]" />
                  </div>
                  <span className="text-xs text-zinc-400">Official: 2,235t</span>
                </div>
                <div className="flex-1">
                  <div className="h-2 bg-rose-500 rounded-full overflow-hidden mb-2">
                    <div className="h-full bg-rose-500 w-full" />
                  </div>
                  <span className="text-xs text-rose-500 font-bold">
                    Estimated: 3,100t
                  </span>
                </div>
              </div>
            </div>
            
            <div className="p-4 rounded-xl border bg-zinc-800/50 border-zinc-700/50">
              <div className="flex items-center gap-2 mb-2 text-zinc-300">
                <Info className="w-4 h-4" />
                <span className="text-xs font-bold uppercase">
                  Analyst Note
                </span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                The gap between official and estimated holdings is attributed to non-reported purchases via the State Administration of Foreign Exchange (SAFE).
              </p>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
