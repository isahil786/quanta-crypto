import React, { useState, useEffect } from 'react';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Filter,
  PieChart,
} from 'lucide-react';

export default function PnLDashboard({ accounts, activeAccountId }) {
  const [positions, setPositions] = useState([]);
  const [trades, setTrades] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState('7d'); // 1d, 7d, 30d, all

  const fetchData = async () => {
    try {
      const [pRes, tRes, hRes] = await Promise.all([
        fetch('/api/positions'),
        fetch('/api/trades'),
        fetch('/api/holdings'),
      ]);
      if (pRes.ok) setPositions(await pRes.json());
      if (tRes.ok) setTrades(await tRes.json());
      if (hRes.ok) setHoldings(await hRes.json());
    } catch (err) {
      console.error('P&L fetch failed', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, 5000);
    return () => clearInterval(iv);
  }, []);

  const pnlColor = (v) => (v >= 0 ? 'text-emerald-400' : 'text-rose-400');
  const pnlBg = (v) => (v >= 0 ? 'bg-emerald-500/10' : 'bg-rose-500/10');
  const pnlBorder = (v) => (v >= 0 ? 'border-emerald-500/20' : 'border-rose-500/20');

  const now = Date.now();
  const rangeStart = dateRange === 'all' ? 0 : now - Number(dateRange.replace('d', '')) * 86400000;

  const filteredTrades = trades.filter((t) => {
    if (!t.timestamp) return true;
    return new Date(t.timestamp).getTime() >= rangeStart;
  });

  const realizedPnl = filteredTrades.reduce((sum, t) => sum + Number(t.realizedPnl || 0), 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + Number(p.unrealizedPnl || 0), 0);
  const totalPnl = realizedPnl + unrealizedPnl;
  const totalHoldingsValue = holdings.reduce((sum, h) => sum + Number(h.valueUSDT || h.total || 0), 0);

  // Per-symbol breakdown
  const symbolMap = new Map();
  positions.forEach((p) => {
    const key = p.symbol;
    if (!symbolMap.has(key)) symbolMap.set(key, { symbol: key, realized: 0, unrealized: 0, size: 0, avgPrice: 0 });
    const s = symbolMap.get(key);
    s.unrealized += Number(p.unrealizedPnl || 0);
    s.size += Number(p.size || 0);
  });
  filteredTrades.forEach((t) => {
    const key = t.symbol;
    if (!symbolMap.has(key)) symbolMap.set(key, { symbol: key, realized: 0, unrealized: 0, size: 0, avgPrice: 0 });
    const s = symbolMap.get(key);
    s.realized += Number(t.realizedPnl || 0);
  });

  const symbolRows = Array.from(symbolMap.values());

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">P&L Dashboard</h1>
          <p className="text-sm text-slate-400">Realized vs unrealized profit & loss across all accounts and symbols.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-emerald-500"
          >
            <option value="1d">1 Day</option>
            <option value="7d">7 Days</option>
            <option value="30d">30 Days</option>
            <option value="all">All Time</option>
          </select>
          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 border border-slate-700 rounded-lg hover:text-white hover:border-slate-600 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <span className="text-slate-400">Loading P&L data…</span>
        </div>
      )}

      {!loading && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">Total Portfolio Value</p>
                  <p className="text-xl font-bold text-white">${totalHoldingsValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                </div>
                <PieChart className="w-6 h-6 text-slate-500" />
              </div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">Realized P&L ({dateRange})</p>
                  <p className={`text-xl font-bold ${pnlColor(realizedPnl)}`}>
                    {realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}
                  </p>
                </div>
                <DollarSign className="w-6 h-6 text-emerald-400" />
              </div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">Unrealized P&L</p>
                  <p className={`text-xl font-bold ${pnlColor(unrealizedPnl)}`}>
                    {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
                  </p>
                </div>
                <TrendingUp className="w-6 h-6 text-emerald-400" />
              </div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">Total P&L</p>
                  <p className={`text-2xl font-bold ${pnlColor(totalPnl)}`}>
                    {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
                  </p>
                </div>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${pnlBg(totalPnl)} ${pnlBorder(totalPnl)}`}>
                  {totalPnl >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                </div>
              </div>
            </div>
          </div>

          {/* Per-Symbol Breakdown */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-white flex items-center gap-2">
                <Filter className="w-3.5 h-3.5" />
                Per-Symbol Breakdown ({symbolRows.length} symbols)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950 text-slate-500 font-medium border-b border-slate-800 text-[11px]">
                  <tr>
                    <th className="py-3 px-4">Symbol</th>
                    <th className="py-3 px-4 text-right">Realized P&L</th>
                    <th className="py-3 px-4 text-right">Unrealized P&L</th>
                    <th className="py-3 px-4 text-right">Total P&L</th>
                    <th className="py-3 px-4 text-right">Size</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {symbolRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-400">
                        No position or trade data for the selected period.
                      </td>
                    </tr>
                  ) : (
                    symbolRows.map((s) => {
                      const total = s.realized + s.unrealized;
                      return (
                        <tr key={s.symbol} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 px-4 font-sans font-bold text-white">{s.symbol}</td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            <span className={`${pnlColor(s.realized)}`}>
                              {s.realized >= 0 ? '+' : ''}${s.realized.toFixed(2)}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            <span className={`${pnlColor(s.unrealized)}`}>
                              {s.unrealized >= 0 ? '+' : ''}${s.unrealized.toFixed(2)}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-bold font-mono tabular-nums">
                            <span className={`${pnlColor(total)}`}>
                              {total >= 0 ? '+' : ''}${total.toFixed(2)}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-400">
                            {s.size.toFixed(6)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent Trades */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-white flex items-center gap-2">
                <Clock className="w-3.5 h-3.5" />
                Recent Trades ({filteredTrades.length})
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950 text-slate-500 font-medium border-b border-slate-800 text-[11px]">
                  <tr>
                    <th className="py-3 px-4">Timestamp</th>
                    <th className="py-3 px-4">Symbol</th>
                    <th className="py-3 px-4">Side</th>
                    <th className="py-3 px-4 text-right">Price</th>
                    <th className="py-3 px-4 text-right">Size</th>
                    <th className="py-3 px-4 text-right">Realized P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                  {filteredTrades.slice().reverse().slice(0, 20).map((t) => (
                    <tr key={t.id || t.orderId} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-2.5 px-4 text-slate-400 text-[11px]">
                        {t.timestamp ? new Date(t.timestamp).toLocaleString() : '—'}
                      </td>
                      <td className="py-2.5 px-4 font-bold text-slate-200">{t.symbol}</td>
                      <td className="py-2.5 px-4">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          t.side === 'BUY' ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'
                        }`}>
                          {t.side}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        ${Number(t.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-2.5 px-4 text-right">{Number(t.size || 0).toFixed(6)}</td>
                      <td className="py-2.5 px-4 text-right">
                        <span className={`${pnlColor(Number(t.realizedPnl || 0))} font-bold`}>
                          {Number(t.realizedPnl || 0) >= 0 ? '+' : ''}${Number(t.realizedPnl || 0).toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {filteredTrades.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-400">
                        No trades in the selected period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
