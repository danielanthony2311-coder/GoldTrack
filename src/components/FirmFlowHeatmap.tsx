import React, { useState, useEffect, useMemo } from 'react';
import { Flame, Snowflake, ArrowRight } from 'lucide-react';
import { cn } from '../utils/cn';

interface FirmTotal {
  firm: string;
  totalStopped: number;
  totalIssued: number;
  net: number;
  days: number;
}

interface DailyRow {
  date: string;
  firm: string;
  total_issued: number;
  total_stopped: number;
  net: number;
}

interface FlowData {
  dates: string[];
  topFirms: FirmTotal[];
  dailyData: DailyRow[];
  metal: string;
}

// Shorten firm names for display
function shortName(firm: string): string {
  const map: Record<string, string> = {
    'JP MORGAN SECURITIES': 'JP Morgan',
    'BOFA SECURITIES': 'BofA',
    'BARCLAYS CAPITAL': 'Barclays',
    'MORGAN STANLEY': 'Morgan Stanley',
    'GOLDMAN SACHS': 'Goldman',
    'DEUTSCHE BANK SECURITIES': 'Deutsche Bank',
    'SCOTIA CAPITAL': 'Scotia',
    'WELLS FARGO SECURITIES': 'Wells Fargo',
    'BNP PARIBAS SECURITIES': 'BNP Paribas',
    'BMO CAPITAL MARKETS': 'BMO',
    'HSBC SECURITIES': 'HSBC',
    'CITIGROUP GLOBAL MARKETS': 'Citigroup',
    'UBS SECURITIES': 'UBS',
    'MACQUARIE FUTURES': 'Macquarie',
    'MAREX NORTH AMERICA': 'Marex',
    'ABN AMRO CLEARING': 'ABN Amro',
    'CANADIAN IMPERIAL BANK': 'CIBC',
    'MIZUHO SECURITIES': 'Mizuho',
    'NATIXIS SECURITIES': 'Natixis',
    'SOCIETE GENERALE': 'SocGen',
    'ADM INVESTOR SERVICES': 'ADM',
    'ED&F MAN CAPITAL MARKETS': 'ED&F Man',
    'RBC CAPITAL MARKETS': 'RBC',
    'STONEX FINANCIAL': 'StoneX',
    'ADVANTAGE FUTURES': 'Advantage',
  };
  for (const [full, short] of Object.entries(map)) {
    if (firm.toUpperCase().includes(full)) return short;
  }
  // Fallback: take first two words, cap at 14 chars
  const words = firm.split(/\s+/).slice(0, 2).join(' ');
  return words.length > 14 ? words.slice(0, 14) : words;
}

// Get color for heatmap cell based on net value
function cellColor(net: number, maxAbs: number): string {
  if (net === 0 || maxAbs === 0) return 'bg-zinc-900/30';
  const intensity = Math.min(Math.abs(net) / maxAbs, 1);
  if (net > 0) {
    if (intensity > 0.7) return 'bg-emerald-500/70';
    if (intensity > 0.4) return 'bg-emerald-500/40';
    if (intensity > 0.15) return 'bg-emerald-500/20';
    return 'bg-emerald-500/10';
  } else {
    if (intensity > 0.7) return 'bg-rose-500/70';
    if (intensity > 0.4) return 'bg-rose-500/40';
    if (intensity > 0.15) return 'bg-rose-500/20';
    return 'bg-rose-500/10';
  }
}

function cellTextColor(net: number, maxAbs: number): string {
  if (net === 0) return 'text-zinc-700';
  const intensity = Math.min(Math.abs(net) / maxAbs, 1);
  if (intensity > 0.4) return 'text-white';
  return net > 0 ? 'text-emerald-400' : 'text-rose-400';
}

// Format date as "Apr 1" or "3" (just day if same month)
function formatDateShort(dateStr: string, idx: number, dates: string[]): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  const month = d.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  // Show month on first date or if month changes
  if (idx === 0) return `${month} ${day}`;
  const prev = new Date(dates[idx - 1] + 'T00:00:00Z');
  if (prev.getUTCMonth() !== d.getUTCMonth()) return `${month} ${day}`;
  return `${day}`;
}

