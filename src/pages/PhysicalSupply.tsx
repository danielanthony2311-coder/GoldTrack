import WarehouseStocks from '../components/WarehouseStocks';
import ETFHoldings from '../components/ETFHoldings';
import LBMAVault from '../components/LBMAVault';
import OpenInterest from '../components/OpenInterest';

export default function PhysicalSupply() {
  return (
    <div className="space-y-10">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">Physical Supply</h1>
          <p className="text-sm text-zinc-500">COMEX warehouse inventory, open interest, London vaults, and ETF holdings.</p>
        </div>
      </div>

      <OpenInterest />

      <WarehouseStocks />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ETFHoldings />
        <LBMAVault />
      </div>
    </div>
  );
}
