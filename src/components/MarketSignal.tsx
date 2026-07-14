import { useEffect, useState, useRef, type ReactNode } from 'react';
import { ArrowUpRight, ArrowDownRight, Minus, Loader2, TrendingUp, TrendingDown, AlertTriangle, Activity, Pause, Info } from 'lucide-react';
import { cn } from '../utils/cn';

type PriceRow = {
  date: string;
  close: number;
  changeUsd: number | null;
  changePct: number | null;
  source: string;
};

type StockRow = {
  date: string;
  registered_oz: number;
  eligible_oz: number;
  total_oz: number;
  daily_change_registered: number | null;
  daily_change_eligible: number | null;
};

type Signal = 'BULLISH' | 'BEARISH' | 'CAUTIOUS' | 'MIXED' | 'QUIET';

type SignalConfig = {
  label: string;
  tone: string;
  chipBg: string;
  chipBorder: string;
  chipText: string;
  description: string;
  icon: ReactNode;
};

const SIGNALS: Record<Signal, SignalConfig> = {
  BULLISH: {
    label: 'Bullish',
    tone: 'text-emerald-400',
    chipBg: 'bg-emerald-500/10',
    chipBorder: 'border-emerald-500/30',
    chipText: 'text-emerald-400',
    description: 'Price up + registered stocks falling. Physical demand absorbing the rally.',
    icon: <TrendingUp className="w-4 h-4" />,
  },
  BEARISH: {
    label: 'Bearish',
    tone: 'text-rose-400',
    chipBg: 'bg-rose-500/10',
    chipBorder: 'border-rose-500/30',
    chipText: 'text-rose-400',
    description: 'Price down + stocks bleeding out. Distribution underway.',
    icon: <TrendingDown className="w-4 h-4" />,
  },
  CAUTIOUS: {
    label: 'Cautious',
    tone: 'text-amber-400',
    chipBg: 'bg-amber-500/10',
    chipBorder: 'border-amber-500/30',
    chipText: 'text-amber-400',
    description: 'Price up but registered stocks rising. Paper rally — dealers adding float, not tight.',
    icon: <AlertTriangle className="w-4 h-4" />,
  },
  MIXED: {
    label: 'Mixed',
    tone: 'text-sky-400',
    chipBg: 'bg-sky-500/10',
    chipBorder: 'border-sky-500/30',
    chipText: 'text-sky-400',
    description: 'Price down but stocks rising. Dealers pushing metal into weakness — watch for reversal.',
    icon: <Activity className="w-4 h-4" />,
  },
  QUIET: {
    label: 'Quiet',
    tone: 'text-zinc-400',
    chipBg: 'bg-zinc-500/10',
    chipBorder: 'border-zinc-500/30',
    chipText: 'text-zinc-400',
    description: 'No meaningful price move today. Watch tomorrow.',
    icon: <Pause className="w-4 h-4" />,
  },
};

function computeSignal(prices: PriceRow[], stocks: StockRow[]): Signal {
  // Use 3-day rolling averages so the signal isn't QUIET on every flat day
  const recentPrices = prices.slice(0, 3);
  const recentStocks = stocks.slice(-3);

  if (recentPrices.length === 0) return 'QUIET';

  const avgPricePct = recentPrices.reduce((s, p) => s + (p.changePct ?? 0), 0) / recentPrices.length;
  const totalRegChange = recentStocks.reduce((s, st) => s + (st.daily_change_registered ?? 0), 0);

  if (Math.abs(avgPricePct) < 0.1 && Math.abs(totalRegChange) < 5000) return 'QUIET';

  const priceUp = avgPricePct > 0;
  const stocksUp = totalRegChange > 0;
  const stocksDown = totalRegChange < 0;

  if (priceUp && stocksDown) return 'BULLISH';
  if (!priceUp && stocksUp) return 'MIXED';
  if (priceUp && stocksUp) return 'CAUTIOUS';
  if (!priceUp && stocksDown) return 'BEARISH';
  return 'QUIET';
}

type Props = {
  refreshKey?: number;
};

type SignalDay = {
  date: string;
  close: number;
  pricePct: number | null;
  regChange: number;
  signal: string;
};

const SIGNAL_DOT_COLORS: Record<string, string> = {
  BULLISH: 'bg-emerald-400',
  BEARISH: 'bg-rose-400',
  CAUTIOUS: 'bg-amber-400',
  MIXED: 'bg-sky-400',
  QUIET: 'bg-zinc-600',
};

