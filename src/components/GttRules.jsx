import React, { useState, useEffect } from 'react';
import {
  Sliders,
  PlusCircle,
  XCircle,
  CheckCircle2,
  AlertCircle,
  ShieldAlert,
  Clock,
} from 'lucide-react';

export default function GttRules({ accounts, activeAccountId }) {
  const [rules, setRules] = useState([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [notice, setNotice] = useState(null);

  const activeAccount = accounts.find((a) => a.id === activeAccountId) || accounts[0];
  const isCoinSwitch = activeAccount?.broker === 'coinswitch';

  // Form State
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [type, setType] = useState('BRACKET_OCO');
  const [triggerPrice, setTriggerPrice] = useState('');
  const [condition, setCondition] = useState('ABOVE');
  const [side, setSide] = useState('SELL');
  const [size, setSize] = useState('0.1');
  const [targetPrice, setTargetPrice] = useState('');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchRules = async () => {
    try {
      const res = await fetch('/api/gtt');
      if (res.ok) setRules(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  // Sync trigger prices with live Binance mark price
  useEffect(() => {
    const fetchCurrentPrice = async () => {
      try {
        const res = await fetch(`/api/market/depth?symbol=${symbol}`);
        if (res.ok) {
          const depth = await res.json();
          const live = depth.bestBid || 76000;
          setTriggerPrice((live * 1.02).toFixed(2));
          setTargetPrice((live * 1.05).toFixed(2));
          setStopLossPrice((live * 0.97).toFixed(2));
        }
      } catch (err) {
        // silent fallback
      }
    };
    fetchCurrentPrice();
  }, [symbol]);

  const handleCreateRule = async (e) => {
    e.preventDefault();
    if (isCoinSwitch) {
      setNotice({
        type: 'error',
        text: 'CoinSwitch does not support native GTT / Bracket orders. Please select Delta Exchange or CoinDCX to create conditional trigger rules.',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/gtt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: activeAccount.id,
          symbol,
          type,
          triggerPrice: Number(triggerPrice),
          condition,
          side,
          size: Number(size),
          targetPrice: targetPrice ? Number(targetPrice) : undefined,
          stopLossPrice: stopLossPrice ? Number(stopLossPrice) : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create GTT rule');

      setNotice({
        type: 'success',
        text: `GTT Rule #${data.id} registered for ${symbol} via ${activeAccount.accountName}!`,
      });
      setShowCreateModal(false);
      fetchRules();
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelRule = async (ruleId) => {
    try {
      const res = await fetch(`/api/gtt/${ruleId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel rule');
      setNotice({ type: 'success', text: `GTT rule #${ruleId} cancelled.` });
      fetchRules();
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-slate-900/60 border border-slate-800/80 rounded-xl px-5 py-4">
        <div>
          <h1 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
            <span>Conditional Orders & GTT Rules</span>
          </h1>
          <p className="text-xs text-slate-400">
            Automated Good-Till-Triggered rules, OCO brackets, and trailing triggers across crypto exchanges.
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg flex items-center gap-2 transition-colors shadow-sm"
        >
          <PlusCircle className="w-4 h-4" />
          <span>New GTT Trigger</span>
        </button>
      </div>

      {/* Exchange Capability Matrix Notice */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className={`p-3.5 rounded-xl border text-xs flex flex-col justify-between ${
          isCoinSwitch ? 'bg-amber-950/20 border-amber-500/40' : 'bg-slate-900/50 border-slate-800'
        }`}>
          <div className="flex items-center justify-between font-semibold text-white">
            <span>CoinSwitch PRO</span>
            <span className="text-[10px] text-amber-400 font-mono bg-amber-500/10 px-1.5 py-0.5 rounded">Not Supported</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            CoinSwitch API v2 does not expose persistent server-side GTT orders. Creation is locked.
          </p>
        </div>

        <div className="p-3.5 rounded-xl border border-slate-800 bg-slate-900/50 text-xs flex flex-col justify-between">
          <div className="flex items-center justify-between font-semibold text-white">
            <span>Delta Exchange India</span>
            <span className="text-[10px] text-cyan-400 font-mono bg-cyan-500/10 px-1.5 py-0.5 rounded">Native Bracket OCO</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            Mapped directly to Delta's high-frequency bracket stop and take-profit contracts.
          </p>
        </div>

        <div className="p-3.5 rounded-xl border border-slate-800 bg-slate-900/50 text-xs flex flex-col justify-between">
          <div className="flex items-center justify-between font-semibold text-white">
            <span>CoinDCX Prime</span>
            <span className="text-[10px] text-blue-400 font-mono bg-blue-500/10 px-1.5 py-0.5 rounded">Target / SL Trigger</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            Mapped to CoinDCX conditional target price and trailing stop-loss orders.
          </p>
        </div>
      </div>

      {/* Notification */}
      {notice && (
        <div
          className={`px-4 py-3 rounded-lg text-xs flex items-center justify-between border ${
            notice.type === 'success'
              ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800'
              : 'bg-rose-950/40 text-rose-300 border-rose-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
            <span>{notice.text}</span>
          </div>
          <button onClick={() => setNotice(null)} className="text-slate-400 hover:text-white">✕</button>
        </div>
      )}

      {/* GTT Rules Table */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <span className="text-xs font-semibold text-white">Active Trigger Rules</span>
          <span className="text-[11px] text-slate-500 font-mono">Count: {rules.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-500 font-medium border-b border-slate-800 text-[11px]">
              <tr>
                <th className="py-2.5 px-4">Rule ID</th>
                <th className="py-2.5 px-4">Exchange</th>
                <th className="py-2.5 px-4">Symbol</th>
                <th className="py-2.5 px-4">Rule Type</th>
                <th className="py-2.5 px-4 text-right">Trigger Condition</th>
                <th className="py-2.5 px-4 text-right">Size</th>
                <th className="py-2.5 px-4 text-right">Target Price</th>
                <th className="py-2.5 px-4 text-right">Stop Loss Price</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-slate-500 font-sans">
                    No conditional GTT rules configured. Click &quot;New GTT Trigger&quot; to set up automated TP/SL brackets.
                  </td>
                </tr>
              ) : (
                rules.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-4 font-sans text-slate-300 font-medium">{r.id}</td>
                    <td className="py-3 px-4 font-sans text-slate-300 capitalize">{r.broker}</td>
                    <td className="py-3 px-4 font-sans font-bold text-white">{r.symbol}</td>
                    <td className="py-3 px-4 font-sans text-slate-300">{r.type}</td>
                    <td className="py-3 px-4 text-right text-emerald-400 font-semibold">
                      {r.condition === 'ABOVE' ? '≥' : '≤'} ${r.triggerPrice.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-200">{r.size}</td>
                    <td className="py-3 px-4 text-right text-cyan-400">
                      {r.targetPrice ? `$${r.targetPrice.toLocaleString()}` : '—'}
                    </td>
                    <td className="py-3 px-4 text-right text-rose-400">
                      {r.stopLossPrice ? `$${r.stopLossPrice.toLocaleString()}` : '—'}
                    </td>
                    <td className="py-3 px-4 font-sans">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        r.status === 'ACTIVE'
                          ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20'
                          : r.status === 'TRIGGERED'
                          ? 'text-amber-400 bg-amber-500/10 border border-amber-500/20'
                          : 'text-slate-400 bg-slate-800'
                      }`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center font-sans">
                      {r.status === 'ACTIVE' ? (
                        <button
                          onClick={() => handleCancelRule(r.id)}
                          className="px-2 py-1 text-[11px] bg-rose-950/60 hover:bg-rose-900 text-rose-400 rounded border border-rose-800/60 transition-colors"
                        >
                          Cancel
                        </button>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 max-w-lg w-full shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Sliders className="w-4 h-4 text-emerald-400" />
                <span>Create Conditional GTT Trigger</span>
              </h2>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-500 hover:text-white">✕</button>
            </div>

            {isCoinSwitch && (
              <div className="my-3 p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-xs text-rose-300 flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  The active account is <strong>CoinSwitch PRO</strong>, which does not support native GTT rules. Please switch to a <strong>Delta Exchange</strong> or <strong>CoinDCX</strong> account from the header to place conditional trigger orders.
                </span>
              </div>
            )}

            <form onSubmit={handleCreateRule} className="flex flex-col gap-3 mt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-slate-400">Target Account</label>
                  <input
                    type="text"
                    disabled
                    value={activeAccount?.accountName}
                    className="w-full bg-slate-950/80 border border-slate-800 rounded px-3 py-2 text-xs text-slate-300 mt-1 cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-400">Symbol</label>
                  <select
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white mt-1 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="BTCUSDT">BTCUSDT</option>
                    <option value="ETHUSDT">ETHUSDT</option>
                    <option value="SOLUSDT">SOLUSDT</option>
                    <option value="XRPUSDT">XRPUSDT</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-slate-400">Condition Type</label>
                  <select
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white mt-1 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="ABOVE">Price ≥ Trigger</option>
                    <option value="BELOW">Price ≤ Trigger</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-slate-400">Trigger Price (USDT)</label>
                  <input
                    type="number"
                    step="any"
                    value={triggerPrice}
                    onChange={(e) => setTriggerPrice(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-white mt-1 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-slate-400">Order Action Side</label>
                  <select
                    value={side}
                    onChange={(e) => setSide(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white mt-1 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="BUY">BUY Order</option>
                    <option value="SELL">SELL Order</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-slate-400">Quantity / Size</label>
                  <input
                    type="number"
                    step="any"
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-white mt-1 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800">
                <div>
                  <label className="text-[11px] text-slate-400">Target Profit Price</label>
                  <input
                    type="number"
                    step="any"
                    placeholder="e.g. 96000"
                    value={targetPrice}
                    onChange={(e) => setTargetPrice(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-emerald-400 mt-1 focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-400">Stop Loss Price</label>
                  <input
                    type="number"
                    step="any"
                    placeholder="e.g. 88500"
                    value={stopLossPrice}
                    onChange={(e) => setStopLossPrice(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-rose-400 mt-1 focus:outline-none focus:border-rose-500"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || isCoinSwitch}
                  className={`px-4 py-2 text-xs font-bold text-white rounded-lg transition-colors ${
                    isCoinSwitch
                      ? 'bg-slate-800 opacity-50 cursor-not-allowed'
                      : 'bg-emerald-600 hover:bg-emerald-500'
                  }`}
                >
                  {isSubmitting ? 'Creating...' : 'Register GTT Rule'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
