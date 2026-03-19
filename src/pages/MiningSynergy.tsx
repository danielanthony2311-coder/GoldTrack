import React, { useState, useMemo } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  Legend, ComposedChart, Area
} from 'recharts';
import { 
  TrendingUp, Calculator, ShieldAlert, Zap, Globe, 
  ArrowUpRight, ArrowDownRight, Info, Activity
} from 'lucide-react';
import { 
  GLOBAL_GOLD_FLOW, MINING_EQUITIES, SUPPLY_GAP_DATA 
} from '../data/mockData';
import { cn } from '../utils/cn';

export default function MiningSynergy() {
  const [spotGold, setSpotGold] = useState(2650);
  
  // Task 2: Operating Leverage Calculator Logic
  const calculateMargin = (aisc: number, price: number) => {
    return price - aisc;
  };

  const calculateLeverage = (aisc: number, oldPrice: number, newPrice: number) => {
    const oldMargin = oldPrice - aisc;
    const newMargin = newPrice - aisc;
    return ((newMargin - oldMargin) / oldMargin) * 100;
  };

  return (
    <div className="space-y-8 pb-12">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Sovereign-Mining Synergy</h1>
          <p className="text-zinc-400">Tracking physical accumulation as a lead indicator for mining equity performance.</p>
        </div>
        
        <div className="glass-card px-6 py-4 flex items-center gap-6 border-gold-500/30 bg-gold-500/5">
          <div className="flex flex-col">
            <span className="text-[10px] text-zinc-500 uppercase font-black tracking-wider">Spot Gold Price</span>
            <div className="flex items-center gap-3">
              <input 
                type="number" 
                value={spotGold} 
                onChange={(e) => setSpotGold(Number(e.target.value))}
                className="bg-transparent text-2xl font-black text-gold-500 w-24 focus:outline-none"
              />
              <span className="text-gold-500/50 font-bold">USD/oz</span>
            </div>
          </div>
        </div>
      </div>

      {/* Task 1: Sovereign Monthly Pulse Table */}
      <div className="glass-card overflow-hidden border-zinc-800">
        <div className="p-6 border-b border-zinc-800 flex items-center gap-3">
          <Globe className="text-gold-500 w-5 h-5" />
          <h3 className="font-bold text-lg">Global Gold Flow: Sovereign Monthly Pulse</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-950 text-zinc-500 text-[10px] uppercase font-black tracking-widest">
                <th className="px-6 py-4">Country</th>
                <th className="px-6 py-4">Monthly Tonnes</th>
                <th className="px-6 py-4">Shadow Multiplier</th>
                <th className="px-6 py-4">3M Momentum</th>
                <th className="px-6 py-4">Buying Streak</th>
                <th className="px-6 py-4 text-right">Signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {GLOBAL_GOLD_FLOW.map((row, i) => (
                <tr key={i} className="hover:bg-zinc-900/20 transition-colors">
                  <td className="px-6 py-4 font-bold text-zinc-200">{row.country}</td>
                  <td className="px-6 py-4 font-mono text-zinc-400">
                    {row.monthlyTonnes}t
                    {row.country === 'China' && (
                      <span className="ml-2 text-[10px] text-rose-500 font-black px-1.5 py-0.5 bg-rose-500/10 rounded">
                        EST: {(row.monthlyTonnes * row.multiplier).toFixed(1)}t
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-zinc-500 font-mono">{row.multiplier}x</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-zinc-300">{row.momentum}t</span>
                      {row.momentum > row.monthlyTonnes ? (
                        <ArrowDownRight className="w-3 h-3 text-rose-500" />
                      ) : (
                        <ArrowUpRight className="w-3 h-3 text-emerald-500" />
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <div className="flex gap-0.5">
                        {Array.from({ length: 5 }).map((_, idx) => (
                          <div 
                            key={idx} 
                            className={cn(
                              "w-1.5 h-4 rounded-sm",
                              idx < (row.consecutiveMonths % 6) ? "bg-gold-500" : "bg-zinc-800"
                            )} 
                          />
                        ))}
                      </div>
                      <span className="text-xs font-bold text-zinc-400">{row.consecutiveMonths}m</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <span className={cn(
                      "text-[10px] font-black uppercase px-2 py-1 rounded-full",
                      row.consecutiveMonths > 6 ? "bg-emerald-500/10 text-emerald-500" : "bg-zinc-800 text-zinc-500"
                    )}>
                      {row.consecutiveMonths > 6 ? 'Strong Accumulation' : 'Neutral'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Task 2: Miner Margin & AISC Monitor */}
        <div className="glass-card p-6 border-zinc-800">
          <div className="flex items-center gap-3 mb-6">
            <Calculator className="text-gold-500 w-5 h-5" />
            <h3 className="font-bold text-lg">Miner Margin & AISC Monitor</h3>
          </div>
          <div className="space-y-6">
            {MINING_EQUITIES.filter(m => m.aisc).map((miner, i) => {
              const margin = spotGold - (miner.aisc || 0);
              const marginPercent = (margin / (miner.aisc || 1)) * 100;
              const isBullish = spotGold > (miner.aisc || 0) * 1.5;
              
              return (
                <div key={i} className="p-4 bg-zinc-950 rounded-xl border border-zinc-900 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <span className="font-black text-zinc-200">{miner.name}</span>
                      <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">AISC: ${miner.aisc}/oz</span>
                    </div>
                    {isBullish && (
                      <div className="flex items-center gap-1.5 px-2 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                        <Zap className="w-3 h-3 text-emerald-500" />
                        <span className="text-[10px] font-black text-emerald-500 uppercase">Bullish Signal</span>
                      </div>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-3 gap-4">
                    <div className="flex flex-col">
                      <span className="text-[10px] text-zinc-500 font-bold uppercase">Net Margin</span>
                      <span className="text-lg font-black text-zinc-100">${margin}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] text-zinc-500 font-bold uppercase">Margin %</span>
                      <span className={cn("text-lg font-black", marginPercent > 50 ? "text-emerald-500" : "text-zinc-400")}>
                        {marginPercent.toFixed(1)}%
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] text-zinc-500 font-bold uppercase">Op Leverage</span>
                      <span className="text-lg font-black text-gold-500">
                        {calculateLeverage(miner.aisc || 0, 2500, spotGold).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  
                  <div className="h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                    <div 
                      className={cn("h-full transition-all duration-500", isBullish ? "bg-emerald-500" : "bg-gold-500")} 
                      style={{ width: `${Math.min(100, marginPercent)}%` }} 
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-6 p-4 bg-zinc-900/50 rounded-xl border border-zinc-800">
            <div className="flex items-center gap-2 mb-2 text-zinc-400">
              <Info className="w-4 h-4" />
              <span className="text-[10px] font-black uppercase">AISC Formula</span>
            </div>
            <p className="text-[10px] text-zinc-500 font-mono leading-relaxed">
              AISC = Direct Production + G&A + Sustaining CapEx + Exploration. 
              Operating Leverage is calculated relative to a $2,500 baseline.
            </p>
          </div>
        </div>

        {/* Task 3: Divergence Chart (House Account vs GDX) */}
        <div className="glass-card p-6 border-zinc-800">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Activity className="text-gold-500 w-5 h-5" />
              <h3 className="font-bold text-lg">House Surge vs. GDX Action</h3>
            </div>
            <div className="flex items-center gap-4 text-[10px] font-black uppercase tracking-widest">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 bg-gold-500 rounded-full" />
                <span className="text-zinc-400">House Surge</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 bg-emerald-500 rounded-full" />
                <span className="text-zinc-400">GDX Price</span>
              </div>
            </div>
          </div>
          <div className="h-[350px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={MINING_EQUITIES.find(m => m.ticker === 'GDX')?.history}>
                <CartesianGrid strokeDasharray="3 3" stroke="#18181b" vertical={false} />
                <XAxis dataKey="date" stroke="#3f3f46" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis yAxisId="left" stroke="#3f3f46" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis yAxisId="right" orientation="right" stroke="#3f3f46" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#09090b', border: '1px solid #27272a', borderRadius: '8px' }}
                />
                <Area 
                  yAxisId="left" 
                  type="monotone" 
                  dataKey="houseSurge" 
                  fill="#f59e0b" 
                  stroke="#f59e0b" 
                  fillOpacity={0.1} 
                  strokeWidth={2} 
                />
                <Line 
                  yAxisId="right" 
                  type="monotone" 
                  dataKey="price" 
                  stroke="#10b981" 
                  strokeWidth={3} 
                  dot={false} 
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Task 3: Supply Gap Widget */}
      <div className="glass-card p-8 bg-zinc-950 border-zinc-800">
        <div className="flex items-center gap-3 mb-8">
          <ShieldAlert className="text-rose-500 w-6 h-6" />
          <h3 className="font-black text-xl uppercase tracking-tighter">The Physical Supply Gap</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="md:col-span-3 space-y-8">
            <div className="relative h-12 bg-zinc-900 rounded-xl overflow-hidden flex">
              <div className="h-full bg-zinc-600 flex items-center justify-center text-[10px] font-black text-white px-2" style={{ width: '62%' }}>
                MINE SUPPLY (3,600t)
              </div>
              <div className="h-full bg-zinc-400 flex items-center justify-center text-[10px] font-black text-black px-2" style={{ width: '21%' }}>
                RECYCLING (1,200t)
              </div>
              <div className="h-full bg-rose-500/20 border-l-2 border-rose-500 border-dashed flex items-center justify-center text-[10px] font-black text-rose-500 px-2" style={{ width: '17%' }}>
                GAP (1,000t)
              </div>
            </div>
            
            <div className="grid grid-cols-3 gap-6">
              <div className="p-4 bg-zinc-900/50 rounded-xl border border-zinc-800">
                <span className="text-[10px] text-zinc-500 font-black uppercase tracking-widest block mb-2">Total Demand</span>
                <span className="text-2xl font-black text-zinc-100">{SUPPLY_GAP_DATA.totalDemand}t</span>
              </div>
              <div className="p-4 bg-rose-500/5 rounded-xl border border-rose-500/20">
                <span className="text-[10px] text-rose-500 font-black uppercase tracking-widest block mb-2">Shadow Demand</span>
                <span className="text-2xl font-black text-rose-500">{SUPPLY_GAP_DATA.shadowDemand}t</span>
              </div>
              <div className="p-4 bg-gold-500/5 rounded-xl border border-gold-500/20">
                <span className="text-[10px] text-gold-500 font-black uppercase tracking-widest block mb-2">Warehouse Drain</span>
                <span className="text-2xl font-black text-gold-500">{(SUPPLY_GAP_DATA.shadowDemand / 31.1).toFixed(1)}M oz</span>
              </div>
            </div>
          </div>
          
          <div className="flex flex-col items-center justify-center text-center p-6 bg-rose-500/10 rounded-2xl border border-rose-500/30">
            <span className="text-[10px] text-rose-500 font-black uppercase tracking-widest mb-2">Annual Deficit</span>
            <div className="text-5xl font-black text-rose-500 mb-2">-{SUPPLY_GAP_DATA.deficit}t</div>
            <p className="text-[10px] text-rose-400/70 font-medium leading-tight">
              Physical deficit being met by COMEX/LBMA warehouse inventory depletion.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
