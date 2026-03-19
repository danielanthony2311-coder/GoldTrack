import React, { useState, useEffect } from 'react';
import { 
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { ArrowUpRight, ArrowDownRight, Info, ShieldAlert, Zap, Loader2 } from 'lucide-react';
import { COMEX_METRICS, generateStockHistory, TOP_BUYERS, DIVERGENCE_INDEX } from '../data/mockData';
import { cn } from '../utils/cn';
import WarehouseStocks from '../components/WarehouseStocks';

const stockData = generateStockHistory(90);

export default function Dashboard() {
  const [metal, setMetal] = useState<'GOLD' | 'SILVER'>('GOLD');
  const [buyerType, setBuyerType] = useState<'stopped' | 'issued'>('stopped');
  const [dailyDeliveries, setDailyDeliveries] = useState<number | null>(null);
  const [firmData, setFirmData] = useState<{ firm: string, amount: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasFirmData, setHasFirmData] = useState(false);

  const [latestStocks, setLatestStocks] = useState<any>(null);
  const [settlementPrice, setSettlementPrice] = useState<number | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        // Fetch Latest Stocks
        const stocksRes = await fetch(`/api/cme/latest-stocks?metal=${metal}`);
        const stocksData = await stocksRes.json();
        if (stocksData && stocksData.length > 0) {
          setLatestStocks(stocksData[stocksData.length - 1]);
        }

        // Fetch Daily Deliveries and Settlement
        const summaryRes = await fetch(`/api/cme/summary?metal=${metal}&type=DAILY`);
        const summaryData = await summaryRes.json();
        if (summaryData && summaryData.length > 0) {
          const latest = summaryData[0];
          setDailyDeliveries(latest.daily_stopped || 0);
          setSettlementPrice(latest.settlement || null);
        }

        // Fetch Firm Data
        const noticesRes = await fetch(`/api/cme/latest-notices?metal=${metal}`);
        const noticesData = await noticesRes.json();
        if (noticesData && noticesData.length > 0) {
          // Filter out vault operators if they accidentally appear
          const vaultOperators = ["BRINK'S", "HSBC", "JP MORGAN CHASE", "MANFRA", "MALCA-AMIT", "DELAWARE DEPOSITORY"];
          const filtered = noticesData.filter((n: any) => !vaultOperators.some(v => n.firm.toUpperCase().includes(v)));
          
          const displayData = filtered
            .map((item: any) => ({
              name: item.firm,
              amount: buyerType === 'stopped' ? item.stopped : item.issued
            }))
            .filter((item: any) => item.amount > 0)
            .sort((a: any, b: any) => b.amount - a.amount)
            .slice(0, 5);
          
          setFirmData(displayData);
          setHasFirmData(displayData.length > 0);
        } else {
          setHasFirmData(false);
        }
      } catch (e) {
        console.error('Failed to fetch dashboard data', e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [buyerType, metal]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Market Overview</h1>
          <p className="text-zinc-400">Real-time COMEX and Central Bank analytics.</p>
        </div>
        
        <div className="flex items-center gap-6">
          {/* Metal Toggle */}
          <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800">
            <button 
              onClick={() => setMetal('GOLD')}
              className={cn(
                "px-4 py-1.5 text-xs font-bold rounded-md transition-all",
                metal === 'GOLD' ? "bg-gold-500 text-black shadow-sm" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              Gold
            </button>
            <button 
              onClick={() => setMetal('SILVER')}
              className={cn(
                "px-4 py-1.5 text-xs font-bold rounded-md transition-all",
                metal === 'SILVER' ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              Silver
            </button>
          </div>

          {/* Settlement Price Display */}
          <div className="flex flex-col">
            <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">{metal} Settlement</span>
            <div className="flex items-center gap-2">
              <span className={cn(
                "text-2xl font-black",
                metal === 'GOLD' ? "text-gold-500" : "text-zinc-100"
              )}>
                {settlementPrice ? `$${settlementPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
              </span>
              <div className="flex items-center text-zinc-500 text-[10px] font-bold uppercase tracking-tighter">
                <span>Source: CME Daily Report</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Live Warehouse Stocks Section */}
      <WarehouseStocks />

      {/* Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <MetricCard 
          title={`Daily Deliveries (${metal})`}
          value={loading ? '...' : `${dailyDeliveries || 0} Contracts`}
          trend={dailyDeliveries && dailyDeliveries > 100 ? "High" : "Normal"}
          isPositive={dailyDeliveries ? dailyDeliveries > 100 : false}
          description={`Total ${metal.toLowerCase()} contracts delivered today`}
          color={dailyDeliveries && dailyDeliveries > 100 ? (metal === 'GOLD' ? 'text-amber-500' : 'text-zinc-300') : 'text-zinc-100'}
          source="Source: CME MTD PDF (Daily Total)"
        />
        <MetricCard 
          title={`Registered Stocks (${metal})`}
          value={latestStocks ? `${(latestStocks.registered_oz / 1000000).toFixed(2)}M oz` : '...'}
          trend={latestStocks && latestStocks.daily_change_registered !== null && latestStocks.daily_change_registered !== undefined ? `${(latestStocks.daily_change_registered / 1000).toFixed(1)}k` : '—'}
          isPositive={latestStocks?.daily_change_registered > 0}
          description={`Physical ${metal.toLowerCase()} available for immediate delivery`}
          source="Source: CME Warehouse Report"
        />
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 gap-6">
        {/* Buyers Bar Chart */}
        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex flex-col">
              <h3 className="font-semibold text-lg">
                {buyerType === 'stopped' ? 'Top Institutional Buyers' : 'Top Institutional Sellers'}
              </h3>
              <span className="text-xs text-zinc-500">
                {buyerType === 'stopped' ? 'Contracts Stopped (Taking Delivery)' : 'Contracts Issued (Making Delivery)'}
              </span>
            </div>
            
            {/* Issued vs Stopped Toggle */}
            <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800">
              <button 
                onClick={() => setBuyerType('stopped')}
                className={cn(
                  "px-3 py-1 text-xs font-bold rounded-md transition-all",
                  buyerType === 'stopped' ? "bg-gold-500 text-black shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                Buyers
              </button>
              <button 
                onClick={() => setBuyerType('issued')}
                className={cn(
                  "px-3 py-1 text-xs font-bold rounded-md transition-all",
                  buyerType === 'issued' ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                Sellers
              </button>
            </div>
          </div>
          
          <div className="h-[300px] w-full flex flex-col items-center justify-center">
            {loading ? (
              <Loader2 className="w-6 h-6 text-gold-500 animate-spin" />
            ) : hasFirmData ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={firmData} layout="vertical" margin={{ left: 20, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={false} />
                  <XAxis type="number" hide />
                  <YAxis 
                    dataKey="name" 
                    type="category" 
                    stroke="#71717a" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false}
                    width={100}
                  />
                  <Tooltip 
                    cursor={{ fill: '#27272a' }}
                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                  />
                  <Bar 
                    dataKey="amount" 
                    fill={buyerType === 'stopped' ? "#f59e0b" : "#3f3f46"} 
                    radius={[0, 4, 4, 0]} 
                    barSize={20} 
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center space-y-2">
                <Info className="w-8 h-8 text-zinc-600 mx-auto" />
                <p className="text-sm text-zinc-500">Upload Daily Issues PDF to see firm data</p>
              </div>
            )}
          </div>
          
          {buyerType === 'stopped' && hasFirmData && firmData.some(d => d.amount > 500) && (
            <div className="mt-4 p-3 bg-gold-500/10 border border-gold-500/20 rounded-lg flex items-center gap-3">
              <ShieldAlert className="w-4 h-4 text-gold-500" />
              <p className="text-xs text-gold-500 font-medium">
                Significant institutional buying detected. Strong physical demand signal.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ title, value, trend, isPositive, description, color, source }: any) {
  return (
    <div className="glass-card p-6 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-zinc-400 text-sm font-medium">{title}</span>
        <div className={cn(
          "flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full",
          isPositive ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
        )}>
          {isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
          {trend}
        </div>
      </div>
      <div className={cn("text-3xl font-bold tracking-tight", color)}>
        {value}
      </div>
      <p className="text-xs text-zinc-500 leading-relaxed">{description}</p>
      {source && (
        <div className="pt-2 mt-2 border-t border-zinc-800/50">
          <p className="text-[9px] text-zinc-600 uppercase font-bold tracking-wider">{source}</p>
        </div>
      )}
    </div>
  );
}

function AlertItem({ type, title, message, icon }: any) {
  const colors = {
    danger: "border-rose-500/20 bg-rose-500/5 text-rose-500",
    warning: "border-amber-500/20 bg-amber-500/5 text-amber-500",
    info: "border-blue-500/20 bg-blue-500/5 text-blue-500",
    success: "border-emerald-500/20 bg-emerald-500/5 text-emerald-500",
  };
  
  return (
    <div className={cn("p-4 rounded-xl border flex gap-4", colors[type as keyof typeof colors])}>
      {icon && <div className="mt-0.5">{icon}</div>}
      <div className="flex-1">
        <h4 className="font-bold text-sm mb-1">{title}</h4>
        <p className="text-sm opacity-80">{message}</p>
      </div>
    </div>
  );
}
