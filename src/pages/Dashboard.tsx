import { useState, useEffect, type ReactNode } from 'react';
import {
  ArrowUpRight, ArrowDownRight, Minus, Loader2, RefreshCw,
  TrendingUp, TrendingDown, AlertTriangle, Activity, Pause
} from 'lucide-react';
import { cn } from '../utils/cn';
import PriceChart from '../components/PriceChart';
import BasisSpread from '../components/BasisSpread';
import AlertBanner from '../components/AlertBanner';
import DailyBrief from '../components/DailyBrief';
import MarketNarrative from '../components/MarketNarrative';
import TightnessGauge from '../components/TightnessGauge';
import PredictionsScoreboard from '../components/PredictionsScoreboard';

type Signal = 'BULLISH' | 'BEARISH' | 'CAUTIOUS' | 'MIXED' | 'QUIET';

const SIGNAL_CFG: Record<Signal, { label: string; text: string; icon: ReactNode }> = {
  BULLISH:  { label: 'Bullish',  text: 'text-zinc-300', icon: <TrendingUp className="w-3.5 h-3.5" /> },
  BEARISH:  { label: 'Bearish',  text: 'text-zinc-300', icon: <TrendingDown className="w-3.5 h-3.5" /> },
  CAUTIOUS: { label: 'Cautious', text: 'text-zinc-300', icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  MIXED:    { label: 'Mixed',    text: 'text-zinc-300', icon: <Activity className="w-3.5 h-3.5" /> },
  QUIET:    { label: 'Quiet',    text: 'text-zinc-500', icon: <Pause className="w-3.5 h-3.5" /> },
};

const SIGNAL_BAR_COLORS: Record<string, string> = {
  BULLISH: 'bg-emerald-500',
  BEARISH: 'bg-rose-500',
  CAUTIOUS: 'bg-amber-500',
  MIXED: 'bg-sky-500',
  QUIET: 'bg-zinc-700',
};

export default function Dashboard() {
  const [metal, setMetal] = useState<'GOLD' | 'SILVER'>('GOLD');
  const [loading, setLoading] = useState(true);

  const [settlementPrice, setSettlementPrice] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState<number | null>(null);
  const [priceChangePct, setPriceChangePct] = useState<number | null>(null);
  const [signal, setSignal] = useState<Signal>('QUIET');
  const [signalHistory, setSignalHistory] = useState<{ date: string; signal: string; close: number; pricePct: number | null; regChange: number }[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [priceRes, stocksRes, histRes] = await Promise.all([
          fetch(`/api/prices/latest?metal=${metal}`),
          fetch(`/api/cme/latest-stocks?metal=${metal}`),
          fetch('/api/prices/signal-history'),
        ]);

        if (priceRes.ok) {
          const priceJson = await priceRes.json();
          const prices = priceJson?.prices ?? [];
          if (prices.length > 0) {
            setSettlementPrice(prices[0].close);
            setPriceChange(prices[0].changeUsd);
            setPriceChangePct(prices[0].changePct);
          }

          if (stocksRes.ok) {
            const stocks = await stocksRes.json();
            if (Array.isArray(stocks) && stocks.length > 0) {
              const recentPrices = prices.slice(0, 3);
              const recentStocks = stocks.slice(-3);
              const avgPct = recentPrices.reduce((s: number, p: any) => s + (p.changePct ?? 0), 0) / (recentPrices.length || 1);
              const totalReg = recentStocks.reduce((s: number, st: any) => s + (st.daily_change_registered ?? 0), 0);

              if (Math.abs(avgPct) < 0.1 && Math.abs(totalReg) < 5000) {
                setSignal('QUIET');
              } else {
                const up = avgPct > 0;
                const sDown = totalReg < 0;
                if (up && sDown) setSignal('BULLISH');
                else if (!up && !sDown) setSignal('MIXED');
                else if (up && !sDown) setSignal('CAUTIOUS');
                else if (!up && sDown) setSignal('BEARISH');
                else setSignal('QUIET');
              }
            }
          }
        }

        if (histRes.ok) {
          const histJson = await histRes.json();
          setSignalHistory(histJson?.history ?? []);
        }
      } catch (e) {
        console.error('Failed to fetch dashboard data', e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [metal]);

  const pUp = (priceChangePct ?? 0) > 0;
  const pDown = (priceChangePct ?? 0) < 0;
  const sig = SIGNAL_CFG[signal];

  return (
    <div className="space-y-10">
      {/* ─── TOP BAR ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Market Overview</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <DailyBrief />
          <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800">
            <button
              onClick={() => setMetal('GOLD')}
              className={cn("px-3 py-1 text-xs font-bold rounded-md transition-all", metal === 'GOLD' ? "bg-gold-500 text-black shadow-sm" : "text-zinc-500 hover:text-zinc-300")}
            >Gold</button>
            <button
              onClick={() => setMetal('SILVER')}
              className={cn("px-3 py-1 text-xs font-bold rounded-md transition-all", metal === 'SILVER' ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300")}
            >Silver</button>
          </div>
        </div>
      </div>

      {/* ─── HERO PRICE + SIGNAL HISTORY ─── */}
      <div className="glass-card p-8">
        {loading && !settlementPrice ? (
          <div className="flex items-center gap-3 text-zinc-500">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : (
          <>
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div>
                <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-3">
                  {metal} Settlement Price
                </p>
                <div className="flex items-end gap-4 flex-wrap">
                  <span className={cn(
                    "text-5xl font-black tracking-tight leading-none",
                    metal === 'GOLD' ? "text-gold-500" : "text-zinc-100"
                  )}>
                    {settlementPrice
                      ? `$${settlementPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                      : '—'}
                  </span>
                  {priceChangePct != null && (
                    <div className="flex items-center gap-2 pb-1">
                      <span className={cn(
                        "flex items-center gap-1 text-lg font-bold",
                        pUp ? "text-zinc-300" : pDown ? "text-zinc-400" : "text-zinc-500"
                      )}>
                        {pUp ? <ArrowUpRight className="w-5 h-5" /> : pDown ? <ArrowDownRight className="w-5 h-5" /> : <Minus className="w-5 h-5" />}
                        {priceChangePct > 0 ? '+' : ''}{priceChangePct.toFixed(2)}%
                      </span>
                      {priceChange != null && (
                        <span className="text-sm text-zinc-600">
                          ({priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)})
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 px-4 py-2 rounded-full border border-zinc-700/50 bg-zinc-800/30 self-start md:self-center">
                <span className={sig.text}>{sig.icon}</span>
                <span className={cn("text-xs font-bold uppercase tracking-wider", sig.text)}>
                  {sig.label}
                </span>
              </div>
            </div>

            {signalHistory.length > 0 && (
              <div className="mt-6 pt-5 border-t border-zinc-800/40">
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[10px] text-zinc-600 uppercase font-bold tracking-wider">30-Day Signal</span>
                  <div className="flex items-center gap-3 text-[9px] text-zinc-600">
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" /> Bull</span>
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500 inline-block" /> Bear</span>
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" /> Cautious</span>
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sky-500 inline-block" /> Mixed</span>
                  </div>
                </div>
                <div className="flex items-end gap-[2px]">
                  {[...signalHistory].reverse().map((day) => (
                    <div key={day.date} className="group relative flex-1 min-w-0">
                      <div className={cn(
                        "w-full h-4 rounded-sm opacity-60 group-hover:opacity-100 transition-opacity",
                        SIGNAL_BAR_COLORS[day.signal] ?? 'bg-zinc-700'
                      )} />
                      <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-36 p-2 bg-zinc-900 border border-zinc-700 rounded-lg text-[10px] text-zinc-400 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
                        <p className="font-bold text-zinc-200">{day.date}</p>
                        <p>Price: ${day.close.toLocaleString()}</p>
                        <p>Δ: {day.pricePct != null ? `${day.pricePct > 0 ? '+' : ''}${day.pricePct}%` : '—'}</p>
                        <p>Reg: {day.regChange > 0 ? '+' : ''}{(day.regChange / 1000).toFixed(1)}k oz</p>
                        <p className="font-bold mt-1">{day.signal}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between mt-1 text-[9px] text-zinc-700">
                  <span>{signalHistory.length > 0 ? signalHistory[signalHistory.length - 1]?.date : ''}</span>
                  <span>{signalHistory[0]?.date ?? ''}</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ─── ALERTS ─── */}
      <AlertBanner />

      {/* ─── TIGHTNESS GAUGE (centerpiece) ─── */}
      <TightnessGauge metal={metal} />

      {/* ─── AI INTERPRETATION ─── */}
      <MarketNarrative metal={metal} />

      {/* ─── PREDICTION SCOREBOARD (high-conviction alerts + graded track record) ─── */}
      <PredictionsScoreboard metal={metal} />

      {/* ─── PRICE CHARTS ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <PriceChart />
        <BasisSpread />
      </div>
    </div>
  );
}
