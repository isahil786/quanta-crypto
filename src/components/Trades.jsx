import React, { useState, useEffect } from 'react';
import { useConfirm } from '../ui/Confirm.jsx';
import DataTable from '../ui/DataTable.jsx';
import {
  XCircle,
  Edit2,
  CheckCircle2,
  AlertCircle,
  Filter,
  RefreshCw,
} from 'lucide-react';

export default function Trades() {
  const confirm = useConfirm();
  const [orders, setOrders] = useState([]);
  const [trades, setTrades] = useState([]);
  const [viewTab, setViewTab] = useState('open'); // 'open', 'trades', 'all'
  const [selectedBroker, setSelectedBroker] = useState('all');
  const [loading, setLoading] = useState(false);
  const [actionNotice, setActionNotice] = useState(null);

  // Pagination state
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersLimit, setOrdersLimit] = useState(50);
  const [ordersPagination, setOrdersPagination] = useState({ total: 0, totalPages: 1, page: 1, limit: 50, hasMore: false });
  const [tradesPage, setTradesPage] = useState(1);
  const [tradesLimit, setTradesLimit] = useState(50);
  const [tradesPagination, setTradesPagination] = useState({ total: 0, totalPages: 1, page: 1, limit: 50, hasMore: false });

  // Modify Modal State
  const [editingOrder, setEditingOrder] = useState(null);
  const [editPrice, setEditPrice] = useState('');
  const [editSize, setEditSize] = useState('');
  const [isModifying, setIsModifying] = useState(false);

  const fetchOrdersAndTrades = async () => {
    setLoading(true);
    try {
      const [ordRes, trdRes] = await Promise.all([
        fetch(`/api/orders?page=${ordersPage}&limit=${ordersLimit}`),
        fetch(`/api/trades?page=${tradesPage}&limit=${tradesLimit}`),
      ]);
      if (ordRes.ok) {
        const data = await ordRes.json();
        setOrders(Array.isArray(data) ? data : data.orders);
        if (!Array.isArray(data)) setOrdersPagination({ total: data.total, totalPages: data.totalPages, page: data.page, limit: data.limit, hasMore: data.hasMore });
      }
      if (trdRes.ok) {
        const data = await trdRes.json();
        setTrades(Array.isArray(data) ? data : data.trades);
        if (!Array.isArray(data)) setTradesPagination({ total: data.total, totalPages: data.totalPages, page: data.page, limit: data.limit, hasMore: data.hasMore });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    fetchOrdersAndTrades();
    const interval = setInterval(() => {
      if (!isMounted) return;
      fetchOrdersAndTrades();
    }, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [ordersPage, ordersLimit, tradesPage, tradesLimit]);

  const handleCancelOrder = async (orderId, brokerName) => {
    if (!(await confirm({ title: 'Cancel this order?', rows: [['Order', `#${orderId}`], ['Exchange', String(brokerName || '').toUpperCase()]], confirmLabel: 'Cancel order', live: false }))) return;
    try {
      const res = await fetch(`/api/orders/${orderId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel');
      setActionNotice({
        type: 'success',
        text: `Order ${orderId} cancelled on ${brokerName.toUpperCase()}`,
      });
      fetchOrdersAndTrades();
    } catch (err) {
      setActionNotice({ type: 'error', text: err.message });
    }
  };

  const handleOpenModify = (order) => {
    setEditingOrder(order);
    setEditPrice(order.price.toString());
    setEditSize(order.size.toString());
  };

  const handleSaveModify = async (e) => {
    e.preventDefault();
    if (!editingOrder) return;
    setIsModifying(true);
    try {
      const res = await fetch(`/api/orders/${editingOrder.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          price: Number(editPrice),
          size: Number(editSize),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to modify');
      setActionNotice({
        type: 'success',
        text: data.message || `Order ${editingOrder.id} updated!`,
      });
      setEditingOrder(null);
      fetchOrdersAndTrades();
    } catch (err) {
      setActionNotice({ type: 'error', text: err.message });
    } finally {
      setIsModifying(false);
    }
  };

  // Filter orders
  const filteredOrders = orders.filter((o) => {
    if (selectedBroker !== 'all' && o.broker !== selectedBroker) return false;
    if (viewTab === 'open') return o.status === 'OPEN';
    return true;
  });

  const filteredTrades = trades.filter((t) => {
    if (selectedBroker !== 'all' && t.broker !== selectedBroker) return false;
    return true;
  });

  return (
    <div className="flex flex-col gap-5">
      {/* Header and Controls */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-slate-900/60 border border-slate-800/80 rounded-xl px-5 py-4">
        <div>
          <h1 className="text-lg font-bold text-white tracking-tight">Orders & Executed Trades</h1>
          <p className="text-xs text-slate-400">
            Real-time execution book across CoinSwitch, Delta Exchange, and CoinDCX.
          </p>
        </div>

        {/* View Tabs & Broker Filter */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
            <button
              onClick={() => setViewTab('open')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewTab === 'open' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Open Orders ({orders.filter((o) => o.status === 'OPEN').length})
            </button>
            <button
              onClick={() => setViewTab('trades')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewTab === 'trades' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Executed Fills ({trades.length})
            </button>
            <button
              onClick={() => setViewTab('all')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewTab === 'all' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All Orders ({orders.length})
            </button>
          </div>

          <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-300">
            <Filter className="w-3.5 h-3.5 text-slate-500" />
            <select
              value={selectedBroker}
              onChange={(e) => setSelectedBroker(e.target.value)}
              className="bg-transparent focus:outline-none cursor-pointer text-xs"
            >
              <option value="all" className="bg-slate-900">All Exchanges</option>
              <option value="coinswitch" className="bg-slate-900">CoinSwitch PRO</option>
              <option value="delta" className="bg-slate-900">Delta Exchange India</option>
              <option value="coindcx" className="bg-slate-900">CoinDCX Prime</option>
            </select>
          </div>

          <button
            onClick={fetchOrdersAndTrades}
            disabled={loading}
            className="p-2 bg-slate-950 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Action Notification */}
      {actionNotice && (
        <div
          className={`px-4 py-3 rounded-lg text-xs flex items-center justify-between border ${
            actionNotice.type === 'success'
              ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800'
              : 'bg-rose-950/40 text-rose-300 border-rose-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {actionNotice.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{actionNotice.text}</span>
          </div>
          <button onClick={() => setActionNotice(null)} className="text-slate-400 hover:text-white text-xs">
            ✕
          </button>
        </div>
      )}

      {/* Data Table View */}
      {viewTab === 'trades' ? (
        /* Trade Fills Table */
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-white">Execution Fills & Completed Trades</span>
            <span className="text-[11px] text-slate-500 font-mono">Count: {filteredTrades.length}</span>
          </div>
          <DataTable
            rows={filteredTrades}
            empty="No executed trades recorded yet. Place an order on the terminal to simulate fills!"
            columns={[
              { key: 'symbol', header: 'Symbol', primary: true, mono: false, render: (t) => <span><b className="text-ink">{t.symbol}</b> <span className="ml-1 text-xs capitalize text-muted">{t.broker}</span></span> },
              { key: 'id', header: 'Trade ID', mono: false },
              { key: 'side', header: 'Side', mono: false, render: (t) => (
                <span className={`rounded px-2 py-0.5 text-xs font-bold ${t.side === 'BUY' ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>{t.side === 'BUY' ? '▲' : '▼'} {t.side}</span>
              ) },
              { key: 'price', header: 'Price', align: 'right', render: (t) => `$${t.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
              { key: 'size', header: 'Size', align: 'right' },
              { key: 'value', header: 'Total Value', align: 'right', render: (t) => `$${t.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
              { key: 'fee', header: 'Fee', align: 'right', render: (t) => (
                <span className="text-muted">
                  ${t.fee.toFixed(4)}
                  {t.liquidity && (
                    <span
                      className={`ml-1.5 rounded px-1 py-px align-middle text-xs font-bold ${t.liquidity === 'MAKER' ? 'bg-up/15 text-up' : 'bg-raised text-muted'}`}
                      title={`${t.liquidity === 'MAKER' ? 'Maker' : 'Taker'} fill${t.slippagePct ? ` · slippage ${t.slippagePct}% vs ${t.refPrice}` : ''}`}
                    >
                      {t.liquidity === 'MAKER' ? 'M' : 'T'}{t.slippagePct ? ` ${t.slippagePct}%` : ''}
                    </span>
                  )}
                </span>
              ) },
              { key: 'timestamp', header: 'Time', align: 'right', mono: false, render: (t) => <span className="text-xs text-muted">{new Date(t.timestamp).toLocaleTimeString()}</span> },
            ]}
          />
        </div>
      ) : (
        /* Orders Table */
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-white">
              {viewTab === 'open' ? 'Active Open Orders' : 'All Order History'}
            </span>
            <span className="text-[11px] text-slate-500 font-mono">Count: {filteredOrders.length}</span>
          </div>
          <DataTable
            rows={filteredOrders}
            empty="No orders found matching the active filter."
            columns={[
              { key: 'symbol', header: 'Symbol', primary: true, mono: false, render: (o) => (
                <span><b className="text-ink">{o.symbol}</b> <span className="ml-1 text-xs capitalize text-muted">{o.broker}</span></span>
              ) },
              { key: 'id', header: 'Order ID', mono: false },
              { key: 'side', header: 'Side / Type', mono: false, render: (o) => (
                <span>
                  <span className={`mr-1 rounded px-1.5 py-0.5 text-xs font-bold ${o.side === 'BUY' ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>
                    {o.side === 'BUY' ? '▲' : '▼'} {o.side}
                  </span>
                  <span className="text-xs text-muted">{o.orderType}</span>
                </span>
              ) },
              { key: 'price', header: 'Price', align: 'right', render: (o) => `$${o.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
              { key: 'size', header: 'Size (Filled)', align: 'right', render: (o) => <>{o.size} <span className="text-muted">({o.filledSize})</span></> },
              { key: 'leverage', header: 'Leverage', render: (o) => `${o.leverage}x` },
              { key: 'status', header: 'Status', mono: false, render: (o) => {
                const tone = o.status === 'FILLED' ? 'text-up bg-up/10' : o.status === 'OPEN' ? 'text-live bg-live/10' : o.status === 'REJECTED' ? 'text-down bg-down/10' : 'text-muted bg-raised';
                return <span className={`rounded px-2 py-0.5 text-xs font-bold ${tone}`}>{o.status}</span>;
              } },
              { key: 'timestamp', header: 'Time', align: 'right', mono: false, render: (o) => <span className="text-xs text-muted">{new Date(o.timestamp).toLocaleTimeString()}</span> },
              { key: 'actions', header: 'Actions', align: 'center', actions: true, mono: false, render: (o) => (
                o.status === 'OPEN' ? (
                  <div className="flex items-center justify-center gap-2">
                    <button onClick={() => handleOpenModify(o)} className="flex items-center gap-1 rounded-lg border border-line bg-raised px-3 py-1.5 text-xs font-semibold text-ink" title={o.broker === 'coinswitch' ? 'Cancel & Replace order on CoinSwitch' : 'Edit order price/size'}>
                      <Edit2 className="size-3" /> Modify
                    </button>
                    <button onClick={() => handleCancelOrder(o.id, o.broker)} className="flex items-center gap-1 rounded-lg border border-down/50 bg-down/10 px-3 py-1.5 text-xs font-semibold text-down" title="Cancel Order">
                      <XCircle className="size-3" /> Cancel
                    </button>
                  </div>
                ) : <span className="text-muted">—</span>
              ) },
            ]}
          />
        </div>
      )}

      {/* Pagination Controls */}
      <div className="flex items-center justify-between gap-4 p-4 bg-slate-900 border-t border-slate-800 rounded-b-xl">
        <div className="flex items-center gap-4 text-xs text-slate-400">
          {viewTab === 'trades' && (
            <>
              <span>Trades Page {tradesPagination.page} of {tradesPagination.totalPages}</span>
              <button
                onClick={() => setTradesPage((p) => Math.max(p - 1, 1))}
                disabled={tradesPage <= 1}
                className="px-2 py-1 text-xs font-medium rounded hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ← Prev
              </button>
              <button
                onClick={() => setTradesPage((p) => (p < tradesPagination.totalPages ? p + 1 : p))}
                disabled={!tradesPagination.hasMore}
                className="px-2 py-1 text-xs font-medium rounded hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </>
          )}
          {viewTab !== 'trades' && (
            <>
              <span>Orders Page {ordersPage} of {ordersPagination.totalPages}</span>
              <button
                onClick={() => setOrdersPage((p) => Math.max(p - 1, 1))}
                disabled={ordersPage <= 1}
                className="px-2 py-1 text-xs font-medium rounded hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ← Prev
              </button>
              <button
                onClick={() => setOrdersPage((p) => (p < ordersPagination.totalPages ? p + 1 : p))}
                disabled={!ordersPagination.hasMore}
                className="px-2 py-1 text-xs font-medium rounded hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="font-mono">{viewTab === 'trades' ? tradesPagination.total : ordersPagination.total} items</span>
          <select
            value={viewTab === 'trades' ? tradesLimit : ordersLimit}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (viewTab === 'trades') setTradesLimit(val);
              else setOrdersLimit(val);
            }}
            className="bg-transparent text-slate-300 focus:outline-none cursor-pointer"
          >
            <option value="25">25/page</option>
            <option value="50">50/page</option>
            <option value="100">100/page</option>
          </select>
        </div>
      </div>

      {/* Modify Modal */}
      {editingOrder && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 max-w-md w-full shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h2 className="text-sm font-bold text-white">
                Modify Order {editingOrder.id} ({editingOrder.symbol})
              </h2>
              <button
                onClick={() => setEditingOrder(null)}
                className="text-slate-500 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            {/* CoinSwitch Cancel & Replace Note */}
            {editingOrder.broker === 'coinswitch' && (
              <div className="my-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong>CoinSwitch Notice:</strong> CoinSwitch does not support native in-place order modification. This action will cancel order #{editingOrder.id} and submit a new replacement order with your updated parameters.
                </span>
              </div>
            )}

            <form onSubmit={handleSaveModify} className="flex flex-col gap-3 mt-3">
              <div>
                <label className="text-[11px] text-slate-400 font-medium">New Limit Price (USDT)</label>
                <input
                  type="number"
                  step="any"
                  value={editPrice}
                  onChange={(e) => setEditPrice(e.target.value)}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-emerald-500 mt-1"
                />
              </div>

              <div>
                <label className="text-[11px] text-slate-400 font-medium">New Quantity / Size</label>
                <input
                  type="number"
                  step="any"
                  value={editSize}
                  onChange={(e) => setEditSize(e.target.value)}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-emerald-500 mt-1"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setEditingOrder(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isModifying}
                  className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors"
                >
                  {isModifying ? 'Submitting...' : editingOrder.broker === 'coinswitch' ? 'Cancel & Replace' : 'Update Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
