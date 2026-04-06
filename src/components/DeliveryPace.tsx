import React, { useState, useEffect, useMemo } from 'react';
import { TrendingUp, TrendingDown, Zap, Activity } from 'lucide-react';
import { cn } from '../utils/cn';

const HISTORICAL_AVERAGES: Record<string, number> = {
  Jan: 11663, Feb: 25759, Mar: 12015, Apr: 11088, May: 17535,
  Jun: 8663, Jul: 10838, Aug: 12950, Sep: 12225, Oct: 12525,
  Nov: 13650, Dec: 16550
};

// Approximate trading days per month
const TRADING_DAYS: Record<string, number> = {
  Jan: 21, Feb: 19, Mar: 21, Apr: 21, May: 21,
  Jun: 21, Jul: 21, Aug: 22, Sep: 21, Oct: 22,
  Nov: 20, Dec: 21
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface MtdRow {
  date: string;
  mtd: number;
  daily_stopped: number | null;
}

export default function DeliveryPace() {
  const [mtdData, setMtdData] = useState<MtdRow[]>([]);
  const [ytdMonths, setYtdMonths] = useState<Record<string, number>>({});

  useEffect(() => {
    const controller = new AbortController();
    const YTD_MAP: Record<string, string> = {
      JAN: "Jan", FEB: "Feb", MAR: "Mar", APR: "Apr", MAY: "May", JUN: "Jun",
      JUL: "Jul", AUG: "Aug", SEP: "Sep", OCT: "Oct", NOV: "Nov", DEC: "Dec"
    };

    Promise.all([
      fetch('/api/cme/summary?metal=GOLD&type=MTD', { signal: controller.signal }).then(r => r.ok ? r.json() : []),
      fetch('/api/cme/summary?metal=GOLD&type=YTD', { signal: controller.signal }).then(r => r.ok ? r.json() : [])
    ]).then(([mtd, ytd]: [any[], any[]]) => {
      setMtdData(mtd.map((r: any) => ({ date: r.date, mtd: Number(r.mtd) || 0, daily_stopped: r.daily_stopped ? Number(r.daily_stopped) : null })));

      // Get latest YTD row
      const sorted = ytd.sort((a: any, b: any) => b.date.localeCompare(a.date));
      if (sorted.length > 0 && sorted[0].ytd_json) {
        try {
          const parsed = JSON.parse(sorted[0].ytd_json);
          const mapped: Record<string, number> = {};
          for (const [k, v] of Object.entries(parsed)) {
            const name = YTD_MAP[k];
            if (name) mapped[name] = v as number;
          }
          setYtdMonths(mapped);
        } catch {}
      }
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  const pace = useMemo(() => {
    if (mtdData.length === 0) return null;

    // Current month from the latest MTD entry
    const sorted = [...mtdData].sort((a, b) => b.date.localeCompare(a.date));
    const latest = sorted[0];
    const latestDate = new Date(latest.date + 'T00:00:00Z');
    const monthIdx = latestDate.getUTCMonth();
    const monthName = MONTH_NAMES[monthIdx];
    const dayOfMonth = latestDate.getUTCDate();

    // Count trading days elapsed (rough: ~day * 0.71 for weekdays)
    // Better: count actual data points we have for this month
    const thisMonthRows = sorted.filter(r => {
      const d = new Date(r.date + 'T00:00:00Z');
      return d.getUTCMonth() === monthIdx;
    });
    const tradingDaysElapsed = Math.max(thisMonthRows.length, Math.round(dayOfMonth * 0.71));
    const totalTradingDays = TRADING_DAYS[monthName] || 21;
    const currentTotal = latest.mtd;
    const dailyRate = tradingDaysElapsed > 0 ? currentTotal / tradingDaysElapsed : 0;
    const projected = Math.round(dailyRate * totalTradingDays);
    const average = HISTORICAL_AVERAGES[monthName] || 0;
    const vsAvgPercent = average > 0 ? ((projected - average) / average) * 100 : 0;

    // Previous completed months from YTD
    const prevMonthIdx = monthIdx - 1;
    const prevMonthName = prevMonthIdx >= 0 ? MONTH_NAMES[prevMonthIdx] : "Dec";
    const prevMonthTotal = ytdMonths[prevMonthName] || null;
    const prevMonthAvg = HISTORICAL_AVERAGES[prevMonthName] || 0;
    const prevVsAvg = prevMonthTotal && prevMonthAvg > 0 ? ((prevMonthTotal - prevMonthAvg) / prevMonthAvg) * 100 : null;

    return {
      monthName,
      dayOfMonth,
      tradingDaysElapsed,
      totalTradingDays,
      currentTotal,
      dailyRate: Math.round(dailyRate),
      projected,
      average,
      vsAvgPercent,
      prevMonthName,
      prevMonthTotal,
      prevVsAvg,
      isHot: vsAvgPercent > 50,
      isCold: vsAvgPercent < -30,
    };
  }, [mtdData, ytdMonths]);

  if (!pace) return null;

  const SignalIcon = pace.isHot ? Zap : pace.isCold ? TrendingDown : Activity;
  const signalColor = pace.isHot ? 'text-amber-400' : pace.isCold ? 'text-blue-400' : 'text-zinc-400';
  const signalBg = pace.isHot ? 'bg-amber-500/10 border-amber-500/30' : pace.isCold ? 'bg-blue-500/10 border-blue-500/30' : 'bg-zinc-800/50 border-zinc-700/50';
  const signalLabel = pace.isHot ? 'ELEVATED DEMAND' : pace.isCold ? 'BELOW AVERAGE' : 'NORMAL PACE';

  return (
    <div className="glass-card p-6 bg-[#121212] border-[#333] rounded-2xl w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-xl font-black text-zinc-100 tracking-tight">Delivery Pace</h3>
          <p className="text-zinc-500 text-xs font-medium uppercase tracking-widest mt-1">
            {pace.monthName} 2026 — Day {pace.dayOfMonth} ({pace.tradingDaysElapsed} of ~{pace.totalTradingDays} trading days)
          </p>
        </div>
        <div className={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-black uppercase tracking-wider", signalBg, signalColor)}>
          <SignalIcon className="w-3.5 h-3.5" />
          {signalLabel}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {/* Current Total */}
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-[#222]">
          <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-1">Current Total</p>
          <p className="text-2xl font-black text-gold-500">{pace.currentTotal.toLocaleString()}</p>
          <p className="text-[10px] text-zinc-600 mt-1">contracts delivered</p>
        </div>

        {/* Daily Rate */}
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-[#222]">
          <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-1">Daily Rate</p>
          <p className="text-2xl font-black text-zinc-100">{pace.dailyRate.toLocaleString()}</p>
          <p className="text-[10px] text-zinc-600 mt-1">contracts / trading day</p>
        </div>

        {/* Projected Month-End */}
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-[#222]">
          <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-1">Projected Total</p>
          <p className="text-2xl font-black text-zinc-100">{pace.projected.toLocaleString()}</p>
          <p className={cn("text-[10px] mt-1 font-bold", pace.vsAvgPercent > 0 ? "text-emerald-500" : "text-rose-500")}>
            {pace.vsAvgPercent > 0 ? '+' : ''}{pace.vsAvgPercent.toFixed(0)}% vs 5Y avg ({pace.average.toLocaleString()})
          </p>
        </div>

        {/* Previous Month */}
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-[#222]">
          <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-1">{pace.prevMonthName} Final</p>
          <p className="text-2xl font-black text-zinc-100">
            {pace.prevMonthTotal ? pace.prevMonthTotal.toLocaleString() : '—'}
          </p>
          {pace.prevVsAvg !== null && (
            <p className={cn("text-[10px] mt-1 font-bold", pace.prevVsAvg > 0 ? "text-emerald-500" : "text-rose-500")}>
              {pace.prevVsAvg > 0 ? '+' : ''}{pace.prevVsAvg.toFixed(0)}% vs avg
            </p>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex justify-between text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-2">
          <span>Month Progress</span>
          <span>{pace.currentTotal.toLocaleString()} / {pace.projected.toLocaleString()} projected</span>
        </div>
        <div className="h-3 bg-zinc-900 rounded-full overflow-hidden border border-[#222]">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${Math.min((pace.tradingDaysElapsed / pace.totalTradingDays) * 100, 100)}%`,
              background: pace.isHot
                ? 'linear-gradient(90deg, #F39C12, #E74C3C)'
                : pace.isCold
                  ? 'linear-gradient(90deg, #3B82F6, #6366F1)'
                  : 'linear-gradient(90deg, #F39C12, #F39C12)'
            }}
          />
        </div>
      </div>

      {/* Insight */}
      <div className="p-4 bg-zinc-900/50 rounded-xl border border-[#222]">
        <div className="flex items-center gap-2 mb-2">
          <div className={cn("w-1 h-4 rounded-full", pace.isHot ? "bg-amber-500" : pace.isCold ? "bg-blue-500" : "bg-gold-500")} />
          <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Pace Signal</span>
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed font-medium">
          {pace.isHot
            ? `Physical delivery demand is running hot. At ${pace.dailyRate.toLocaleString()} contracts/day, ${pace.monthName} is on pace to reach ${pace.projected.toLocaleString()} — ${Math.abs(pace.vsAvgPercent).toFixed(0)}% above the 5-year average. Institutions are aggressively taking physical delivery.`
            : pace.isCold
              ? `Delivery pace is subdued at ${pace.dailyRate.toLocaleString()} contracts/day. Projected ${pace.projected.toLocaleString()} would be ${Math.abs(pace.vsAvgPercent).toFixed(0)}% below average. Physical demand may be cooling.`
              : `Delivery pace is tracking near normal at ${pace.dailyRate.toLocaleString()} contracts/day. Projected ${pace.projected.toLocaleString()} is within range of the 5-year average (${pace.average.toLocaleString()}).`
          }
          {pace.prevMonthTotal && pace.prevVsAvg !== null && (
            ` Last month (${pace.prevMonthName}) closed at ${pace.prevMonthTotal.toLocaleString()} (${pace.prevVsAvg > 0 ? '+' : ''}${pace.prevVsAvg.toFixed(0)}% vs avg).`
          )}
        </p>
      </div>
    </div>
  );
}
