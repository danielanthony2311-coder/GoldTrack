import React, { useEffect, useState } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell
} from 'recharts';
import { ArrowUpRight, ArrowDownRight, Database, Info, Loader2, Bug, ChevronDown, ChevronUp, AlertCircle, RefreshCw, Layers } from 'lucide-react';
import { cn } from '../utils/cn';

interface StockData {
  date: string;
  registered_oz: number;
  eligible_oz: number;
  total_oz: number;
  daily_change_registered: number;
  daily_change_eligible: number;
  delta_label?: string;
}

interface VaultData {
  vault: string;
  registered_oz: number;
  eligible_oz: number;
}

export default function WarehouseStocks() {
  const [metal, setMetal] = useState<'GOLD' | 'SILVER'>('GOLD');
  const [data, setData] = useState<StockData[]>([]);
  const [vaultData, setVaultData] = useState<VaultData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  const fetchData = async (signal?: AbortSignal) => {
    try {
      // Fetch history (which now includes all rows from DB)
      const response = await fetch(`/api/history?metal=${metal}`, { signal });
      if (!response.ok) throw new Error(`History API error! status: ${response.status}`);

      const history = await response.json();

      if (!Array.isArray(history)) throw new Error('History data is not an array');

      const formattedData = history.map((h: any) => ({
        date: h.date,
        registered_oz: h.registered_oz,
        eligible_oz: h.eligible_oz,
        total_oz: h.total_oz,
        daily_change_registered: h.daily_change_registered,
        daily_change_eligible: h.daily_change_eligible,
        delta_label: h.delta_label
      }));

      setData(formattedData);
      setLastUpdated(new Date());
      setError(null);

      // Fetch vault breakdown
      const vaultRes = await fetch(`/api/cme/vault-breakdown?metal=${metal}`, { signal });
      if (vaultRes.ok) {
        const vaults = await vaultRes.json();
        setVaultData(vaults);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      console.error(err);
      setError(err.message || 'Failed to fetch warehouse stocks');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch('/api/cme/sync');
      const result = await response.json();
      
      setDebugInfo(result);
      
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'CME Sync failed');
      }
      
      await fetchData();
    } catch (err: any) {
      console.error(err);
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    const interval = setInterval(() => fetchData(controller.signal), 5 * 60 * 1000); // 5 minutes
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [metal]);

  if (loading && data.length === 0) {
    return (
      <div className="glass-card p-12 flex flex-col items-center justify-center space-y-4">
        <Loader2 className="w-8 h-8 text-gold-500 animate-spin" />
        <p className="text-zinc-400 animate-pulse">Loading live warehouse data...</p>
      </div>
    );
  }

  const latest = data[data.length - 1];
  const conversionFactor = metal === 'GOLD' ? 32150.7 : 32150.7; // Both are oz per tonne
  const totalTonnes = latest ? (latest.total_oz / conversionFactor).toFixed(2) : '0';

  // FIX 1: Dynamic Y-axis scale
  const allValues = data.flatMap(d => [d.registered_oz, d.total_oz]);
  const minValue = allValues.length > 0 ? Math.min(...allValues) - 500000 : 0;
  const maxValue = allValues.length > 0 ? Math.max(...allValues) + 500000 : 35000000;

  const isOldData = latest && new Date(latest.date).toDateString() !== new Date().toDateString();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-10 h-10 rounded-xl flex items-center justify-center transition-colors",
            metal === 'GOLD' ? "bg-gold-500/10" : "bg-zinc-500/10"
          )}>
            <Database className={cn("w-6 h-6", metal === 'GOLD' ? "text-gold-500" : "text-zinc-400")} />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight">Live Warehouse Stocks</h2>
            <p className="text-xs text-zinc-500 uppercase tracking-widest font-semibold">
              COMEX {metal === 'GOLD' ? 'Gold' : 'Silver'} Inventory (Ounces)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Metal Toggle */}
          <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800 mr-2">
            <button 
              onClick={() => setMetal('GOLD')}
              className={cn(
                "px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all",
                metal === 'GOLD' ? "bg-gold-500 text-black shadow-sm" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              Gold
            </button>
            <button 
              onClick={() => setMetal('SILVER')}
              className={cn(
                "px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all",
                metal === 'SILVER' ? "bg-zinc-700 text-zinc-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              Silver
            </button>
          </div>

          <button 
            onClick={handleRefresh}
            disabled={refreshing}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-100",
              refreshing && "opacity-50 cursor-not-allowed"
            )}
          >
            {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {refreshing ? 'Syncing...' : 'Sync CME'}
          </button>
          <button 
            onClick={() => setShowDebug(!showDebug)}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all",
              showDebug ? "bg-gold-500 text-black" : "bg-zinc-900 text-zinc-500 border border-zinc-800 hover:text-zinc-300"
            )}
          >
            <Bug className="w-3 h-3" />
            Debug
            {showDebug ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {isOldData && (
        <div className="bg-amber-500/10 border border-amber-500/20 p-3 rounded-lg flex items-center gap-3">
          <Info className="w-4 h-4 text-amber-500" />
          <p className="text-xs text-amber-500 font-medium">
            Note: Displaying last known data from {latest.date}. CME reports for today may not be published yet.
          </p>
        </div>
      )}

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/20 p-3 rounded-lg flex items-center gap-3">
          <AlertCircle className="w-4 h-4 text-rose-500" />
          <p className="text-xs text-rose-500 font-medium">Error: {error}</p>
        </div>
      )}

      {/* Debug Panel */}
      {showDebug && (
        <div className="glass-card border-gold-500/30 bg-gold-500/5 p-6 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="flex items-center gap-2 mb-4 text-gold-500">
            <Bug className="w-4 h-4" />
            <h3 className="text-sm font-bold uppercase tracking-wider">Data Diagnostics</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-black/40 p-3 rounded-lg border border-zinc-800">
              <p className="text-[10px] text-zinc-500 uppercase font-bold mb-1">Records Found</p>
              <p className="text-lg font-mono text-zinc-100">{data.length}</p>
            </div>
            <div className="bg-black/40 p-3 rounded-lg border border-zinc-800">
              <p className="text-[10px] text-zinc-500 uppercase font-bold mb-1">Latest Record Date</p>
              <p className="text-lg font-mono text-zinc-100">{latest?.date || 'N/A'}</p>
            </div>
            <div className="bg-black/40 p-3 rounded-lg border border-zinc-800">
              <p className="text-[10px] text-zinc-500 uppercase font-bold mb-1">API Status</p>
              <p className={cn("text-lg font-mono", error ? "text-rose-500" : "text-emerald-500")}>
                {error ? 'ERROR' : 'OK'}
              </p>
            </div>
          </div>
          
          {debugInfo && (
            <div className="mb-6 space-y-2">
              <p className="text-[10px] text-zinc-500 uppercase font-bold">Latest Sync Debug Info</p>
              <div className="bg-black/40 p-4 rounded-xl border border-zinc-800 text-[10px] font-mono">
                <p className="text-zinc-400">Excel Row Count: {debugInfo.debug?.rowCount}</p>
                {debugInfo.error && <p className="text-rose-500 mt-2">Error Detail: {debugInfo.error}</p>}
                {debugInfo.debug?.lastRows && (
                  <div className="mt-2">
                    <p className="text-gold-500 mb-1">Last 5 Rows Sample:</p>
                    <pre className="text-[9px] opacity-70 overflow-x-auto max-h-[150px]">
                      {JSON.stringify(debugInfo.debug.lastRows, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-[10px] text-zinc-500 uppercase font-bold">Raw JSON Payload (Latest 5)</p>
            <pre className="bg-black/60 p-4 rounded-xl border border-zinc-800 text-[10px] font-mono text-emerald-400/80 overflow-x-auto max-h-[200px] overflow-y-auto">
              {JSON.stringify([...data].reverse().slice(0, 5), null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StockMetricCard 
          title="Registered Stocks"
          value={latest?.registered_oz.toLocaleString() || '0'}
          change={latest?.daily_change_registered || 0}
          deltaLabel={latest?.delta_label}
          description="Available for immediate delivery"
          source="Source: CME Warehouse Report"
        />
        <StockMetricCard 
          title="Eligible Stocks"
          value={latest?.eligible_oz.toLocaleString() || '0'}
          change={latest?.daily_change_eligible || 0}
          deltaLabel={latest?.delta_label}
          description="In storage, not for delivery"
          source="Source: CME Warehouse Report"
        />
        <StockMetricCard 
          title="Total Stocks"
          value={latest?.total_oz.toLocaleString() || '0'}
          subValue={`${totalTonnes} Tonnes`}
          description="Combined vault inventory"
          source="Source: CME Warehouse Report"
        />
      </div>

      {/* Trend Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 glass-card p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-semibold text-lg">30-Day Inventory Trend</h3>
            <div className="flex items-center gap-4 text-[10px] font-bold uppercase">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 bg-gold-500 rounded-full" />
                <span className="text-zinc-400">Registered</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 bg-zinc-600 rounded-full" />
                <span className="text-zinc-400">Total</span>
              </div>
            </div>
          </div>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                <XAxis 
                  dataKey="date" 
                  stroke="#71717a" 
                  fontSize={10} 
                  tickLine={false} 
                  axisLine={false}
                  tickFormatter={(val) => new Date(val).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                />
                <YAxis 
                  stroke="#71717a" 
                  fontSize={10} 
                  tickLine={false} 
                  axisLine={false}
                  tickFormatter={(val) => `${(val / 1000000).toFixed(1)}M`}
                  domain={[minValue, maxValue]}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                  itemStyle={{ fontSize: '12px' }}
                  labelStyle={{ color: '#71717a', marginBottom: '4px', fontSize: '10px' }}
                />
                <Line 
                  type="monotone" 
                  dataKey="registered_oz" 
                  name="Registered"
                  stroke="#D4AF37" 
                  strokeWidth={2} 
                  dot={true}
                  r={3}
                  activeDot={{ r: 5, strokeWidth: 0 }}
                />
                <Line 
                  type="monotone" 
                  dataKey="total_oz" 
                  name="Total"
                  stroke="#3f3f46" 
                  strokeWidth={2} 
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Vault Breakdown */}
        <div className="glass-card p-6">
          <div className="flex items-center gap-2 mb-6">
            <Layers className="w-4 h-4 text-gold-500" />
            <h3 className="font-semibold text-lg">Vault Breakdown by Depository</h3>
          </div>
          <div className="h-[300px] w-full">
            {vaultData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={vaultData} layout="vertical" margin={{ left: -20, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={false} />
                  <XAxis type="number" hide />
                  <YAxis 
                    dataKey="vault" 
                    type="category" 
                    stroke="#71717a" 
                    fontSize={8} 
                    tickLine={false} 
                    axisLine={false}
                    width={100}
                    tickFormatter={(val) => val.length > 15 ? val.substring(0, 15) + '...' : val}
                  />
                  <Tooltip 
                    cursor={{ fill: '#27272a' }}
                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                    formatter={(value: any) => [value.toLocaleString() + ' oz', '']}
                  />
                  <Bar dataKey="registered_oz" name="Registered" fill="#D4AF37" stackId="a" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="eligible_oz" name="Eligible" fill="#3f3f46" stackId="a" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-2">
                <Database className="w-8 h-8 text-zinc-800" />
                <p className="text-xs text-zinc-500 uppercase font-bold tracking-widest">Sync CME to load vault data</p>
              </div>
            )}
          </div>
          <div className="mt-4 pt-4 border-t border-zinc-800">
            <p className="text-[9px] text-zinc-600 uppercase font-bold tracking-wider">Source: CME Warehouse Report</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StockMetricCard({ title, value, change, subValue, description, source, deltaLabel }: any) {
  const isPositive = change > 0;
  return (
    <div className="glass-card p-6 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-zinc-400 text-sm font-medium">{title}</span>
        {change !== undefined && (
          <div className="flex flex-col items-end">
            <div className={cn(
              "flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full",
              isPositive ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
            )}>
              {isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
              {Math.abs(change).toLocaleString()}
            </div>
            {deltaLabel && (
              <span className="text-[8px] text-zinc-500 uppercase font-bold mt-1">{deltaLabel}</span>
            )}
          </div>
        )}
      </div>
      <div className="text-2xl font-black text-zinc-100 tracking-tight">
        {value}
      </div>
      {subValue && (
        <div className="text-sm font-bold text-gold-500/80">
          {subValue}
        </div>
      )}
      <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">{description}</p>
      {source && (
        <div className="pt-2 mt-2 border-t border-zinc-800/50">
          <p className="text-[9px] text-zinc-600 uppercase font-bold tracking-wider">{source}</p>
        </div>
      )}
    </div>
  );
}