export default function FirmFlowHeatmap({ metal = 'GOLD' }: { metal?: string }) {
  const [data, setData] = useState<FlowData | null>(null);
  const [view, setView] = useState<'heatmap' | 'leaderboard'>('heatmap');
  const [hoveredCell, setHoveredCell] = useState<{ firm: string; date: string; net: number; stopped: number; issued: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/cme/firm-flows?metal=${metal}&days=30`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d); })
      .catch(() => {});
    return () => controller.abort();
  }, [metal]);

  // Build lookup: firm+date → row
  const lookup = useMemo(() => {
    if (!data) return {};
    const map: Record<string, DailyRow> = {};
    for (const row of data.dailyData) {
      map[`${row.firm}|${row.date}`] = row;
    }
    return map;
  }, [data]);

  // Max absolute net for color scaling
  const maxAbsNet = useMemo(() => {
    if (!data) return 1;
    let max = 1;
    for (const row of data.dailyData) {
      const abs = Math.abs(Number(row.net));
      if (abs > max) max = abs;
    }
    return max;
  }, [data]);

  if (!data || data.topFirms.length === 0) return null;

  const firms = data.topFirms;
  const dates = data.dates;

  // Cumulative data for leaderboard
  const sortedBuyers = [...firms].filter(f => f.net > 0).sort((a, b) => b.net - a.net);
  const sortedSellers = [...firms].filter(f => f.net < 0).sort((a, b) => a.net - b.net);
  const maxCumulative = Math.max(...firms.map(f => Math.abs(f.net)), 1);

  return (
    <div className="glass-card p-6 bg-[#121212] border-[#333] rounded-2xl w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-xl font-black text-zinc-100 tracking-tight">Institutional Flow Tracker</h3>
          <p className="text-zinc-500 text-xs font-medium uppercase tracking-widest mt-1">
            Who is accumulating vs distributing — Last {dates.length} trading days
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView('heatmap')}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-bold transition-all",
              view === 'heatmap' ? "bg-gold-500 text-black" : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
            )}
          >
            Heatmap
          </button>
          <button
            onClick={() => setView('leaderboard')}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-bold transition-all",
              view === 'leaderboard' ? "bg-gold-500 text-black" : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
            )}
          >
            Leaderboard
          </button>
        </div>
      </div>

      {view === 'heatmap' && (
        <>
          {/* Heatmap Grid */}
          <div className="overflow-x-auto pb-2">
            <div className="min-w-[600px]">
              {/* Date headers */}
              <div className="flex">
                <div className="w-28 shrink-0" /> {/* firm name column */}
                {dates.map((date, i) => (
                  <div key={date} className="flex-1 min-w-[36px] text-center">
                    <span className="text-[9px] font-bold text-zinc-600 uppercase">
                      {formatDateShort(date, i, dates)}
                    </span>
                  </div>
                ))}
                <div className="w-20 shrink-0 text-center">
                  <span className="text-[9px] font-bold text-zinc-500 uppercase">Total</span>
                </div>
              </div>

              {/* Firm rows */}
              {firms.map((firm) => {
                const cumNet = firm.net;
                return (
                  <div key={firm.firm} className="flex items-center group hover:bg-zinc-800/20 rounded transition-colors">
                    <div className="w-28 shrink-0 py-1 pr-2">
                      <span className="text-[10px] font-bold text-zinc-400 truncate block" title={firm.firm}>
                        {shortName(firm.firm)}
                      </span>
                    </div>
                    {dates.map((date) => {
                      const row = lookup[`${firm.firm}|${date}`];
                      const net = row ? Number(row.net) : 0;
                      const stopped = row ? Number(row.total_stopped) : 0;
                      const issued = row ? Number(row.total_issued) : 0;
                      return (
                        <div
                          key={date}
                          className={cn(
                            "flex-1 min-w-[36px] h-8 mx-px rounded-sm flex items-center justify-center cursor-default transition-all",
                            row ? cellColor(net, maxAbsNet) : 'bg-zinc-900/10',
                            "hover:ring-1 hover:ring-gold-500/50"
                          )}
                          onMouseEnter={() => setHoveredCell({ firm: firm.firm, date, net, stopped, issued })}
                          onMouseLeave={() => setHoveredCell(null)}
                        >
                          {row && net !== 0 && (
                            <span className={cn("text-[9px] font-black", cellTextColor(net, maxAbsNet))}>
                              {net > 0 ? '+' : ''}{net}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    <div className="w-20 shrink-0 text-center py-1">
                      <span className={cn(
                        "text-xs font-black",
                        cumNet > 0 ? "text-emerald-400" : cumNet < 0 ? "text-rose-400" : "text-zinc-600"
                      )}>
                        {cumNet > 0 ? '+' : ''}{cumNet.toLocaleString()}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tooltip */}
          {hoveredCell && (
            <div className="mt-3 p-3 bg-zinc-900/80 rounded-lg border border-[#333] text-xs">
              <span className="font-bold text-zinc-300">{shortName(hoveredCell.firm)}</span>
              <span className="text-zinc-600 mx-2">|</span>
              <span className="text-zinc-500">{hoveredCell.date}</span>
              <span className="text-zinc-600 mx-2">|</span>
              <span className="text-emerald-400 font-bold">+{hoveredCell.stopped} stopped</span>
              <span className="text-zinc-600 mx-2">/</span>
              <span className="text-rose-400 font-bold">-{hoveredCell.issued} issued</span>
              <span className="text-zinc-600 mx-2">=</span>
              <span className={cn("font-black", hoveredCell.net > 0 ? "text-emerald-400" : hoveredCell.net < 0 ? "text-rose-400" : "text-zinc-500")}>
                {hoveredCell.net > 0 ? 'Net Buyer' : hoveredCell.net < 0 ? 'Net Seller' : 'Flat'} ({hoveredCell.net > 0 ? '+' : ''}{hoveredCell.net})
              </span>
            </div>
          )}

          {/* Legend */}
          <div className="mt-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-emerald-500/70" />
                <span className="text-[9px] font-bold text-zinc-500 uppercase">Strong Buyer</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-emerald-500/20" />
                <span className="text-[9px] font-bold text-zinc-500 uppercase">Light Buyer</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-zinc-900/30" />
                <span className="text-[9px] font-bold text-zinc-500 uppercase">No Activity</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-rose-500/20" />
                <span className="text-[9px] font-bold text-zinc-500 uppercase">Light Seller</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-rose-500/70" />
                <span className="text-[9px] font-bold text-zinc-500 uppercase">Strong Seller</span>
              </div>
            </div>
          </div>
        </>
      )}

      {view === 'leaderboard' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Top Accumulators */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <Flame className="w-4 h-4 text-emerald-400" />
              <h4 className="text-sm font-black text-zinc-300 uppercase tracking-wider">Top Accumulators</h4>
            </div>
            <div className="space-y-2">
              {sortedBuyers.length === 0 && (
                <p className="text-zinc-600 text-xs italic">No net buyers in this period</p>
              )}
              {sortedBuyers.map((firm, i) => {
                const barWidth = (firm.net / maxCumulative) * 100;
                return (
                  <div key={firm.firm} className="group">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black text-zinc-600 w-4">{i + 1}</span>
                        <span className="text-xs font-bold text-zinc-300">{shortName(firm.firm)}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] text-zinc-600">{firm.days}d active</span>
                        <span className="text-xs font-black text-emerald-400">+{firm.net.toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="h-2 bg-zinc-900 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500/60 rounded-full transition-all duration-500"
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Top Distributors */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <Snowflake className="w-4 h-4 text-rose-400" />
              <h4 className="text-sm font-black text-zinc-300 uppercase tracking-wider">Top Distributors</h4>
            </div>
            <div className="space-y-2">
              {sortedSellers.length === 0 && (
                <p className="text-zinc-600 text-xs italic">No net sellers in this period</p>
              )}
              {sortedSellers.map((firm, i) => {
                const barWidth = (Math.abs(firm.net) / maxCumulative) * 100;
                return (
                  <div key={firm.firm} className="group">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black text-zinc-600 w-4">{i + 1}</span>
                        <span className="text-xs font-bold text-zinc-300">{shortName(firm.firm)}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] text-zinc-600">{firm.days}d active</span>
                        <span className="text-xs font-black text-rose-400">{firm.net.toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="h-2 bg-zinc-900 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-rose-500/60 rounded-full transition-all duration-500"
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Insight */}
      <div className="mt-6 p-4 bg-zinc-900/50 rounded-xl border border-[#222]">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1 h-4 bg-gold-500 rounded-full" />
          <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">How to Read This</span>
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed font-medium">
          <span className="text-emerald-400 font-bold">Green</span> = firm is taking physical delivery (bullish — they want the metal).{' '}
          <span className="text-rose-400 font-bold">Red</span> = firm is delivering metal out (could be selling inventory or fulfilling customer orders).{' '}
          Darker colors = larger volumes. Watch for patterns: a firm that's been consistently green is accumulating.
          A sudden flip from green to red could signal a change in positioning.
          House accounts (dealer's own money) carry more weight than customer accounts.
        </p>
      </div>
    </div>
  );
}
