import React, { useState, useEffect, useMemo } from 'react';
import { ArrowUpRight, ArrowDownRight, Minus, Shield, Building2 } from 'lucide-react';
import { cn } from '../utils/cn';

interface Notice {
  firm: string;
  issued: number;
  stopped: number;
  metal: string;
  account_type: string;
  date: string;
}

export default function NetPositioning() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [reportDate, setReportDate] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/cme/latest-notices?metal=GOLD', { signal: controller.signal })
      .then(r => r.ok ? r.json() : [])
      .then((data: Notice[]) => {
        setNotices(data);
        if (data.length > 0) setReportDate(data[0].date);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const analysis = useMemo(() => {
    if (notices.length === 0) return null;

    // Aggregate by firm+account_type
    const firms: Record<string, { firm: string; type: string; issued: number; stopped: number }> = {};
    for (const n of notices) {
      const key = `${n.firm}|${n.account_type}`;
      if (!firms[key]) firms[key] = { firm: n.firm, type: n.account_type, issued: 0, stopped: 0 };
      firms[key].issued += Number(n.issued);
      firms[key].stopped += Number(n.stopped);
    }

    const all = Object.values(firms).map(f => ({
      ...f,
      net: f.stopped - f.issued,
      signal: f.stopped > f.issued ? 'BUYER' as const : f.issued > f.stopped ? 'SELLER' as const : 'FLAT' as const
    }));

    // Sort by net (biggest buyers first, biggest sellers last)
    all.sort((a, b) => b.net - a.net);

    const buyers = all.filter(f => f.signal === 'BUYER');
    const sellers = all.filter(f => f.signal === 'SELLER');

    // House vs Customer breakdown
    const houseBuying = all.filter(f => f.type === 'HOUSE' && f.net > 0).reduce((s, f) => s + f.net, 0);
    const houseSelling = all.filter(f => f.type === 'HOUSE' && f.net < 0).reduce((s, f) => s + Math.abs(f.net), 0);
    const custBuying = all.filter(f => f.type === 'CUSTOMER' && f.net > 0).reduce((s, f) => s + f.net, 0);
    const custSelling = all.filter(f => f.type === 'CUSTOMER' && f.net < 0).reduce((s, f) => s + Math.abs(f.net), 0);

    const totalStopped = all.reduce((s, f) => s + f.stopped, 0);
    const totalIssued = all.reduce((s, f) => s + f.issued, 0);

    // Accumulation ratio: what % of total volume is net buying
    const buyVolume = buyers.reduce((s, f) => s + f.net, 0);
    const sellVolume = sellers.reduce((s, f) => s + Math.abs(f.net), 0);
    const accumRatio = totalStopped > 0 ? (buyVolume / totalStopped) * 100 : 0;

    // House buying is a stronger signal — dealers positioning for themselves
    const houseNetBuying = houseBuying > houseSelling;

    return {
      all,
      buyers,
      sellers,
      totalStopped,
      totalIssued,
      houseBuying,
      houseSelling,
      custBuying,
      custSelling,
      buyVolume,
      sellVolume,
      accumRatio,
      houseNetBuying,
      buyerCount: buyers.length,
      sellerCount: sellers.length,
    };
  }, [notices]);

  if (!analysis) return null;

  const isBullish = analysis.buyerCount > analysis.sellerCount * 2 && analysis.houseNetBuying;
  const isBearish = analysis.sellerCount > analysis.buyerCount;
  const signalColor = isBullish ? 'text-emerald-400' : isBearish ? 'text-rose-400' : 'text-zinc-400';
  const signalBg = isBullish ? 'bg-emerald-500/10 border-emerald-500/30' : isBearish ? 'bg-rose-500/10 border-rose-500/30' : 'bg-zinc-800/50 border-zinc-700/50';
  const signalLabel = isBullish ? 'ACCUMULATION' : isBearish ? 'DISTRIBUTION' : 'MIXED';

  return (
    <div className="glass-card p-6 bg-[#121212] border-[#333] rounded-2xl w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-xl font-black text-zinc-100 tracking-tight">Net Positioning</h3>
          <p className="text-zinc-500 text-xs font-medium uppercase tracking-widest mt-1">
            Who is buying vs selling — {reportDate}
          </p>
        </div>
        <div className={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-black uppercase tracking-wider", signalBg, signalColor)}>
          {isBullish ? <ArrowUpRight className="w-3.5 h-3.5" /> : isBearish ? <ArrowDownRight className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
          {signalLabel}
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-[#222]">
          <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-1">Net Buyers</p>
          <p className="text-2xl font-black text-emerald-400">{analysis.buyerCount}</p>
          <p className="text-[10px] text-zinc-600 mt-1">{analysis.buyVolume.toLocaleString()} contracts</p>
        </div>
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-[#222]">
          <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-1">Net Sellers</p>
          <p className="text-2xl font-black text-rose-400">{analysis.sellerCount}</p>
          <p className="text-[10px] text-zinc-600 mt-1">{analysis.sellVolume.toLocaleString()} contracts</p>
        </div>
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-[#222]">
          <div className="flex items-center gap-1.5 mb-1">
            <Building2 className="w-3 h-3 text-zinc-500" />
            <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">House Accounts</p>
          </div>
          <p className={cn("text-2xl font-black", analysis.houseNetBuying ? "text-emerald-400" : "text-rose-400")}>
            {analysis.houseNetBuying ? 'NET BUY' : 'NET SELL'}
          </p>
          <p className="text-[10px] text-zinc-600 mt-1">
            +{analysis.houseBuying.toLocaleString()} / -{analysis.houseSelling.toLocaleString()}
          </p>
        </div>
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-[#222]">
          <div className="flex items-center gap-1.5 mb-1">
            <Shield className="w-3 h-3 text-zinc-500" />
            <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Customer Accounts</p>
          </div>
          <p className={cn("text-2xl font-black", analysis.custBuying > analysis.custSelling ? "text-emerald-400" : "text-rose-400")}>
            {analysis.custBuying > analysis.custSelling ? 'NET BUY' : 'NET SELL'}
          </p>
          <p className="text-[10px] text-zinc-600 mt-1">
            +{analysis.custBuying.toLocaleString()} / -{analysis.custSelling.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Buyer/Seller Bar */}
      <div className="mb-6">
        <div className="flex justify-between text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-2">
          <span>Buyers ({analysis.buyerCount})</span>
          <span>Sellers ({analysis.sellerCount})</span>
        </div>
        <div className="h-4 bg-zinc-900 rounded-full overflow-hidden border border-[#222] flex">
          <div
            className="h-full bg-emerald-500/70 rounded-l-full transition-all duration-500"
            style={{ width: `${(analysis.buyerCount / (analysis.buyerCount + analysis.sellerCount)) * 100}%` }}
          />
          <div
            className="h-full bg-rose-500/70 rounded-r-full transition-all duration-500"
            style={{ width: `${(analysis.sellerCount / (analysis.buyerCount + analysis.sellerCount)) * 100}%` }}
          />
        </div>
      </div>

      {/* Firm Detail Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[#222]">
              <th className="text-left text-[10px] font-black text-zinc-500 uppercase tracking-widest py-2 pr-4">Firm</th>
              <th className="text-center text-[10px] font-black text-zinc-500 uppercase tracking-widest py-2 px-2">Type</th>
              <th className="text-right text-[10px] font-black text-zinc-500 uppercase tracking-widest py-2 px-2">Issued</th>
              <th className="text-right text-[10px] font-black text-zinc-500 uppercase tracking-widest py-2 px-2">Stopped</th>
              <th className="text-right text-[10px] font-black text-zinc-500 uppercase tracking-widest py-2 pl-2">Net</th>
            </tr>
          </thead>
          <tbody>
            {analysis.all.map((f, i) => (
              <tr key={i} className="border-b border-[#1a1a1a] hover:bg-zinc-900/30 transition-colors">
                <td className="py-2 pr-4 font-bold text-zinc-300">{f.firm}</td>
                <td className="py-2 px-2 text-center">
                  <span className={cn(
                    "text-[9px] font-black px-1.5 py-0.5 rounded uppercase",
                    f.type === 'HOUSE' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'
                  )}>
                    {f.type === 'HOUSE' ? 'H' : 'C'}
                  </span>
                </td>
                <td className="py-2 px-2 text-right text-zinc-500 font-mono">{f.issued > 0 ? f.issued.toLocaleString() : '—'}</td>
                <td className="py-2 px-2 text-right text-zinc-500 font-mono">{f.stopped > 0 ? f.stopped.toLocaleString() : '—'}</td>
                <td className={cn(
                  "py-2 pl-2 text-right font-mono font-black",
                  f.net > 0 ? 'text-emerald-400' : f.net < 0 ? 'text-rose-400' : 'text-zinc-600'
                )}>
                  {f.net > 0 ? '+' : ''}{f.net.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Signal Explanation */}
      <div className="mt-6 p-4 bg-zinc-900/50 rounded-xl border border-[#222]">
        <div className="flex items-center gap-2 mb-2">
          <div className={cn("w-1 h-4 rounded-full", isBullish ? "bg-emerald-500" : isBearish ? "bg-rose-500" : "bg-zinc-500")} />
          <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Position Signal</span>
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed font-medium">
          {isBullish
            ? `Strong accumulation signal: ${analysis.buyerCount} firms are net buyers vs ${analysis.sellerCount} sellers. House accounts (dealers trading for themselves) are net buying — this is the strongest bullish signal in delivery data, as it means dealers are positioning their own books for higher prices.`
            : isBearish
              ? `Distribution pattern: more firms are net selling than buying. This could indicate liquidation to raise cash (e.g., covering losses in other markets like energy) rather than genuine bearishness on gold.`
              : `Mixed positioning with ${analysis.buyerCount} buyers and ${analysis.sellerCount} sellers. Watch House account direction for the stronger signal — customer flow can be hedging-related.`
          }
        </p>
        <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-zinc-600">
          <span><span className="text-purple-400 font-bold">H = House</span> — Dealer's own money (stronger signal)</span>
          <span><span className="text-blue-400 font-bold">C = Customer</span> — Client accounts (could be hedging)</span>
        </div>
      </div>
    </div>
  );
}
