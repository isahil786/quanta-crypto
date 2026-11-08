import React, { useState, useEffect } from 'react';
import {
  ArrowDownUp,
  XCircle,
  Edit2,
  CheckCircle2,
  AlertCircle,
  Filter,
  RefreshCw,
} from 'lucide-react';

export default function Trades({ accounts, activeAccountId }) {
  const [orders, setOrders] = useState([]);
  const [trades, setTrades] = useState([]);
  const [viewTab, setViewTab] = useState('open'); // 'open', 'trades', 'all'
  const [selectedBroker, setSelectedBroker] = useState('all');
  const [loading, setLoading] = useState(false);
  const [actionNotice, setActionNotice] = useState(null);

  // Modify Modal State
  const [editingOrder, setEditingOrder] = useState(null);
  const [editPrice, setEditPrice] = useState('');
  const [editSize, setEditSize] = useState('');
  const [isModifying, setIsModifying] = useState(false);

  const fetchOrdersAndTrades = async () => {
    setLoading(true);
    try {
      const [ordRes, trdRes] = await Promise.all([
        fetch('/api/orders'),
        fetch('/api/trades'),
      ]);
      if (ordRes.ok) setOrders(await ordRes.json());
      if (trdRes.ok) setTrades(await trdRes.json());
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
  }, []);

  const handleCancelOrder = async (orderId, brokerName) => {
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
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-500 font-medium border-b border-slate-800 text-[11px]">
                <tr>
                  <th className="py-2.5 px-4">Trade ID</th>
                  <th className="py-2.5 px-4">Exchange</th>
                  <th className="py-2.5 px-4">Symbol</th>
                  <th className="py-2.5 px-4">Side</th>
                  <th className="py-2.5 px-4 text-right">Price</th>
                  <th className="py-2.5 px-4 text-right">Size</th>
                  <th className="py-2.5 px-4 text-right">Total Value</th>
                  <th className="py-2.5 px-4 text-right">Fee</th>
                  <th className="py-2.5 px-4 text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                {filteredTrades.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-slate-500 font-sans">
                      No executed trades recorded yet. Place an order on the terminal to simulate fills!
                    </td>
                  </tr>
                ) : (
                  filteredTrades.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-2.5 px-4 font-sans text-slate-300 font-medium">{t.id}</td>
                      <td className="py-2.5 px-4 font-sans text-slate-300 capitalize">{t.broker}</td>
                      <td className="py-2.5 px-4 font-sans font-bold text-white">{t.symbol}</td>
                      <td className="py-2.5 px-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          t.side === 'BUY' ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'
                        }`}>
                          {t.side}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right text-slate-200">${t.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className="py-2.5 px-4 text-right text-slate-200">{t.size}</td>
                      <td className="py-2.5 px-4 text-right text-slate-200">${t.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className="py-2.5 px-4 text-right text-slate-400">${t.fee.toFixed(4)}</td>
                      <td className="py-2.5 px-4 text-right text-slate-500 text-[11px] font-sans">
                        {new Date(t.timestamp).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
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
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-500 font-medium border-b border-slate-800 text-[11px]">
                <tr>
                  <th className="py-2.5 px-4">Order ID</th>
                  <th className="py-2.5 px-4">Exchange</th>
                  <th className="py-2.5 px-4">Symbol</th>
                  <th className="py-2.5 px-4">Side / Type</th>
                  <th className="py-2.5 px-4 text-right">Price</th>
                  <th className="py-2.5 px-4 text-right">Size (Filled)</th>
                  <th className="py-2.5 px-4">Leverage</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Time</th>
                  <th className="py-2.5 px-4 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                {filteredOrders.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-slate-500 font-sans">
                      No orders found matching the active filter.
                    </td>
                  </tr>
                ) : (
                  filteredOrders.map((o) => {
                    const isModifiable = o.status === 'OPEN';
                    return (
                      <tr key={o.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2.5 px-4 font-sans text-slate-300 font-medium">{o.id}</td>
                        <td className="py-2.5 px-4 font-sans text-slate-300 capitalize">{o.broker}</td>
                        <td className="py-2.5 px-4 font-sans font-bold text-white">{o.symbol}</td>
                        <td className="py-2.5 px-4 font-sans">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold mr-1 ${
                            o.side === 'BUY' ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'
                          }`}>
                            {o.side}
                          </span>
                          <span className="text-slate-400 text-[11px]">{o.orderType}</span>
                        </td>
                        <td className="py-2.5 px-4 text-right text-slate-200">
                          ${o.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td className="py-2.5 px-4 text-right text-slate-200">
                          {o.size} <span className="text-slate-500">({o.filledSize})</span>
                        </td>
                        <td className="py-2.5 px-4 text-slate-400">{o.leverage}x</td>
                        <td className="py-2.5 px-4 font-sans">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              o.status === 'FILLED'
                                ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20'
                                : o.status === 'OPEN'
                                ? 'text-cyan-400 bg-cyan-500/10 border border-cyan-500/20'
                                : o.status === 'REJECTED'
                                ? 'text-rose-400 bg-rose-500/10 border border-rose-500/20'
                                : 'text-slate-400 bg-slate-800 border border-slate-700'
                            }`}
                          >
                            {o.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-right text-slate-500 text-[11px] font-sans">
                          {new Date(o.timestamp).toLocaleTimeString()}
                        </td>
                        <td className="py-2.5 px-4 text-center font-sans">
                          {o.status === 'OPEN' ? (
                            <div className="flex items-center justify-center gap-2">
                              <button
                                onClick={() => handleOpenModify(o)}
                                className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded flex items-center gap-1 transition-colors"
                                title={o.broker === 'coinswitch' ? 'Cancel & Replace order on CoinSwitch' : 'Edit order price/size'}
                              >
                                <Edit2 className="w-3 h-3" />
                                <span>Modify</span>
                              </button>
                              <button
                                onClick={() => handleCancelOrder(o.id, o.broker)}
                                className="px-2 py-1 text-[11px] bg-rose-950/60 hover:bg-rose-900/80 text-rose-400 hover:text-rose-200 border border-rose-800/60 rounded flex items-center gap-1 transition-colors"
                                title="Cancel Order"
                              >
                                <XCircle className="w-3 h-3" />
                                <span>Cancel</span>
                              </button>
                            </div>
                          ) : (
                            <span className="text-slate-600 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
