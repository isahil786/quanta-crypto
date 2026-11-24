import React, { useState, useEffect } from 'react';
import DataTable from '../ui/DataTable.jsx';
import {
  RefreshCw,
  Filter,
  Clock,
} from 'lucide-react';

export default function PnLDashboard() {
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
      if (tRes.ok) {
        const tData = await tRes.json();
        setTrades(Array.isArray(tData) ? tData : tData.trades);
      }
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

  // Headline stats for the selected period
  const closed = filteredTrades.filter((t) => Number(t.realizedPnl || 0) !== 0);
  const grossWin = closed.filter((t) => t.realizedPnl > 0).reduce((a, t) => a + Number(t.realizedPnl), 0);
  const grossLoss = Math.abs(closed.filter((t) => t.realizedPnl < 0).reduce((a, t) => a + Number(t.realizedPnl), 0));
  const winRate = closed.length ? Math.round((closed.filter((t) => t.realizedPnl > 0).length / closed.length) * 100) : null;
  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : grossWin > 0 ? '∞' : null;
  const feesPaid = filteredTrades.reduce((a, t) => a + Number(t.fee || 0), 0);
  const curve = (() => {
    let run = 0;
    return filteredTrades.slice().sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0)).map((t) => { run += Number(t.realizedPnl || 0); return run; });
  })();
  const maxDrawdown = (() => {
    let peak = 0; let dd = 0;
    curve.forEach((v) => { peak = Math.max(peak, v); dd = Math.min(dd, v - peak); });
    return dd;
  })();
  const chartPoints = (() => {
    if (curve.length < 2) return '';
    const lo = Math.min(0, ...curve); const hi = Math.max(0, ...curve); const span = hi - lo || 1;
    return curve.map((v, i) => `${(i / (curve.length - 1)) * 1000},${150 - ((v - lo) / span) * 140 - 5}`).join(' ');
  })();
  const fmt = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-6">
      {/* Header with range chips */}
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div>
          <h1 className="text-2xl font-semibold text-ink">P&L</h1>
          <p className="text-sm text-muted">How you did, across all accounts and symbols.</p>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Period" className="flex gap-1 rounded-xl border border-line bg-surface p-1">
            {[['1d', '1D'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']].map(([v, l]) => (
              <button key={v} onClick={() => setDateRange(v)} aria-pressed={dateRange === v} className={`rounded-lg px-3 py-1 font-mono text-xs ${dateRange === v ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>{l}</button>
            ))}
          </div>
          <button onClick={fetchData} className="flex items-center gap-1.5 rounded-xl border border-line bg-raised px-3 py-1.5 text-xs font-semibold text-ink">
            <RefreshCw className="size-3" /> Refresh
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
          {/* Answer first: one headline number, the curve, then key stats */}
          <section className="rounded-xl border border-line bg-surface p-5">
            <p className="text-xs text-muted">{dateRange === 'all' ? 'All time' : `Last ${dateRange.replace('d', '')} day${dateRange === '1d' ? '' : 's'}`}</p>
            <p className={`mt-1 font-mono text-4xl font-semibold ${totalPnl >= 0 ? 'text-up' : 'text-down'}`}>
              {totalPnl >= 0 ? '▲ ' : '▼ '}{fmt(totalPnl)}
            </p>
            <p className="mt-1 text-xs text-muted">Realized {fmt(realizedPnl)} · Unrealized {fmt(unrealizedPnl)}</p>
            <div className="mt-4" role="img" aria-label="Cumulative realized P&L for the period">
              {chartPoints ? (
                <svg viewBox="0 0 1000 150" preserveAspectRatio="none" className="h-40 w-full">
                  <line x1="0" x2="1000" y1="145" y2="145" stroke="currentColor" className="text-line" />
                  <polyline points={chartPoints} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" className={totalPnl >= 0 ? 'stroke-up' : 'stroke-down'} />
                </svg>
              ) : (
                <div className="grid h-24 place-items-center text-sm text-muted">Not enough closed trades in this period to draw a curve.</div>
              )}
            </div>
          </section>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            {[
              ['Portfolio value', `$${totalHoldingsValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 'text-ink'],
              ['Win rate', winRate === null ? '—' : `${winRate}%`, 'text-ink'],
              ['Profit factor', profitFactor ?? '—', 'text-ink'],
              ['Max drawdown', fmt(maxDrawdown), maxDrawdown < 0 ? 'text-down' : 'text-ink'],
              ['Fees paid', `$${feesPaid.toFixed(2)}`, 'text-ink'],
            ].map(([label, value, tone]) => (
              <div key={label} className="rounded-xl border border-line bg-surface p-4">
                <p className="text-xs text-muted">{label}</p>
                <p className={`mt-1 font-mono text-lg font-semibold ${tone}`}>{value}</p>
              </div>
            ))}
          </div>

          {/* Per-Symbol Breakdown */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-white flex items-center gap-2">
                <Filter className="w-3.5 h-3.5" />
                Per-Symbol Breakdown ({symbolRows.length} symbols)
              </span>
            </div>
            <DataTable
              rows={symbolRows}
              rowKey={(s) => s.symbol}
              empty="No position or trade data for the selected period."
              columns={[
                { key: 'symbol', header: 'Symbol', primary: true, mono: false, render: (s) => <b className="text-ink">{s.symbol}</b> },
                { key: 'realized', header: 'Realized P&L', align: 'right', render: (s) => <span className={pnlColor(s.realized)}>{s.realized >= 0 ? '+' : ''}${s.realized.toFixed(2)}</span> },
                { key: 'unrealized', header: 'Unrealized P&L', align: 'right', render: (s) => <span className={pnlColor(s.unrealized)}>{s.unrealized >= 0 ? '+' : ''}${s.unrealized.toFixed(2)}</span> },
                { key: 'total', header: 'Total P&L', align: 'right', render: (s) => { const t = s.realized + s.unrealized; return <b className={pnlColor(t)}>{t >= 0 ? '+' : ''}${t.toFixed(2)}</b>; } },
                { key: 'size', header: 'Size', align: 'right', render: (s) => <span className="text-muted">{s.size.toFixed(6)}</span> },
              ]}
            />
          </div>

          {/* Recent Trades */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-white flex items-center gap-2">
                <Clock className="w-3.5 h-3.5" />
                Recent Trades ({filteredTrades.length})
              </span>
            </div>
            <DataTable
              rows={filteredTrades.slice().reverse().slice(0, 20)}
              rowKey={(t) => t.id || t.orderId}
              empty="No trades in the selected period."
              columns={[
                { key: 'symbol', header: 'Symbol', primary: true, render: (t) => <b className="text-ink">{t.symbol}</b> },
                { key: 'timestamp', header: 'Time', render: (t) => <span className="text-xs text-muted">{t.timestamp ? new Date(t.timestamp).toLocaleString() : '—'}</span> },
                { key: 'side', header: 'Side', mono: false, render: (t) => <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${t.side === 'BUY' ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>{t.side === 'BUY' ? '▲' : '▼'} {t.side}</span> },
                { key: 'price', header: 'Price', align: 'right', render: (t) => `$${Number(t.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
                { key: 'size', header: 'Size', align: 'right', render: (t) => Number(t.size || 0).toFixed(6) },
                { key: 'realizedPnl', header: 'Realized P&L', align: 'right', render: (t) => { const v = Number(t.realizedPnl || 0); return <b className={pnlColor(v)}>{v >= 0 ? '+' : ''}${v.toFixed(2)}</b>; } },
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}
