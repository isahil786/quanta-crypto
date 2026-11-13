import React, { useState, useEffect } from 'react';
import {
  Layers,
  Wallet,
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  XCircle,
} from 'lucide-react';

export default function Positions({ accounts, activeAccountId }) {
  const [allPositions, setPositions] = useState([]);
  const [allHoldings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [scope, setScope] = useState('active'); // 'active' | 'all'

  const activeAccount = accounts.find((a) => a.id === activeAccountId) || accounts[0];
  const isCoinSwitchSpot = activeAccount?.broker === 'coinswitch' && activeAccount?.segment === 'SPOT';

  const fetchData = async () => {
    setLoading(true);
    try {
      const [posRes, holdRes] = await Promise.all([
        fetch('/api/positions'),
        fetch('/api/holdings'),
      ]);
      if (posRes.ok) setPositions(await posRes.json());
      if (holdRes.ok) setHoldings(await holdRes.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    fetchData();
    const interval = setInterval(() => {
      if (!isMounted) return;
      fetchData();
    }, 4000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleClosePosition = async (posId, symbol) => {
    try {
      const res = await fetch(`/api/positions/${posId}/close`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to close position');
      setNotice({
        type: 'success',
        text: data.message || `Position on ${symbol} closed.`,
      });
      fetchData();
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    }
  };

  const inScope = (x) => scope === 'all' || x.accountId === activeAccount?.id;
  const positions = allPositions.filter(inScope);
  const holdings = allHoldings.filter(inScope);
  const accountName = (id) => accounts.find((a) => a.id === id)?.accountName || id;
  const scopedAccounts = scope === 'all' ? accounts : accounts.filter((a) => a.id === activeAccount?.id);

  // Aggregate Portfolio Stats
  // Account equity reflects fees and realised PnL; holdings alone stay at the starting balance
  const totalHoldingsValue = scopedAccounts.reduce((sum, a) => sum + (a.totalEquityUSDT || 0), 0);
  const totalUnrealizedPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);

  return (
    <div className="flex flex-col gap-6">
      {/* Scope toggle */}
      <div className="flex items-center justify-end gap-1 text-xs">
        <span className="text-slate-500 mr-1">Show:</span>
        {[['active', 'Active account'], ['all', 'All accounts']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setScope(id)}
            className={`px-3 py-1 rounded-md border transition-colors ${
              scope === id ? 'bg-slate-800 text-emerald-400 border-slate-700' : 'text-slate-400 border-transparent hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* KPI Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Total Crypto Portfolio</span>
            <Wallet className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 text-xl font-bold font-mono text-white tabular-nums">
            ${totalHoldingsValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <span className="text-[11px] text-slate-500 mt-1">Paper equity ({scope === 'all' ? `${accounts.length} accounts` : 'active account'})</span>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Unrealized Futures PnL</span>
            <Layers className="w-4 h-4 text-cyan-400" />
          </div>
          <div className={`mt-2 text-xl font-bold font-mono tabular-nums flex items-center gap-1.5 ${
            totalUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
          }`}>
            {totalUnrealizedPnl >= 0 ? '+' : ''}${totalUnrealizedPnl.toFixed(2)}
          </div>
          <span className="text-[11px] text-slate-500 mt-1">Delta & CoinDCX Positions</span>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Open Futures Contracts</span>
            <Layers className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-2 text-xl font-bold font-mono text-white tabular-nums">
            {positions.length} Active
          </div>
          <span className="text-[11px] text-slate-500 mt-1">Perpetual Swap & Margin</span>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Primary Active Account</span>
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
          </div>
          <div className="mt-2 text-sm font-bold text-slate-200 truncate">
            {activeAccount?.accountName}
          </div>
          <span className="text-[11px] text-slate-500 mt-1 font-mono">
            {activeAccount?.broker?.toUpperCase()} ({activeAccount?.segment})
          </span>
        </div>
      </div>

      {/* Notice alert */}
      {notice && (
        <div
          className={`px-4 py-3 rounded-lg text-xs flex items-center justify-between border ${
            notice.type === 'success'
              ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800'
              : 'bg-rose-950/40 text-rose-300 border-rose-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {notice.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{notice.text}</span>
          </div>
          <button onClick={() => setNotice(null)} className="text-slate-400 hover:text-white">✕</button>
        </div>
      )}

      {/* Section 1: Open Futures & Margin Positions */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-xs font-semibold text-white">Active Perpetual Positions</h2>
            <p className="text-[11px] text-slate-400">
              Contract positions with real-time mark-to-market valuations and liquidation safeguards.
            </p>
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-1.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Capability Banner if CoinSwitch Spot is active */}
        {isCoinSwitchSpot && (
          <div className="p-3 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>
              <strong>CoinSwitch Spot Notice:</strong> Spot accounts hold physical crypto assets (shown below in Spot Portfolio) and do not support perpetual futures positions. To view or open leveraged positions, select <strong>Delta India Futures</strong> or <strong>CoinDCX Prime</strong> from the top bar.
            </span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-500 font-medium border-b border-slate-800 text-[11px]">
              <tr>
                <th className="py-2.5 px-4">Contract / Exchange</th>
                <th className="py-2.5 px-4">Side</th>
                <th className="py-2.5 px-4 text-right">Size</th>
                <th className="py-2.5 px-4 text-right">Entry Price</th>
                <th className="py-2.5 px-4 text-right">Mark Price</th>
                <th className="py-2.5 px-4 text-right">Liq. Price</th>
                <th className="py-2.5 px-4 text-right">Margin (Lev.)</th>
                <th className="py-2.5 px-4 text-right">Unrealized PnL</th>
                <th className="py-2.5 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-slate-500 font-sans">
                    No active positions{scope === 'active' ? ' for this account' : ''}. Place a leveraged order on Delta Exchange or CoinDCX to open one.
                  </td>
                </tr>
              ) : (
                positions.map((pos) => {
                  const isPositive = pos.unrealizedPnl >= 0;
                  return (
                    <tr key={pos.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 px-4 font-sans">
                        <div className="font-bold text-white">{pos.symbol}</div>
                        <div className="text-[11px] text-slate-400">{scope === 'all' ? accountName(pos.accountId) : <span className="capitalize">{pos.broker}</span>}</div>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          pos.side === 'LONG' ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'
                        }`}>
                          {pos.side}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right text-slate-200">{pos.size}</td>
                      <td className="py-3 px-4 text-right text-slate-200">
                        ${pos.entryPrice?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 px-4 text-right text-white font-semibold">
                        ${pos.markPrice?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 px-4 text-right text-amber-400">
                        ${pos.liquidationPrice?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 px-4 text-right text-slate-300">
                        ${pos.margin?.toLocaleString(undefined, { minimumFractionDigits: 2 })} ({pos.leverage}x)
                        {pos.fundingPaidUSDT ? (
                          <div className={`text-[10px] ${pos.fundingPaidUSDT > 0 ? 'text-rose-300' : 'text-emerald-300'}`} title="Cumulative funding on this position (negative = received)">
                            Funding {pos.fundingPaidUSDT > 0 ? '-' : '+'}${Math.abs(pos.fundingPaidUSDT).toFixed(4)}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className={`font-bold ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {isPositive ? '+' : ''}${pos.unrealizedPnl?.toFixed(2)}
                        </div>
                        <div className={`text-[10px] ${isPositive ? 'text-emerald-500' : 'text-rose-500'}`}>
                          ({isPositive ? '+' : ''}{pos.pnlPercent}%)
                        </div>
                      </td>
                      <td className="py-3 px-4 text-center font-sans">
                        <button
                          onClick={() => handleClosePosition(pos.id, pos.symbol)}
                          className="px-2.5 py-1 text-[11px] bg-slate-800 hover:bg-rose-950/80 hover:text-rose-300 hover:border-rose-800 text-slate-300 rounded border border-slate-700 transition-colors"
                        >
                          Market Close
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 2: Spot Holdings & Multi-Exchange Balances */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-xs font-semibold text-white">Spot Holdings & Exchange Balances</h2>
            <p className="text-[11px] text-slate-400">
              CoinSwitch spot portfolio, Delta wallet balance, and CoinDCX coin reserves.
            </p>
          </div>
          <span className="text-[11px] text-slate-500 font-mono">
            Total Value: ${totalHoldingsValue.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDT
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-500 font-medium border-b border-slate-800 text-[11px]">
              <tr>
                <th className="py-2.5 px-4">Asset</th>
                <th className="py-2.5 px-4">Exchange / Account</th>
                <th className="py-2.5 px-4 text-right">Available Free</th>
                <th className="py-2.5 px-4 text-right">Locked in Orders</th>
                <th className="py-2.5 px-4 text-right">Total Quantity</th>
                <th className="py-2.5 px-4 text-right">Market Rate (USDT)</th>
                <th className="py-2.5 px-4 text-right">Est. Value (USDT)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
              {holdings.map((h, idx) => (
                <tr key={`${h.broker}-${h.asset}-${idx}`} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-3 px-4 font-sans font-bold text-white flex items-center gap-2">
                    <span className="w-6 h-6 rounded bg-slate-800 flex items-center justify-center text-[10px] text-slate-300">
                      {h.asset}
                    </span>
                    <span>{h.name}</span>
                  </td>
                  <td className="py-3 px-4 font-sans text-slate-300">{scope === 'all' ? accountName(h.accountId) : <span className="capitalize">{h.broker}</span>}</td>
                  <td className="py-3 px-4 text-right text-slate-200">{h.free.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right text-slate-500">{h.locked.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right text-white font-semibold">{h.total.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right text-slate-400">
                    ${h.rateUSDT < 0.01 ? h.rateUSDT.toFixed(6) : h.rateUSDT.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td className="py-3 px-4 text-right text-emerald-400 font-bold">
                    ${h.valueUSDT.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