export default function MarketSignal({ refreshKey }: Props) {
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [signalHistory, setSignalHistory] = useState<SignalDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showInfo) return;
    const handleClick = (e: MouseEvent) => {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) setShowInfo(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showInfo]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setErr(null);
      try {
        const [priceRes, stockRes, histRes] = await Promise.all([
          fetch('/api/prices/latest', { signal: controller.signal }),
          fetch('/api/cme/latest-stocks?metal=GOLD', { signal: controller.signal }),
          fetch('/api/prices/signal-history', { signal: controller.signal }),
        ]);
        if (!priceRes.ok) throw new Error(`Prices ${priceRes.status}`);
        if (!stockRes.ok) throw new Error(`Stocks ${stockRes.status}`);
        const priceJson = await priceRes.json();
        const stockJson = await stockRes.json();
        setPrices(priceJson?.prices ?? []);
        setStocks(Array.isArray(stockJson) ? stockJson : []);
        if (histRes.ok) {
          const histJson = await histRes.json();
          setSignalHistory(histJson?.history ?? []);
        }
      } catch (e: any) {
        if (e.name !== 'AbortError') setErr(e.message);
      } finally {
        setLoading(false);
      }
    };
    load();
    return () => controller.abort();
  }, [refreshKey]);

  const price = prices[0] ?? null;
  const stock = stocks.length > 0 ? stocks[stocks.length - 1] : null;
  const signal = computeSignal(prices, stocks);
  const cfg = SIGNALS[signal];
  const priceUp = (price?.changePct ?? 0) > 0;
  const priceDown = (price?.changePct ?? 0) < 0;
  const regUp = (stock?.daily_change_registered ?? 0) > 0;
  const regDown = (stock?.daily_change_registered ?? 0) < 0;

  return (
    <div className="glass-card p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="relative" ref={infoRef}>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-lg">Market Signal — Gold</h3>
            <button
              onClick={() => setShowInfo(!showInfo)}
              className="text-zinc-500 hover:text-gold-500 transition-colors"
              aria-label="Signal guide"
            >
              <Info className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">
            3-day rolling: CME settlement trend vs. COMEX registered-stock flow.
          </p>
          {showInfo && (
            <div className="absolute top-full left-0 mt-2 w-[340px] p-4 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl z-50 text-xs leading-relaxed">
              <h4 className="font-bold text-zinc-200 text-sm mb-3">How Signals Work</h4>
              <p className="text-zinc-400 mb-3">
                Each signal combines two inputs over a 3-day rolling window: the direction of gold's settlement price and the flow of COMEX registered stocks (metal available for delivery).
              </p>
              <div className="space-y-2.5">
                <div className="flex gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 mt-1.5 shrink-0" />
                  <div>
                    <span className="font-bold text-emerald-400">Bullish</span>
                    <span className="text-zinc-400"> — Price rising while registered stocks fall. Physical gold is leaving vaults to meet demand. The rally has real backing.</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-400 mt-1.5 shrink-0" />
                  <div>
                    <span className="font-bold text-amber-400">Cautious</span>
                    <span className="text-zinc-400"> — Price rising but registered stocks also rising. Dealers are adding supply into the rally. Could mean the move isn't backed by physical tightness — watch for reversal.</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <span className="w-2 h-2 rounded-full bg-rose-400 mt-1.5 shrink-0" />
                  <div>
                    <span className="font-bold text-rose-400">Bearish</span>
                    <span className="text-zinc-400"> — Price falling and stocks draining. Holders are pulling metal out during weakness — distribution pattern, suggests further downside.</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <span className="w-2 h-2 rounded-full bg-sky-400 mt-1.5 shrink-0" />
                  <div>
                    <span className="font-bold text-sky-400">Mixed</span>
                    <span className="text-zinc-400"> — Price falling but stocks rising. Dealers are pushing metal into vaults during weakness — could signal accumulation before a reversal.</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <span className="w-2 h-2 rounded-full bg-zinc-600 mt-1.5 shrink-0" />
                  <div>
                    <span className="font-bold text-zinc-400">Quiet</span>
                    <span className="text-zinc-400"> — Neither price nor stocks moved meaningfully. No signal to read.</span>
                  </div>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-zinc-800 text-zinc-500">
                <p><span className="text-zinc-400 font-medium">Thresholds:</span> Signal triggers when 3-day avg price move ≥ 0.1% or 3-day registered stock change ≥ 5,000 oz.</p>
                <p className="mt-1"><span className="text-zinc-400 font-medium">Note:</span> This signal can coexist with alerts like "Large Daily Move" (±2% single-day price change) — they measure different things.</p>
              </div>
            </div>
          )}
        </div>
        <div className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-full border",
          cfg.chipBg, cfg.chipBorder, cfg.chipText
        )}>
          <span className={cfg.chipText}>{cfg.icon}</span>
          <span className="text-xs font-bold uppercase tracking-wider">{cfg.label}</span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 text-zinc-500 py-6">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading signal…</span>
        </div>
      ) : err ? (
        <div className="text-sm text-rose-400 py-3">{err}</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {/* Spot price tile */}
            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Gold Price (Settlement)</span>
                <span className="text-[10px] text-zinc-600">{price?.date ?? '—'}</span>
              </div>
              <div className="flex items-end gap-3">
                <span className="text-3xl font-black text-gold-500">
                  {price ? `$${price.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                </span>
                {price?.changePct != null && (
                  <span className={cn(
                    "flex items-center gap-1 pb-1 text-sm font-bold",
                    priceUp ? "text-emerald-400" : priceDown ? "text-rose-400" : "text-zinc-400"
                  )}>
                    {priceUp ? <ArrowUpRight className="w-4 h-4" /> : priceDown ? <ArrowDownRight className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
                    {price.changePct > 0 ? '+' : ''}{price.changePct.toFixed(2)}%
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-600 mt-2">
                {price?.changeUsd != null
                  ? `${price.changeUsd > 0 ? '+' : ''}$${price.changeUsd.toFixed(2)} vs. previous close`
                  : 'No previous close'}
              </p>
            </div>

            {/* Registered stock flow tile */}
            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Registered Δ (COMEX)</span>
                <span className="text-[10px] text-zinc-600">{stock?.date ?? '—'}</span>
              </div>
              <div className="flex items-end gap-3">
                <span className="text-3xl font-black text-zinc-100">
                  {stock?.daily_change_registered != null
                    ? `${stock.daily_change_registered > 0 ? '+' : ''}${(stock.daily_change_registered / 1000).toFixed(1)}k oz`
                    : '—'}
                </span>
                {stock?.daily_change_registered != null && (
                  <span className={cn(
                    "flex items-center gap-1 pb-1 text-sm font-bold",
                    regUp ? "text-emerald-400" : regDown ? "text-rose-400" : "text-zinc-400"
                  )}>
                    {regUp ? <ArrowUpRight className="w-4 h-4" /> : regDown ? <ArrowDownRight className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
                    {regUp ? 'Adding' : regDown ? 'Draining' : 'Flat'}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-600 mt-2">
                Registered: {stock ? `${(stock.registered_oz / 1_000_000).toFixed(2)}M oz` : '—'}
              </p>
            </div>
          </div>

          <div className={cn(
            "p-3 rounded-lg border",
            cfg.chipBg, cfg.chipBorder
          )}>
            <p className={cn("text-xs font-medium leading-relaxed", cfg.chipText)}>
              {cfg.description}
            </p>
          </div>

          {/* Signal History Timeline */}
          {signalHistory.length > 0 && (
            <div className="mt-4 pt-4 border-t border-zinc-800/50">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Signal History</span>
                <div className="flex items-center gap-3 text-[9px] text-zinc-600">
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" /> Bull</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-400 inline-block" /> Bear</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" /> Cautious</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sky-400 inline-block" /> Mixed</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-zinc-600 inline-block" /> Quiet</span>
                </div>
              </div>
              <div className="flex items-end gap-[3px]">
                {[...signalHistory].reverse().map((day) => (
                  <div key={day.date} className="group relative flex-1 min-w-0">
                    <div
                      className={cn(
                        "w-full h-6 rounded-sm transition-all",
                        SIGNAL_DOT_COLORS[day.signal] ?? 'bg-zinc-700',
                        "opacity-70 group-hover:opacity-100"
                      )}
                    />
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-36 p-2 bg-zinc-900 border border-zinc-700 rounded-lg text-[10px] text-zinc-400 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
                      <p className="font-bold text-zinc-200">{day.date}</p>
                      <p>Settlement: ${day.close.toLocaleString()}</p>
                      <p>Price Δ: {day.pricePct != null ? `${day.pricePct > 0 ? '+' : ''}${day.pricePct}%` : '—'}</p>
                      <p>Reg Δ: {day.regChange > 0 ? '+' : ''}{(day.regChange / 1000).toFixed(1)}k oz</p>
                      <p className="font-bold mt-1">{day.signal}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-between mt-1.5 text-[9px] text-zinc-600">
                <span>{signalHistory.length > 0 ? signalHistory[signalHistory.length - 1]?.date : ''}</span>
                <span>{signalHistory[0]?.date ?? ''}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
