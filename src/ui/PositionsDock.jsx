import React, { useCallback, useEffect, useState } from 'react';
import DataTable from './DataTable.jsx';
import { useConfirm } from './Confirm.jsx';
import { useToast } from './Toast.jsx';

/** Open positions and open orders for one account, without leaving the Terminal. */
export default function PositionsDock({ accountId, isLive = false, className = '' }) {
  const [tab, setTab] = useState('positions');
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const confirm = useConfirm();
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [p, o] = await Promise.all([fetch('/api/positions'), fetch('/api/orders?page=1&limit=100')]);
      if (p.ok) setPositions(await p.json());
      if (o.ok) { const d = await o.json(); setOrders(Array.isArray(d) ? d : d.orders || []); }
    } catch { /* keep the last data on a failed poll */ } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const mine = (x) => !x.accountId || x.accountId === accountId;
  const myPositions = positions.filter(mine);
  const myOrders = orders.filter(mine).filter((o) => o.status === 'OPEN');

  const closePosition = async (r) => {
    if (!(await confirm({ title: `Close ${r.symbol} position?`, subtitle: 'The whole position is closed at market.', rows: [['Pair', r.symbol], ['Side', r.side]], confirmLabel: 'Close position', live: isLive }))) return;
    const res = await fetch(`/api/positions/${r.id}/close`, { method: 'POST' });
    toast(res.ok ? 'success' : 'error', res.ok ? `${r.symbol} position closed` : `Could not close ${r.symbol}`);
    load();
  };
  const cancelOrder = async (o) => {
    if (!(await confirm({ title: 'Cancel this order?', rows: [['Pair', o.symbol], ['Order', `#${o.id}`]], confirmLabel: 'Cancel order', live: isLive }))) return;
    const res = await fetch(`/api/orders/${o.id}`, { method: 'DELETE' });
    toast(res.ok ? 'success' : 'error', res.ok ? `Order #${o.id} cancelled` : `Could not cancel order #${o.id}`);
    load();
  };

  const sideChip = (side, long) => (
    <span className={`rounded px-2 py-0.5 text-xs font-bold ${long ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>{long ? '▲' : '▼'} {side}</span>
  );
  const dangerBtn = 'rounded-lg border border-line bg-raised px-3 py-1.5 text-xs font-semibold text-ink hover:border-down hover:text-down w-full md:w-auto';

  return (
    <section className={`rounded-xl border border-line bg-surface ${className}`}>
      <div role="tablist" className="flex gap-5 border-b border-line px-4 pt-3 text-sm">
        {[['positions', `Positions ${myPositions.length}`], ['orders', `Open orders ${myOrders.length}`]].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`-mb-px border-b-2 pb-2 font-semibold ${tab === id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'positions' ? (
        <DataTable
          loading={loading}
          rows={myPositions}
          empty="No open positions on this account."
          columns={[
            { key: 'symbol', header: 'Symbol', primary: true, mono: false, render: (r) => <b className="text-ink">{r.symbol}</b> },
            { key: 'side', header: 'Side', mono: false, render: (r) => sideChip(r.side, r.side === 'LONG') },
            { key: 'size', header: 'Size', align: 'right' },
            { key: 'entryPrice', header: 'Entry', align: 'right', render: (r) => r.entryPrice?.toLocaleString(undefined, { minimumFractionDigits: 2 }) },
            { key: 'markPrice', header: 'Mark', align: 'right', render: (r) => r.markPrice?.toLocaleString(undefined, { minimumFractionDigits: 2 }) },
            { key: 'unrealizedPnl', header: 'P&L', align: 'right', render: (r) => <b className={r.unrealizedPnl >= 0 ? 'text-up' : 'text-down'}>{r.unrealizedPnl >= 0 ? '+' : ''}{r.unrealizedPnl?.toFixed(2)}</b> },
            { key: 'a', header: '', align: 'center', actions: true, mono: false, render: (r) => <button onClick={() => closePosition(r)} className={dangerBtn}>Close</button> },
          ]}
        />
      ) : (
        <DataTable
          loading={loading}
          rows={myOrders}
          empty="No open orders on this account."
          columns={[
            { key: 'symbol', header: 'Symbol', primary: true, mono: false, render: (o) => <b className="text-ink">{o.symbol}</b> },
            { key: 'side', header: 'Side', mono: false, render: (o) => sideChip(o.side, o.side === 'BUY') },
            { key: 'orderType', header: 'Type', mono: false },
            { key: 'price', header: 'Price', align: 'right', render: (o) => o.price?.toLocaleString(undefined, { minimumFractionDigits: 2 }) },
            { key: 'size', header: 'Size', align: 'right' },
            { key: 'a', header: '', align: 'center', actions: true, mono: false, render: (o) => <button onClick={() => cancelOrder(o)} className={dangerBtn}>Cancel</button> },
          ]}
        />
      )}
    </section>
  );
}
