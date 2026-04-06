import React, { useEffect, useState } from 'react';
import { Upload, Download, Filter, ChevronRight, AlertCircle, RefreshCw, Loader2, Info } from 'lucide-react';
import { cn } from '../utils/cn';
import HistoricalComparisonChart from '../components/HistoricalComparisonChart';
import DeliveryPace from '../components/DeliveryPace';
import MetalsSummary from '../components/MetalsSummary';
import InstitutionalActivity from '../components/InstitutionalActivity';

interface DeliveryNotice {
  id: number;
  date: string;
  firm: string;
  issued: number;
  stopped: number;
  metal: string;
  account_type: string;
}

export default function ComexDetails() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncType, setSyncType] = useState<'DAILY' | 'MTD' | 'YTD'>('DAILY');
  const [selectedMetal, setSelectedMetal] = useState<string>('GOLD');
  const [dailyData, setDailyData] = useState<any>(null);
  const [mtdData, setMtdData] = useState<any[]>([]);
  const [ytdData, setYtdData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch summary data which contains MTD and YTD info
      const summaryRes = await fetch(`/api/cme/summary?metal=${selectedMetal}`);
      if (summaryRes.ok) {
        const summaries = await summaryRes.json();
        setMtdData(summaries.filter((s: any) => s.report_type === 'MTD'));
        setYtdData(summaries.filter((s: any) => s.report_type === 'YTD'));
      }

      // Fetch latest daily notices
      const dailyRes = await fetch(`/api/cme/latest-notices?metal=${selectedMetal}`);
      if (dailyRes.ok) {
        const notices = await dailyRes.json();
        // Group notices by metal to match the structure expected by Big Movers
        const firms: any = {};
        notices.forEach((n: any) => {
          if (!firms[n.metal]) {
            firms[n.metal] = { top_stoppers: [], top_issuers: [], all_firms: [] };
          }
          firms[n.metal].all_firms.push(n);
        });

        // Calculate top issuers/stoppers per metal
        Object.keys(firms).forEach(metal => {
          const metalFirms = firms[metal].all_firms;
          const combined: any = {};
          metalFirms.forEach((f: any) => {
            if (!combined[f.firm]) combined[f.firm] = { firm: f.firm, issued: 0, stopped: 0, org: f.account_type.charAt(0) };
            combined[f.firm].issued += f.issued;
            combined[f.firm].stopped += f.stopped;
          });

          const sorted = Object.values(combined);
          firms[metal].top_issuers = [...sorted].filter((f: any) => f.issued > 0).sort((a: any, b: any) => b.issued - a.issued).slice(0, 5);
          firms[metal].top_stoppers = [...sorted].filter((f: any) => f.stopped > 0).sort((a: any, b: any) => b.stopped - a.stopped).slice(0, 5);
        });

        setDailyData({ firms, date: notices[0]?.date || 'No data' });
      }
    } catch (err: any) {
      console.error(err);
      setError('Failed to load CME data.');
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch('/api/cme/sync');
      const syncResult = await response.json();
      // Always refresh — partial syncs (e.g. silver 403) still write gold data
      await fetchData();

      if (!response.ok) throw new Error('Sync request failed');
      if (syncResult.errors?.length) {
        const detail = syncResult.errors.map((e: any) => `${e.file}: ${e.message}`).join('\n');
        setError(`Partial sync — some files failed:\n${detail}`);
      }
      setRefreshKey(prev => prev + 1);
    } catch (err: any) {
      console.error(err);
      alert('Failed to sync with CME: ' + err.message);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [selectedMetal]);

  const currentFirms = dailyData?.firms?.[selectedMetal];
  const buyers = currentFirms?.top_stoppers || [];
  const sellers = currentFirms?.top_issuers || [];
  const reportDate = dailyData?.date || 'No data';

  const metals = ['GOLD', 'SILVER'];

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">COMEX Detailed Analytics</h1>
          <p className="text-zinc-400">Deep dive into physical delivery flows and warehouse movements.</p>
        </div>
        <div className="flex items-center gap-3">
          <select 
            value={syncType}
            onChange={(e) => setSyncType(e.target.value as any)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-300 text-sm px-3 py-2 outline-none focus:border-gold-500"
          >
            <option value="DAILY">Daily Issues</option>
            <option value="MTD">MTD Report</option>
            <option value="YTD">YTD Report</option>
          </select>
          <button 
            onClick={handleSync}
            disabled={isSyncing}
            className={cn(
              "flex items-center gap-2 px-4 py-2 bg-gold-500 text-black font-bold rounded-lg hover:bg-gold-400 transition-all",
              isSyncing && "opacity-50 cursor-not-allowed"
            )}
          >
            {isSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {isSyncing ? 'Syncing...' : 'Sync CME'}
          </button>
          <button className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-400 hover:text-zinc-100">
            <Download className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Metals Summary Component */}
      <MetalsSummary key={refreshKey} />

      {/* Delivery Pace Indicator */}
      <DeliveryPace />

      {/* Historical Comparison Chart Component */}
      <HistoricalComparisonChart />

      {/* Metal Selection Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
        {metals.map(metal => (
          <button
            key={metal}
            onClick={() => setSelectedMetal(metal)}
            className={cn(
              "px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap",
              selectedMetal === metal 
                ? "bg-gold-500 text-black shadow-[0_0_15px_rgba(243,156,18,0.3)]" 
                : "bg-zinc-900 text-zinc-500 hover:text-zinc-300 border border-zinc-800"
            )}
          >
            {metal}
          </button>
        ))}
      </div>

      {syncType === 'DAILY' && (
        <>
          {/* Daily Big Movers (Institutional) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="glass-card p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-bold text-lg">Daily Big Movers: Buyers</h3>
                  <p className="text-xs text-zinc-500 uppercase tracking-widest mt-1">Institutional "Stopping" (Receiving Physical)</p>
                </div>
                <div className="bg-emerald-500/10 text-emerald-500 px-2 py-1 rounded text-[10px] font-black uppercase">
                  Physical Accumulation
                </div>
              </div>
              <div className="space-y-4">
                {loading ? (
                  <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-gold-500" /></div>
                ) : buyers.length > 0 ? (
                  buyers.map((buyer: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between p-4 bg-zinc-900/50 rounded-xl border border-zinc-800 hover:border-gold-500/30 transition-all">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-gold-500/10 rounded-lg flex items-center justify-center font-bold text-gold-500">
                          {buyer.firm.charAt(0)}
                        </div>
                        <div>
                          <h4 className="font-bold text-sm">{buyer.firm}</h4>
                          <span className="text-[10px] text-zinc-500 uppercase font-bold">
                            {buyer.org === 'C' ? 'Customer' : 'House'} Account
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-emerald-500 font-black text-lg">+{buyer.stopped}</div>
                        <div className="text-[10px] text-zinc-500 uppercase font-bold">Contracts Stopped</div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-center text-zinc-500 py-8 italic">
                    {dailyData ? `No significant buyers detected for ${selectedMetal} on ${reportDate}` : 'Sync CME to load data'}
                  </p>
                )}
              </div>
            </div>

            <div className="glass-card p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-bold text-lg">Daily Big Movers: Sellers</h3>
                  <p className="text-xs text-zinc-500 uppercase tracking-widest mt-1">Institutional "Issuing" (Delivering Physical)</p>
                </div>
                <div className="bg-rose-500/10 text-rose-500 px-2 py-1 rounded text-[10px] font-black uppercase">
                  Inventory Release
                </div>
              </div>
              <div className="space-y-4">
                {loading ? (
                  <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-gold-500" /></div>
                ) : sellers.length > 0 ? (
                  sellers.map((seller: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between p-4 bg-zinc-900/50 rounded-xl border border-zinc-800 hover:border-rose-500/30 transition-all">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-rose-500/10 rounded-lg flex items-center justify-center font-bold text-rose-500">
                          {seller.firm.charAt(0)}
                        </div>
                        <div>
                          <h4 className="font-bold text-sm">{seller.firm}</h4>
                          <span className="text-[10px] text-zinc-500 uppercase font-bold">
                            {seller.org === 'C' ? 'Customer' : 'House'} Account
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-rose-500 font-black text-lg">-{seller.issued}</div>
                        <div className="text-[10px] text-zinc-500 uppercase font-bold">Contracts Issued</div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-center text-zinc-500 py-8 italic">
                    {dailyData ? `No significant sellers detected for ${selectedMetal} on ${reportDate}` : 'Sync CME to load data'}
                  </p>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {syncType === 'MTD' && (
        <div className="glass-card overflow-hidden">
          <div className="p-6 border-b border-zinc-800">
            <h3 className="font-semibold text-lg">MTD Cumulative Deliveries: {selectedMetal}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-zinc-900/50 text-zinc-500 text-xs uppercase tracking-wider">
                  <th className="px-6 py-4 font-semibold">Date</th>
                  <th className="px-6 py-4 font-semibold text-right">Cumulative Contracts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {mtdData.filter(d => d.metal === selectedMetal).map((row, i) => (
                  <tr key={i} className="hover:bg-zinc-900/30 transition-colors">
                    <td className="px-6 py-4 text-sm font-medium text-zinc-300">{row.date}</td>
                    <td className="px-6 py-4 text-sm text-zinc-400 font-mono text-right">{row.mtd?.toLocaleString()}</td>
                  </tr>
                ))}
                {mtdData.filter(d => d.metal === selectedMetal).length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-6 py-8 text-center text-zinc-500 italic">No MTD data available. Sync MTD Report to load.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {syncType === 'YTD' && (
        <div className="glass-card overflow-hidden">
          <div className="p-6 border-b border-zinc-800">
            <h3 className="font-semibold text-lg">YTD Monthly Breakdown</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-zinc-900/50 text-zinc-500 text-xs uppercase tracking-wider">
                  <th className="px-6 py-4 font-semibold">Metal</th>
                  {["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].map(m => (
                    <th key={m} className="px-4 py-4 font-semibold text-right">{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {metals.map(metal => {
                  const data = ytdData.find(d => d.metal === metal);
                  const months = data?.ytd_by_month || {};
                  return (
                    <tr key={metal} className="hover:bg-zinc-900/30 transition-colors">
                      <td className="px-6 py-4 text-sm font-bold text-gold-500">{metal}</td>
                      {["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].map(m => (
                        <td key={m} className="px-4 py-4 text-sm text-zinc-400 font-mono text-right">
                          {months[m]?.toLocaleString() || '-'}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Institutional Activity */}
      <InstitutionalActivity metal={selectedMetal} />

      {/* Alert System */}
      <div className="bg-gold-500/10 border border-gold-500/20 p-6 rounded-2xl flex gap-4">
        <div className="w-12 h-12 bg-gold-500/20 rounded-xl flex items-center justify-center shrink-0">
          <Info className="text-gold-500 w-6 h-6" />
        </div>
        <div>
          <h4 className="text-gold-500 font-bold text-lg mb-1">CME Market Status</h4>
          <p className="text-zinc-300 text-sm leading-relaxed">
            Physical delivery flows are being monitored in real-time. Use the sync buttons above to fetch the latest 
            warehouse stocks and delivery notices directly from CME Group reports.
          </p>
        </div>
      </div>
    </div>
  );
}
