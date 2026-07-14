import { useState, useEffect } from 'react';
import { AlertTriangle, TrendingDown, TrendingUp, Zap, X } from 'lucide-react';
import { cn } from '../utils/cn';

type Alert = {
  id: string;
  type: 'danger' | 'warning' | 'bullish' | 'info';
  title: string;
  message: string;
};

const ALERT_STYLES = {
  danger: {
    bg: 'bg-rose-500/5 border-rose-500/30',
    text: 'text-rose-400',
    icon: <AlertTriangle className="w-4 h-4" />,
  },
  warning: {
    bg: 'bg-amber-500/5 border-amber-500/30',
    text: 'text-amber-400',
    icon: <Zap className="w-4 h-4" />,
  },
  bullish: {
    bg: 'bg-emerald-500/5 border-emerald-500/30',
    text: 'text-emerald-400',
    icon: <TrendingUp className="w-4 h-4" />,
  },
  info: {
    bg: 'bg-sky-500/5 border-sky-500/30',
    text: 'text-sky-400',
    icon: <TrendingDown className="w-4 h-4" />,
  },
};

export default function AlertBanner() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    const check = async () => {
      try {
        const [stockRes, priceRes, noticeRes] = await Promise.all([
          fetch('/api/cme/latest-stocks?metal=GOLD', { signal: controller.signal }),
          fetch('/api/prices/latest?metal=GOLD', { signal: controller.signal }),
          fetch('/api/cme/latest-notices?metal=GOLD', { signal: controller.signal }),
        ]);

        const newAlerts: Alert[] = [];

        // Check warehouse stocks
        if (stockRes.ok) {
          const stocks = await stockRes.json();
          if (Array.isArray(stocks) && stocks.length > 0) {
            const latest = stocks[stocks.length - 1];
            const regOz = latest.registered_oz;
            const regChange = latest.daily_change_registered ?? 0;

            if (regOz < 15_000_000) {
              newAlerts.push({
                id: 'reg-critical',
                type: 'danger',
                title: 'Registered Gold Below 15M oz',
                message: `COMEX registered gold at ${(regOz / 1_000_000).toFixed(2)}M oz — historically low. Supply squeeze conditions.`,
              });
            } else if (regOz < 16_000_000) {
              newAlerts.push({
                id: 'reg-low',
                type: 'warning',
                title: 'Registered Gold Approaching 15M oz',
                message: `COMEX registered at ${(regOz / 1_000_000).toFixed(2)}M oz. Approaching critical levels.`,
              });
            }

            if (regChange < -200_000) {
              newAlerts.push({
                id: 'reg-drain',
                type: 'bullish',
                title: 'Large Registered Stock Drain',
                message: `${(Math.abs(regChange) / 1000).toFixed(0)}k oz left registered today — significant physical withdrawal.`,
              });
            }

            // Check 5-day drain trend
            if (stocks.length >= 5) {
              const last5 = stocks.slice(-5);
              const totalDrain = last5.reduce((s: number, d: any) => s + (d.daily_change_registered ?? 0), 0);
              if (totalDrain < -500_000) {
                newAlerts.push({
                  id: 'reg-5day-drain',
                  type: 'warning',
                  title: '5-Day Drain Acceleration',
                  message: `${(Math.abs(totalDrain) / 1000).toFixed(0)}k oz drained from registered in 5 trading days.`,
                });
              }
            }
          }
        }

        // Check delivery pace
        if (noticeRes.ok) {
          const notices = await noticeRes.json();
          if (Array.isArray(notices)) {
            const totalStopped = notices.reduce((s: number, n: any) => s + (n.stopped ?? 0), 0);
            if (totalStopped > 1000) {
              newAlerts.push({
                id: 'delivery-spike',
                type: 'bullish',
                title: 'Delivery Spike Detected',
                message: `${totalStopped.toLocaleString()} contracts stopped today — heavy physical demand.`,
              });
            }
          }
        }

        // Check price momentum
        if (priceRes.ok) {
          const priceJson = await priceRes.json();
          const prices = priceJson?.prices ?? [];
          if (prices.length >= 3) {
            const last3 = prices.slice(0, 3);
            const allUp = last3.every((p: any) => (p.changePct ?? 0) > 0);
            const allDown = last3.every((p: any) => (p.changePct ?? 0) < 0);
            const bigMove = Math.abs(prices[0]?.changePct ?? 0) > 2;

            if (allUp) {
              newAlerts.push({
                id: 'price-streak-up',
                type: 'bullish',
                title: '3-Day Up Streak',
                message: 'Gold settlement has risen 3 consecutive days. Momentum building.',
              });
            }
            if (allDown) {
              newAlerts.push({
                id: 'price-streak-down',
                type: 'info',
                title: '3-Day Down Streak',
                message: 'Gold settlement has fallen 3 consecutive days. Watch for support.',
              });
            }
            if (bigMove) {
              const pct = prices[0].changePct;
              newAlerts.push({
                id: 'price-big-move',
                type: pct > 0 ? 'bullish' : 'danger',
                title: `Large Daily Move: ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`,
                message: `Gold ${pct > 0 ? 'surged' : 'dropped'} $${Math.abs(prices[0].changeUsd ?? 0).toFixed(0)} today. Significant volatility.`,
              });
            }
          }
        }

        setAlerts(newAlerts);
      } catch (e: any) {
        if (e.name !== 'AbortError') console.error('Alert check failed:', e);
      }
    };

    check();
    return () => controller.abort();
  }, []);

  const visible = alerts.filter(a => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {visible.map(alert => {
        const style = ALERT_STYLES[alert.type];
        return (
          <div key={alert.id} className={cn("px-3 py-2 rounded-lg border flex items-center gap-2", style.bg)}>
            <span className={style.text}>{style.icon}</span>
            <p className={cn("text-xs font-medium flex-1 min-w-0 truncate", style.text)}>
              <span className="font-bold">{alert.title}</span>
              <span className="opacity-70"> — {alert.message}</span>
            </p>
            <button
              onClick={() => setDismissed(prev => new Set(prev).add(alert.id))}
              className="text-zinc-600 hover:text-zinc-400 transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
