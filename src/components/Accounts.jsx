import React, { useState } from 'react';
import {
  ShieldCheck,
  PlusCircle,
  Trash2,
  Zap,
  Key,
  Lock,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Cpu,
  Layers,
} from 'lucide-react';

export default function Accounts({ accounts, onAccountsUpdated, activeAccountId, setActiveAccountId }) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [isTesting, setIsTesting] = useState(false);
  const [notice, setNotice] = useState(null);

  // Add Account Form State
  const [broker, setBroker] = useState('coinswitch');
  const [accountName, setAccountName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [segment, setSegment] = useState('SPOT');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleTestConnection = async (acc) => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/accounts/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broker: acc.broker,
          apiKey: acc.apiKey,
          apiSecret: acc.apiSecret,
          segment: acc.segment,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Connection failed');
      setTestResult({
        accountId: acc.id,
        ...data,
      });
    } catch (err) {
      setTestResult({
        accountId: acc.id,
        success: false,
        error: err.message,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleAddAccount = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broker,
          accountName,
          apiKey,
          apiSecret,
          segment,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create account');

      setNotice({
        type: 'success',
        text: `Account "${data.accountName}" connected successfully to ${data.broker.toUpperCase()}!`,
      });
      setShowAddModal(false);
      setAccountName('');
      setApiKey('');
      setApiSecret('');
      if (onAccountsUpdated) onAccountsUpdated();
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteAccount = async (id, name) => {
    if (accounts.length <= 1) {
      setNotice({ type: 'error', text: 'At least one trading account must remain configured.' });
      return;
    }
    try {
      const res = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setNotice({ type: 'success', text: `Account "${name}" removed.` });
        if (id === activeAccountId) {
          const remaining = accounts.filter((a) => a.id !== id);
          if (remaining.length > 0) setActiveAccountId(remaining[0].id);
        }
        if (onAccountsUpdated) onAccountsUpdated();
      }
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
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <span>Exchange API Accounts & Authentication</span>
          </h1>
          <p className="text-xs text-slate-400">
            Securely manage API credentials for CoinSwitch (Ed25519), Delta Exchange India (HMAC), and CoinDCX.
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg flex items-center gap-2 transition-colors shadow-sm"
        >
          <PlusCircle className="w-4 h-4" />
          <span>Connect Exchange</span>
        </button>
      </div>

      {/* Notice */}
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

      {/* Test Connection Result Panel */}
      {testResult && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs font-mono">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-white font-bold">
            <span className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-400" />
              <span>Connection Test: {testResult.broker} ({testResult.status})</span>
            </span>
            <span className="text-emerald-400 font-bold">Latency: {testResult.latencyMs}ms</span>
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <span className="text-slate-500 text-[11px] font-sans font-medium">Authentication Headers Sent:</span>
              <pre className="mt-1 p-2 bg-slate-950 rounded border border-slate-800 text-[10px] text-slate-300 overflow-x-auto">
                {JSON.stringify(testResult.generatedHeaders, null, 2)}
              </pre>
            </div>
            <div>
              <span className="text-slate-500 text-[11px] font-sans font-medium">Exchange Feature Support:</span>
              <pre className="mt-1 p-2 bg-slate-950 rounded border border-slate-800 text-[10px] text-cyan-300 overflow-x-auto">
                {JSON.stringify(testResult.capabilities, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Connected Accounts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {accounts.map((acc) => {
          const isCurrentActive = acc.id === activeAccountId;
          const isMaster = acc.isMaster;

          return (
            <div
              key={acc.id}
              className={`bg-slate-900/80 border rounded-xl p-5 flex flex-col justify-between transition-all ${
                isCurrentActive ? 'border-emerald-500/50 shadow-lg shadow-emerald-500/5' : 'border-slate-800'
              }`}
            >
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">{acc.accountName}</span>
                    {isMaster && (
                      <span className="text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20">
                        Master
                      </span>
                    )}
                  </div>
                  <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-bold ${
                    acc.broker === 'coinswitch'
                      ? 'text-amber-400 bg-amber-500/10'
                      : acc.broker === 'delta'
                      ? 'text-cyan-400 bg-cyan-500/10'
                      : 'text-blue-400 bg-blue-500/10'
                  }`}>
                    {acc.broker}
                  </span>
                </div>

                <div className="mt-4 space-y-2 text-xs">
                  <div className="flex justify-between text-slate-400">
                    <span>Segment:</span>
                    <span className="text-slate-200 font-medium">{acc.segment}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>API Key:</span>
                    <span className="font-mono text-slate-300">{acc.apiKeyMasked}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Signing Protocol:</span>
                    <span className="font-mono text-slate-300">
                      {acc.broker === 'coinswitch' ? 'Ed25519 (256-bit seed)' : 'HMAC-SHA256'}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Equity / Balance:</span>
                    <span className="font-mono font-bold text-emerald-400">
                      ${acc.totalEquityUSDT?.toLocaleString()} USDT
                    </span>
                  </div>
                </div>

                {/* Capability Tags */}
                <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap gap-1.5 text-[10px] text-slate-400 font-mono">
                  {acc.broker === 'coinswitch' ? (
                    <>
                      <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800">Spot Limit Only</span>
                      <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800">Cancel & Replace</span>
                    </>
                  ) : acc.broker === 'delta' ? (
                    <>
                      <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800">Market & Limit</span>
                      <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800">100x Lev</span>
                      <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800">Bracket OCO</span>
                    </>
                  ) : (
                    <>
                      <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800">20x Margin</span>
                      <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800">Target/SL Edit</span>
                    </>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-5 pt-3 border-t border-slate-800 flex items-center justify-between gap-2">
                <button
                  onClick={() => handleTestConnection(acc)}
                  disabled={isTesting}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg flex items-center gap-1.5 transition-colors"
                >
                  <Zap className="w-3 h-3 text-emerald-400" />
                  <span>Test Connection</span>
                </button>

                <div className="flex items-center gap-2">
                  {!isCurrentActive ? (
                    <button
                      onClick={() => setActiveAccountId(acc.id)}
                      className="px-3 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/10 rounded-lg border border-emerald-500/20 transition-colors"
                    >
                      Make Active
                    </button>
                  ) : (
                    <span className="text-[11px] text-emerald-400 font-semibold px-2 py-1">Active</span>
                  )}

                  <button
                    onClick={() => handleDeleteAccount(acc.id, acc.accountName)}
                    className="p-1.5 text-slate-500 hover:text-rose-400 rounded transition-colors"
                    title="Remove Account"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 max-w-lg w-full shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <PlusCircle className="w-4 h-4 text-emerald-400" />
                <span>Connect Crypto Exchange Account</span>
              </h2>
              <button onClick={() => setShowAddModal(false)} className="text-slate-500 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleAddAccount} className="flex flex-col gap-3 mt-4">
              <div>
                <label className="text-[11px] text-slate-400 font-medium">Select Exchange</label>
                <select
                  value={broker}
                  onChange={(e) => setBroker(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white mt-1 focus:outline-none focus:border-emerald-500"
                >
                  <option value="coinswitch">CoinSwitch PRO (Ed25519 signing)</option>
                  <option value="delta">Delta Exchange India (HMAC signing)</option>
                  <option value="coindcx">CoinDCX Prime Trading (HMAC signing)</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] text-slate-400 font-medium">Account Nickname</label>
                <input
                  type="text"
                  placeholder="e.g. My Delta Trading Desk"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white mt-1 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="text-[11px] text-slate-400 font-medium">Trading Segment</label>
                <select
                  value={segment}
                  onChange={(e) => setSegment(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white mt-1 focus:outline-none focus:border-emerald-500"
                >
                  <option value="SPOT">SPOT (Physical crypto holdings)</option>
                  <option value="FUTURES">FUTURES / PERPETUALS (Leverage & Margining)</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] text-slate-400 font-medium">API Key</label>
                <input
                  type="text"
                  placeholder="Paste your exchange API Key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-white mt-1 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="text-[11px] text-slate-400 font-medium">
                  {broker === 'coinswitch' ? 'Ed25519 Secret Key / Seed' : 'API Secret (HMAC-SHA256)'}
                </label>
                <input
                  type="password"
                  placeholder={broker === 'coinswitch' ? '64-hex char seed or PEM' : 'Exchange Secret Key'}
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-white mt-1 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors"
                >
                  {isSubmitting ? 'Verifying...' : 'Save & Connect'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
