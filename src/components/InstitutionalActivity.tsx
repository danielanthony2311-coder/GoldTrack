import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart
} from 'recharts';
import { Upload, RefreshCw, Download, Star, ChevronDown, AlertCircle, Loader2, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '../utils/cn';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FirmActivity {
  id: number;
  report_date: string;
  month: number;
  year: number;
  firm_code: string;
  firm_name: string;
  metal: string;
  customer_issued: number;
  house_issued: number;
  total_issued: number;
  customer_stopped: number;
  house_stopped: number;
  total_stopped: number;
  net_position: number;
  is_net_buyer: boolean;
  source: string;
}

interface DailySummary {
  report_date: string;
  month: number;
  year: number;
  metal: string;
  total_contracts: number;
  total_issued: number;
  total_stopped: number;
  net_market_position: number;
  firms_count: number;
  net_buyers_count: number;
  net_sellers_count: number;
  customer_issued_pct: number | null;
  house_issued_pct: number | null;
  customer_stopped_pct: number | null;
  house_stopped_pct: number | null;
  top_buyers: FirmActivity[] | null;
  top_sellers: FirmActivity[] | null;
}

interface CompareEntry {
  firm_code: string;
  firm_name: string;
  date1_net: number;
  date2_net: number;
  change: number;
  trend: 'increasing_buy' | 'increasing_sell' | 'unchanged';
  is_new: boolean;
  is_exited: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const KEY_FIRMS = ['JP MORGAN', 'BARCLAYS', 'DEUTSCHE', 'BOFA', 'MORGAN STANLEY', 'GOLDMAN', 'SCOTIA', 'WELLS FARGO', 'BNP', 'BMO'];

function netColor(net: number) {
  if (net > 2000) return 'text-green-400';
  if (net > 500)  return 'text-green-300';
  if (net < -2000) return 'text-red-400';
  if (net < -500)  return 'text-red-300';
  return 'text-gray-400';
}

function netBg(net: number) {
  if (net > 2000) return 'bg-green-900/40 border border-green-700/40';
  if (net > 500)  return 'bg-green-900/20 border border-green-800/30';
  if (net < -2000) return 'bg-red-900/40 border border-red-700/40';
  if (net < -500)  return 'bg-red-900/20 border border-red-800/30';
  return 'bg-zinc-800/40 border border-zinc-700/30';
}

function NetIcon({ net }: { net: number }) {
  if (net > 0) return <TrendingUp size={14} className="text-green-400" />;
  if (net < 0) return <TrendingDown size={14} className="text-red-400" />;
  return <Minus size={14} className="text-gray-500" />;
}

function fmt(n: number | null | undefined) {
  if (n == null) return '—';
  return n.toLocaleString();
}

function pct(n: number | null | undefined) {
  if (n == null) return '—';
  return `${Number(n).toFixed(1)}%`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

type AccountFilter = 'ALL' | 'CUSTOMER' | 'HOUSE';

function FirmTable({
  firms, totalContracts, filter, showWatchlist, watchlist, onStar, side
}: {
  firms: FirmActivity[];
  totalContracts: number;
  filter: AccountFilter;
  showWatchlist: boolean;
  watchlist: Set<string>;
  onStar: (code: string) => void;
  side: 'buyers' | 'sellers';
}) {
  let displayFirms = firms;
  if (showWatchlist) displayFirms = firms.filter(f => watchlist.has(f.firm_code));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-zinc-700/50">
            <th className="py-2 px-2 text-left w-6"></th>
            <th className="py-2 px-2 text-left">Firm</th>
            {filter !== 'HOUSE' && <th className="py-2 px-3 text-right">Customer</th>}
            {filter !== 'CUSTOMER' && <th className="py-2 px-3 text-right">House</th>}
            <th className="py-2 px-3 text-right">Net</th>
            <th className="py-2 px-3 text-right">% of Mkt</th>
          </tr>
        </thead>
        <tbody>
          {displayFirms.length === 0 && (
            <tr><td colSpan={6} className="py-8 text-center text-gray-500 text-xs">No data</td></tr>
          )}
          {displayFirms.map(f => {
            const stopped = filter === 'CUSTOMER' ? f.customer_stopped : filter === 'HOUSE' ? f.house_stopped : f.total_stopped;
            const issued  = filter === 'CUSTOMER' ? f.customer_issued  : filter === 'HOUSE' ? f.house_issued  : f.total_issued;
            const net = stopped - issued;
            const share = totalContracts > 0 ? ((Math.abs(net) / totalContracts) * 100).toFixed(1) : '0.0';
            const isKey = KEY_FIRMS.some(k => f.firm_name.toUpperCase().includes(k));
            return (
              <tr key={f.firm_code} className={cn('border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors', netBg(net), 'rounded')}>
                <td className="py-2 px-2">
                  <button onClick={() => onStar(f.firm_code)} className="opacity-50 hover:opacity-100 transition-opacity">
                    <Star size={12} className={watchlist.has(f.firm_code) ? 'fill-yellow-400 text-yellow-400' : 'text-gray-600'} />
                  </button>
                </td>
                <td className="py-2 px-2">
                  <span className={cn('font-medium text-xs', isKey ? 'text-gold-400' : 'text-gray-200')}>
                    {f.firm_name}
                  </span>
                  <span className="ml-1 text-[10px] text-gray-600">{f.firm_code}</span>
                </td>
                {filter !== 'HOUSE' && (
                  <td className="py-2 px-3 text-right text-xs text-gray-400">{fmt(side === 'buyers' ? f.customer_stopped : f.customer_issued)}</td>
                )}
                {filter !== 'CUSTOMER' && (
                  <td className="py-2 px-3 text-right text-xs text-gray-400">{fmt(side === 'buyers' ? f.house_stopped : f.house_issued)}</td>
                )}
                <td className={cn('py-2 px-3 text-right text-xs font-bold', netColor(net))}>
                  {net > 0 ? '+' : ''}{fmt(net)}
                </td>
                <td className="py-2 px-3 text-right text-xs text-gray-500">{share}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function InstitutionalActivity({ metal = 'GOLD' }: { metal?: string }) {
  const [activeTab, setActiveTab] = useState<'overview' | 'traders' | 'historical' | 'comparison'>('overview');
  const [latestData, setLatestData] = useState<FirmActivity[]>([]);
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [latestDate, setLatestDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Top traders state
  const [accountFilter, setAccountFilter] = useState<AccountFilter>('ALL');
  const [showWatchlist, setShowWatchlist] = useState(false);
  const [watchlist, setWatchlist] = useState<Set<string>>(() => new Set(['661', '148', '709', '099', '624', '657', '072', '435', '363', '555', '190']));

  // Historical state
  const [selectedFirm, setSelectedFirm] = useState<string>('');
  const [firmHistory, setFirmHistory] = useState<FirmActivity[]>([]);
  const [firmLoading, setFirmLoading] = useState(false);

  // Comparison state
  const [cmpDate1, setCmpDate1] = useState('');
  const [cmpDate2, setCmpDate2] = useState('');
  const [comparison, setComparison] = useState<CompareEntry[]>([]);
  const [cmpLoading, setCmpLoading] = useState(false);

  const fetchLatest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cme/institutional/latest?metal=${metal}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      setLatestData(json.data || []);
      setSummary(json.summary || null);
      setLatestDate(json.date || null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [metal]);

  useEffect(() => { fetchLatest(); }, [fetchLatest]);

  // Export CSV
  const exportCsv = () => {
    if (!latestData.length) return;
    const headers = 'Firm Code,Firm Name,Customer Issued,House Issued,Total Issued,Customer Stopped,House Stopped,Total Stopped,Net Position\n';
    const rows = latestData.map(f =>
      `${f.firm_code},"${f.firm_name}",${f.customer_issued},${f.house_issued},${f.total_issued},${f.customer_stopped},${f.house_stopped},${f.total_stopped},${f.net_position}`
    ).join('\n');
    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `institutional_activity_${latestDate || 'export'}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  // Upload handler
  const handleUpload = async (file: File) => {
    if (!file.name.endsWith('.pdf')) {
      setUploadMsg({ type: 'error', text: 'Only PDF files are supported.' }); return;
    }
    setUploading(true); setUploadMsg(null);
    try {
      const fd = new FormData();
      fd.append('pdf', file);
      const res = await fetch('/api/cme/institutional/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      setUploadMsg({ type: 'success', text: `Inserted ${json.recordsInserted} records for ${json.date} (${json.metal})` });
      fetchLatest();
    } catch (e: any) {
      setUploadMsg({ type: 'error', text: e.message });
    } finally {
      setUploading(false);
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  };

  // Firm history fetch
  const loadFirmHistory = async (name: string) => {
    if (!name) return;
    setFirmLoading(true);
    try {
      const res = await fetch(`/api/cme/institutional/firm/${encodeURIComponent(name)}?days=60&metal=${metal}`);
      const json = await res.json();
      setFirmHistory(json);
    } catch { setFirmHistory([]); }
    finally { setFirmLoading(false); }
  };

  useEffect(() => {
    if (selectedFirm) loadFirmHistory(selectedFirm);
  }, [selectedFirm, metal]);

  // Comparison fetch
  const runComparison = async () => {
    if (!cmpDate1 || !cmpDate2) return;
    setCmpLoading(true);
    try {
      const res = await fetch(`/api/cme/institutional/compare?date1=${cmpDate1}&date2=${cmpDate2}&metal=${metal}`);
      const json = await res.json();
      setComparison(json.comparison || []);
    } catch { setComparison([]); }
    finally { setCmpLoading(false); }
  };

  const toggleStar = (code: string) => {
    setWatchlist(prev => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  };

  // Derived
  const buyers = [...latestData].sort((a, b) => b.net_position - a.net_position);
  const sellers = [...latestData].sort((a, b) => a.net_position - b.net_position);
  const totalContracts = summary?.total_contracts || 1;

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'traders', label: 'Top Traders' },
    { key: 'historical', label: 'Historical' },
    { key: 'comparison', label: 'Comparison' },
  ] as const;

  return (
    <div className="glass-card p-6 mt-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg font-semibold text-white">Institutional Trading Activity</h2>
          {latestDate && (
            <p className="text-xs text-gray-500 mt-0.5">
              Latest data: <span className="text-gold-400">{latestDate}</span>
              {summary && <> · {summary.firms_count} firms</>}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={fetchLatest} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-gray-300 transition-colors">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button onClick={exportCsv} disabled={!latestData.length} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-gray-300 transition-colors disabled:opacity-40">
            <Download size={12} /> Export CSV
          </button>
          {/* Upload zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={onDrop}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 text-xs rounded cursor-pointer transition-colors border',
              isDragOver ? 'bg-gold-500/20 border-gold-500' : 'bg-zinc-800 border-zinc-700 hover:border-gold-600'
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} className="text-gold-400" />}
            <span className="text-gray-300">Upload YTD PDF</span>
            <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={onFileChange} />
          </div>
        </div>
      </div>

      {/* Upload message */}
      {uploadMsg && (
        <div className={cn('mb-4 px-4 py-2.5 rounded text-xs flex items-center gap-2',
          uploadMsg.type === 'success' ? 'bg-green-900/30 text-green-300 border border-green-700/30' : 'bg-red-900/30 text-red-300 border border-red-700/30'
        )}>
          <AlertCircle size={13} />
          {uploadMsg.text}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-zinc-700/50 pb-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={cn('px-4 py-2 text-xs font-medium rounded-t transition-colors -mb-px border-b-2',
              activeTab === t.key
                ? 'text-gold-400 border-gold-500'
                : 'text-gray-500 border-transparent hover:text-gray-300'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading / Error states */}
      {loading && (
        <div className="flex items-center justify-center py-16 text-gray-500 gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading institutional data…</span>
        </div>
      )}

      {!loading && error && (
        <div className="flex items-center gap-2 py-8 text-red-400 text-sm">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {!loading && !error && !latestDate && (
        <div className="py-12 text-center text-gray-500 text-sm">
          <Upload size={32} className="mx-auto mb-3 opacity-30" />
          <p>No institutional data yet.</p>
          <p className="text-xs mt-1">Upload a CME YTD PDF report to get started.</p>
        </div>
      )}

      {/* ── OVERVIEW TAB ────────────────────────────────────────────────────── */}
      {!loading && !error && latestDate && activeTab === 'overview' && (
        <div className="space-y-5">
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Net Market Position', value: summary?.net_market_position, signed: true },
              { label: 'Total Contracts', value: summary?.total_contracts },
              { label: 'Net Buyers', value: summary?.net_buyers_count, suffix: ' firms' },
              { label: 'Net Sellers', value: summary?.net_sellers_count, suffix: ' firms' },
            ].map(card => {
              const val = card.value ?? null;
              const signed = card.signed && val != null;
              const color = signed ? (val! > 0 ? 'text-green-400' : val! < 0 ? 'text-red-400' : 'text-gray-400') : 'text-white';
              return (
                <div key={card.label} className="bg-zinc-900/60 rounded-lg p-4 border border-zinc-700/40">
                  <p className="text-xs text-gray-500 mb-1">{card.label}</p>
                  <p className={cn('text-xl font-bold', color)}>
                    {val == null ? '—' : `${signed && val > 0 ? '+' : ''}${fmt(val)}${card.suffix || ''}`}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Market direction */}
          {summary && (
            <div className={cn('rounded-lg p-4 border flex items-center gap-3',
              summary.net_market_position > 0 ? 'bg-green-900/20 border-green-700/30' : 'bg-red-900/20 border-red-700/30'
            )}>
              {summary.net_market_position > 0
                ? <TrendingUp size={20} className="text-green-400" />
                : <TrendingDown size={20} className="text-red-400" />}
              <div>
                <p className={cn('text-sm font-semibold', summary.net_market_position > 0 ? 'text-green-300' : 'text-red-300')}>
                  Market is net {summary.net_market_position > 0 ? 'BUYING' : 'SELLING'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {summary.net_buyers_count} buyers vs {summary.net_sellers_count} sellers · {pct(summary.customer_issued_pct)} customer issued · {pct(summary.house_issued_pct)} house issued
                </p>
              </div>
            </div>
          )}

          {/* Customer vs House breakdown */}
          {summary && (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-zinc-900/60 rounded-lg p-4 border border-zinc-700/40">
                <p className="text-xs text-gray-500 mb-3">Issues Breakdown</p>
                <div className="space-y-2">
                  {[
                    { label: 'Customer Issued', pct: summary.customer_issued_pct, val: summary.total_issued * (summary.customer_issued_pct || 0) / 100, color: 'bg-blue-500' },
                    { label: 'House Issued', pct: summary.house_issued_pct, val: summary.total_issued * (summary.house_issued_pct || 0) / 100, color: 'bg-orange-500' },
                  ].map(row => (
                    <div key={row.label}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-400">{row.label}</span>
                        <span className="text-gray-300">{pct(row.pct)}</span>
                      </div>
                      <div className="h-1.5 bg-zinc-700 rounded-full">
                        <div className={cn('h-full rounded-full', row.color)} style={{ width: `${row.pct || 0}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-zinc-900/60 rounded-lg p-4 border border-zinc-700/40">
                <p className="text-xs text-gray-500 mb-3">Stops Breakdown</p>
                <div className="space-y-2">
                  {[
                    { label: 'Customer Stopped', pct: summary.customer_stopped_pct, color: 'bg-blue-500' },
                    { label: 'House Stopped', pct: summary.house_stopped_pct, color: 'bg-orange-500' },
                  ].map(row => (
                    <div key={row.label}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-400">{row.label}</span>
                        <span className="text-gray-300">{pct(row.pct)}</span>
                      </div>
                      <div className="h-1.5 bg-zinc-700 rounded-full">
                        <div className={cn('h-full rounded-full', row.color)} style={{ width: `${row.pct || 0}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TOP TRADERS TAB ─────────────────────────────────────────────────── */}
      {!loading && !error && latestDate && activeTab === 'traders' && (
        <div>
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="flex rounded overflow-hidden border border-zinc-700">
              {(['ALL', 'CUSTOMER', 'HOUSE'] as AccountFilter[]).map(f => (
                <button key={f} onClick={() => setAccountFilter(f)}
                  className={cn('px-3 py-1.5 text-xs transition-colors',
                    accountFilter === f ? 'bg-gold-600/30 text-gold-300' : 'text-gray-500 hover:text-gray-300'
                  )}>
                  {f}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowWatchlist(!showWatchlist)}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors',
                showWatchlist ? 'bg-yellow-900/30 border-yellow-600/40 text-yellow-300' : 'border-zinc-700 text-gray-500 hover:text-gray-300'
              )}>
              <Star size={12} className={showWatchlist ? 'fill-yellow-400 text-yellow-400' : ''} />
              Watchlist
            </button>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <div>
              <h3 className="text-xs font-semibold text-green-400 mb-2 flex items-center gap-1">
                <TrendingUp size={13} /> Top 10 Net Buyers
              </h3>
              <FirmTable firms={buyers.slice(0, 10)} totalContracts={totalContracts} filter={accountFilter} showWatchlist={showWatchlist} watchlist={watchlist} onStar={toggleStar} side="buyers" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-red-400 mb-2 flex items-center gap-1">
                <TrendingDown size={13} /> Top 10 Net Sellers
              </h3>
              <FirmTable firms={sellers.slice(0, 10)} totalContracts={totalContracts} filter={accountFilter} showWatchlist={showWatchlist} watchlist={watchlist} onStar={toggleStar} side="sellers" />
            </div>
          </div>
        </div>
      )}

      {/* ── HISTORICAL TAB ──────────────────────────────────────────────────── */}
      {!loading && !error && latestDate && activeTab === 'historical' && (
        <div>
          <div className="flex items-center gap-3 mb-5">
            <label className="text-xs text-gray-400">Select firm:</label>
            <div className="relative">
              <select
                value={selectedFirm}
                onChange={e => setSelectedFirm(e.target.value)}
                className="appearance-none bg-zinc-800 border border-zinc-700 text-gray-300 text-xs rounded px-3 py-1.5 pr-7 focus:outline-none focus:border-gold-600"
              >
                <option value="">— choose a firm —</option>
                {([...new Map(latestData.map(f => [f.firm_code, f])).values()] as FirmActivity[]).map(f => (
                  <option key={f.firm_code} value={f.firm_name}>{f.firm_name} ({f.firm_code})</option>
                ))}
              </select>
              <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
            </div>
            {firmLoading && <Loader2 size={14} className="animate-spin text-gray-500" />}
          </div>

          {!selectedFirm && (
            <p className="text-sm text-gray-500 py-8 text-center">Select a firm to view historical activity.</p>
          )}

          {selectedFirm && !firmLoading && firmHistory.length === 0 && (
            <p className="text-sm text-gray-500 py-8 text-center">No historical data for this firm in the last 60 days.</p>
          )}

          {selectedFirm && firmHistory.length > 0 && (() => {
            const chartData = [...firmHistory].reverse().map(f => ({
              date: f.report_date,
              net: f.net_position,
              customer_stopped: f.customer_stopped,
              house_stopped: f.house_stopped,
              customer_issued: f.customer_issued,
              house_issued: f.house_issued,
              total: f.total_issued + f.total_stopped,
            }));
            return (
              <div className="space-y-5">
                <div>
                  <p className="text-xs text-gray-500 mb-2">Net Position (last 60 days)</p>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#71717a' }} tickFormatter={d => d.slice(5)} />
                      <YAxis tick={{ fontSize: 10, fill: '#71717a' }} />
                      <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 11 }} labelStyle={{ color: '#a1a1aa' }} />
                      <Line type="monotone" dataKey="net" stroke="#F39C12" strokeWidth={2} dot={false} name="Net Position" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-2">Customer vs House Activity</p>
                  <ResponsiveContainer width="100%" height={180}>
                    <AreaChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#71717a' }} tickFormatter={d => d.slice(5)} />
                      <YAxis tick={{ fontSize: 10, fill: '#71717a' }} />
                      <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Area type="monotone" dataKey="customer_stopped" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.4} name="Customer Stopped" />
                      <Area type="monotone" dataKey="house_stopped" stackId="1" stroke="#f97316" fill="#f97316" fillOpacity={0.4} name="House Stopped" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-2">Daily Total Contracts</p>
                  <ResponsiveContainer width="100%" height={130}>
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#71717a' }} tickFormatter={d => d.slice(5)} />
                      <YAxis tick={{ fontSize: 10, fill: '#71717a' }} />
                      <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 11 }} />
                      <Bar dataKey="total" fill="#F39C12" fillOpacity={0.7} name="Total Contracts" radius={[2,2,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── COMPARISON TAB ──────────────────────────────────────────────────── */}
      {!loading && !error && latestDate && activeTab === 'comparison' && (
        <div>
          <div className="flex flex-wrap items-center gap-3 mb-5">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400">Date 1:</label>
              <input type="date" value={cmpDate1} onChange={e => setCmpDate1(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 text-gray-300 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-gold-600" />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400">Date 2:</label>
              <input type="date" value={cmpDate2} onChange={e => setCmpDate2(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 text-gray-300 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-gold-600" />
            </div>
            <button
              onClick={runComparison}
              disabled={!cmpDate1 || !cmpDate2 || cmpLoading}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-gold-600/20 border border-gold-600/40 text-gold-300 rounded hover:bg-gold-600/30 transition-colors disabled:opacity-40"
            >
              {cmpLoading ? <Loader2 size={12} className="animate-spin" /> : null}
              Compare
            </button>
          </div>

          {comparison.length === 0 && !cmpLoading && (
            <p className="text-sm text-gray-500 py-8 text-center">Select two dates and click Compare.</p>
          )}

          {comparison.length > 0 && (() => {
            const biggest = comparison.slice(0, 20);
            const newFirms = comparison.filter(c => c.is_new);
            const exited = comparison.filter(c => c.is_exited);
            const topGain = comparison.filter(c => c.change > 0).slice(0, 5);
            const topLoss = comparison.filter(c => c.change < 0).slice(0, 5);
            return (
              <div className="space-y-5">
                {/* Summary cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: 'New Firms', value: newFirms.length, color: 'text-green-400' },
                    { label: 'Exited Firms', value: exited.length, color: 'text-red-400' },
                    { label: 'Biggest Gainer', value: topGain[0]?.firm_name?.split(' ')[0] || '—', color: 'text-green-300' },
                    { label: 'Biggest Loser', value: topLoss[0]?.firm_name?.split(' ')[0] || '—', color: 'text-red-300' },
                  ].map(c => (
                    <div key={c.label} className="bg-zinc-900/60 rounded-lg p-3 border border-zinc-700/40">
                      <p className="text-xs text-gray-500 mb-1">{c.label}</p>
                      <p className={cn('text-base font-semibold', c.color)}>{c.value}</p>
                    </div>
                  ))}
                </div>

                {/* Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-zinc-700/50">
                        <th className="py-2 px-2 text-left">Firm</th>
                        <th className="py-2 px-3 text-right">{cmpDate1} Net</th>
                        <th className="py-2 px-3 text-right">{cmpDate2} Net</th>
                        <th className="py-2 px-3 text-right">Change</th>
                        <th className="py-2 px-3 text-center">Trend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {biggest.map(c => (
                        <tr key={c.firm_code} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                          <td className="py-2 px-2">
                            <span className="text-gray-200 font-medium">{c.firm_name}</span>
                            {c.is_new && <span className="ml-1 text-[9px] bg-green-900/50 text-green-400 px-1 rounded">NEW</span>}
                            {c.is_exited && <span className="ml-1 text-[9px] bg-red-900/50 text-red-400 px-1 rounded">EXITED</span>}
                          </td>
                          <td className={cn('py-2 px-3 text-right', netColor(c.date1_net))}>{fmt(c.date1_net)}</td>
                          <td className={cn('py-2 px-3 text-right', netColor(c.date2_net))}>{fmt(c.date2_net)}</td>
                          <td className={cn('py-2 px-3 text-right font-semibold', c.change > 0 ? 'text-green-400' : c.change < 0 ? 'text-red-400' : 'text-gray-500')}>
                            {c.change > 0 ? '+' : ''}{fmt(c.change)}
                          </td>
                          <td className="py-2 px-3 text-center">
                            {c.trend === 'increasing_buy' && <TrendingUp size={13} className="text-green-400 mx-auto" />}
                            {c.trend === 'increasing_sell' && <TrendingDown size={13} className="text-red-400 mx-auto" />}
                            {c.trend === 'unchanged' && <Minus size={13} className="text-gray-500 mx-auto" />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
