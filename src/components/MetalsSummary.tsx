import React, { useEffect, useState } from 'react';
import { Loader2, TrendingUp, TrendingDown, Info } from 'lucide-react';
import { cn } from '../utils/cn';

interface MetalsSummaryData {
  id: number;
  date: string;
  metal: string;
  report_type: string;
  mtd: number | null;
  settlement: number | null;
  daily_issued: number | null;
  daily_stopped: number | null;
  ytd_by_month: Record<string, number> | null;
}

export default function MetalsSummary() {
  const [summaries, setSummaries] = useState<MetalsSummaryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummaries = async () => {
    try {
      const response = await fetch('/api/cme/summary');
      if (!response.ok) throw new Error('Failed to fetch metals summary');
      const data = await response.json();
      setSummaries(data);
    } catch (err: any) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSummaries();
  }, []);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-gold-500" /></div>;
  if (error) return <div className="p-4 bg-rose-500/10 text-rose-500 rounded-lg">{error}</div>;

  // Group by metal for the latest report
  const latestByMetal: Record<string, MetalsSummaryData[]> = {};
  summaries
    .filter(s => ['GOLD', 'SILVER'].includes(s.metal))
    .forEach(s => {
      if (!latestByMetal[s.metal]) latestByMetal[s.metal] = [];
      latestByMetal[s.metal].push(s);
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Metals Delivery Summary</h2>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Info className="w-4 h-4" />
          <span>Latest data from CME PDF Reports</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {Object.entries(latestByMetal).map(([metal, reports]) => {
          const daily = reports.find(r => r.report_type === 'DAILY');
          const mtd = reports.find(r => r.report_type === 'MTD');
          const ytd = reports.find(r => r.report_type === 'YTD');

          return (
            <div key={metal} className="glass-card p-6 hover:border-gold-500/30 transition-all group">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-gold-500">{metal}</h3>
                {daily?.settlement && (
                  <div className="text-right">
                    <div className="text-xs text-zinc-500 uppercase font-bold">Settlement</div>
                    <div className="font-mono font-bold">${daily.settlement.toLocaleString()}</div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="p-3 bg-zinc-900/50 rounded-lg border border-zinc-800">
                  <div className="text-[10px] text-zinc-500 uppercase font-bold mb-1">Daily Issued</div>
                  <div className="text-rose-500 font-black text-xl">
                    {daily?.daily_issued?.toLocaleString() || '0'}
                  </div>
                </div>
                <div className="p-3 bg-zinc-900/50 rounded-lg border border-zinc-800">
                  <div className="text-[10px] text-zinc-500 uppercase font-bold mb-1">Daily Stopped</div>
                  <div className="text-emerald-500 font-black text-xl">
                    {daily?.daily_stopped?.toLocaleString() || '0'}
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between py-2 border-b border-zinc-800/50">
                  <span className="text-sm text-zinc-400">Month to Date (MTD)</span>
                  <span className="font-mono font-bold text-zinc-200">
                    {(mtd?.mtd || daily?.mtd || 0).toLocaleString()}
                  </span>
                </div>
                
                {ytd?.ytd_by_month && (
                  <div className="pt-2">
                    <div className="text-[10px] text-zinc-500 uppercase font-bold mb-2">YTD Performance (Monthly)</div>
                    <div className="flex gap-1 h-12 items-end">
                      {Object.entries(ytd.ytd_by_month).map(([month, val], i) => {
                        const max = Math.max(...Object.values(ytd.ytd_by_month || {}));
                        const height = max > 0 ? (val / max) * 100 : 0;
                        return (
                          <div 
                            key={month} 
                            className="flex-1 bg-gold-500/20 rounded-t-sm hover:bg-gold-500/50 transition-all relative group/bar"
                            style={{ height: `${Math.max(height, 5)}%` }}
                          >
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover/bar:block z-10">
                              <div className="bg-zinc-900 border border-zinc-800 text-[10px] px-2 py-1 rounded whitespace-nowrap">
                                {month}: {val.toLocaleString()}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
