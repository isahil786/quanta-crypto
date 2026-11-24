import React, { useState, useEffect } from 'react';
import { useConfirm } from '../ui/Confirm.jsx';
import DataTable from '../ui/DataTable.jsx';
import {
  Layers,
  Wallet,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';

export default function Positions({ accounts, activeAccountId }) {
  const [allPositions, setPositions] = useState([]);
  const [allHoldings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [scope, setScope] = useState('active'); // 'active' | 'all'

  const confirm = useConfirm();
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
    if (!(await confirm({ title: `Close ${symbol} position?`, subtitle: 'The whole position is closed at market.', rows: [['Pair', symbol]], confirmLabel: 'Close position', live: activeAccount?.mode === 'REAL' }))) return;
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

        <DataTable
          rows={positions}
          empty={`No active positions${scope === 'active' ? ' for this account' : ''}. Place a leveraged order on Delta Exchange or CoinDCX to open one.`}
          columns={[
            { key: 'symbol', header: 'Contract / Exchange', primary: true, mono: false, render: (r) => (
              <div className="font-sans">
                <div className="font-semibold text-ink">{r.symbol}</div>
                <div className="text-xs text-muted">{scope === 'all' ? accountName(r.accountId) : <span className="capitalize">{r.broker}</span>}</div>
              </div>
            ) },
            { key: 'side', header: 'Side', mono: false, render: (r) => (
              <span className={`rounded px-2 py-0.5 text-xs font-bold ${r.side === 'LONG' ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>
                {r.side === 'LONG' ? '▲ LONG' : '▼ SHORT'}
              </span>
            ) },
            { key: 'size', header: 'Size', align: 'right' },
            { key: 'entryPrice', header: 'Entry', align: 'right', render: (r) => `$${r.entryPrice?.toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
            { key: 'markPrice', header: 'Mark', align: 'right', render: (r) => `$${r.markPrice?.toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
            { key: 'liquidationPrice', header: 'Liquidation', align: 'right', render: (r) => <span className="text-live">${r.liquidationPrice?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span> },
            { key: 'margin', header: 'Margin (Lev.)', align: 'right', render: (r) => (
              <>
                ${r.margin?.toLocaleString(undefined, { minimumFractionDigits: 2 })} ({r.leverage}x)
                {r.fundingPaidUSDT ? (
                  <div className={`text-xs ${r.fundingPaidUSDT > 0 ? 'text-down' : 'text-up'}`} title="Cumulative funding on this position (negative = received)">
                    Funding {r.fundingPaidUSDT > 0 ? '-' : '+'}${Math.abs(r.fundingPaidUSDT).toFixed(4)}
                  </div>
                ) : null}
              </>
            ) },
            { key: 'unrealizedPnl', header: 'Unrealized P&L', align: 'right', render: (r) => (
              <span className={r.unrealizedPnl >= 0 ? 'text-up' : 'text-down'}>
                <b>{r.unrealizedPnl >= 0 ? '+' : ''}${r.unrealizedPnl?.toFixed(2)}</b>
                <span className="ml-1 text-xs">({r.unrealizedPnl >= 0 ? '+' : ''}{r.pnlPercent}%)</span>
              </span>
            ) },
            { key: 'action', header: 'Action', align: 'center', actions: true, mono: false, render: (r) => (
              <button
                onClick={() => handleClosePosition(r.id, r.symbol)}
                className="w-full rounded-lg border border-line bg-raised px-3 py-1.5 text-xs font-semibold text-ink hover:border-down hover:text-down md:w-auto"
              >
                Close position
              </button>
            ) },
          ]}
        />
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
        <DataTable
          rows={holdings}
          rowKey={(h) => `${h.accountId}-${h.broker}-${h.asset}`}
          empty="No balances on this account yet."
          columns={[
            { key: 'asset', header: 'Asset', primary: true, mono: false, render: (h) => (
              <span className="flex items-center gap-2 font-semibold text-ink">
                <span className="grid size-6 place-items-center rounded bg-raised text-xs text-ink2">{h.asset}</span>
                {h.name}
              </span>
            ) },
            { key: 'account', header: 'Exchange / Account', mono: false, render: (h) => (scope === 'all' ? accountName(h.accountId) : <span className="capitalize">{h.broker}</span>) },
            { key: 'free', header: 'Available', align: 'right', render: (h) => h.free.toLocaleString() },
            { key: 'locked', header: 'Locked in orders', align: 'right', render: (h) => <span className="text-muted">{h.locked.toLocaleString()}</span> },
            { key: 'total', header: 'Total', align: 'right', render: (h) => h.total.toLocaleString() },
            { key: 'rate', header: 'Rate (USDT)', align: 'right', render: (h) => <span className="text-muted">${h.rateUSDT < 0.01 ? h.rateUSDT.toFixed(6) : h.rateUSDT.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span> },
            { key: 'value', header: 'Value (USDT)', align: 'right', render: (h) => <b className="text-up">${h.valueUSDT.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> },
          ]}
        />
      </div>
    </div>
  );
}
