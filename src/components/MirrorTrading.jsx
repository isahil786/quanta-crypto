import React, { useState, useEffect } from 'react';
import DataTable from '../ui/DataTable.jsx';
import MirrorMonitor from '../ui/MirrorMonitor.jsx';
import {
  Cpu,
  Power,
  CheckCircle2,
  AlertCircle,
  Play,
  Shield,
  History,
  Download,
} from 'lucide-react';

export default function MirrorTrading({ accounts }) {
  const [mirrorData, setMirrorData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);

  const fetchMirrorData = async () => {
    try {
      const res = await fetch('/api/mirror');
      if (res.ok) {
        setMirrorData(await res.json());
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchMirrorData();
  }, []);

  const handleToggleGlobal = async () => {
    if (!mirrorData) return;
    const nextState = !mirrorData.config.enabled;
    try {
      const res = await fetch('/api/mirror/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextState }),
      });
      if (res.ok) {
        setNotice({
          type: 'success',
          text: `Mirror Trading Engine ${nextState ? 'ENABLED' : 'PAUSED'}`,
        });
        fetchMirrorData();
      }
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    }
  };

  const handleUpdateReplica = async (accountId, multiplier, active) => {
    try {
      const res = await fetch('/api/mirror/update-replica', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, multiplier, active }),
      });
      if (res.ok) {
        setNotice({
          type: 'success',
          text: 'Replica allocation updated successfully.',
        });
        fetchMirrorData();
      }
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    }
  };

  const handleSimulateMasterTrade = async () => {
    setLoading(true);
    try {
      // Post an order on the master account (Delta)
      const masterAcc = mirrorData?.masterAccount || accounts[0];
      // Fetch live price for accurate real-time execution
      const depthRes = await fetch('/api/market/depth?symbol=BTCUSDT');
      const depthData = depthRes.ok ? await depthRes.json() : null;
      const livePrice = depthData?.bestAsk || 76000.0;

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: masterAcc.id,
          symbol: 'BTCUSDT',
          side: 'BUY',
          orderType: 'LIMIT',
          price: livePrice,
          size: 0.1,
          leverage: 10,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed master trade');

      setNotice({
        type: 'success',
        text: `Master trade executed on ${masterAcc.accountName}! Automatically mirrored to active replica accounts.`,
      });
      fetchMirrorData();
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const downloadCsv = async () => {
    try {
      const res = await fetch('/api/mirror/logs/export');
      if (!res.ok) throw new Error('Failed to export audit log');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mirror-audit-log.csv';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      setNotice({
        type: 'success',
        text: 'Mirror audit log exported to CSV.',
      });
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    }
  };

  if (!mirrorData) {
    return <div className="p-8 text-center text-slate-500 text-xs">Loading mirror trading engine...</div>;
  }

  const { config, masterAccount } = mirrorData;

  return (
    <div className="flex flex-col gap-6">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-slate-900/60 border border-slate-800/80 rounded-xl px-5 py-4">
        <div>
          <h1 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
            <Cpu className="w-5 h-5 text-emerald-400" />
            <span>Multi-Exchange Mirror Trading</span>
          </h1>
          <p className="text-xs text-slate-400">
            Execute on Master account and automatically replicate across CoinSwitch, Delta Exchange, and CoinDCX.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSimulateMasterTrade}
            disabled={loading || !config.enabled}
            className={`px-3.5 py-2 text-xs font-bold text-white rounded-lg flex items-center gap-1.5 transition-colors border ${
              config.enabled
                ? 'bg-slate-800 hover:bg-slate-700 border-slate-700'
                : 'bg-slate-900 border-slate-800 opacity-50 cursor-not-allowed text-slate-500'
            }`}
          >
            <Play className="w-3.5 h-3.5 text-emerald-400" />
            <span>Simulate Master Signal</span>
          </button>

          <button
            onClick={handleToggleGlobal}
            className={`px-4 py-2 text-xs font-bold rounded-lg flex items-center gap-2 transition-colors ${
              config.enabled
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm'
                : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <Power className="w-3.5 h-3.5" />
            <span>{config.enabled ? 'Engine Active' : 'Engine Paused'}</span>
          </button>
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

      <MirrorMonitor config={config} masterAccount={masterAccount} accounts={accounts} />

      {/* Architecture Layout: Master Account Card -> Replica Accounts Matrix */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Master Account Configuration */}
        <div className="lg:col-span-4 bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <span className="text-xs font-semibold text-white">Designated Master Account</span>
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                Primary Signal Origin
              </span>
            </div>

            <div className="mt-4 p-4 bg-slate-950 border border-slate-800 rounded-xl">
              <div className="text-xs text-slate-400">Account Name</div>
              <div className="text-sm font-bold text-white mt-0.5">{masterAccount.accountName}</div>

              <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-slate-800/80 text-xs">
                <div>
                  <span className="text-slate-500 text-[11px]">Exchange</span>
                  <div className="font-semibold text-slate-200 capitalize">{masterAccount.broker}</div>
                </div>
                <div>
                  <span className="text-slate-500 text-[11px]">Segment</span>
                  <div className="font-semibold text-slate-200">{masterAccount.segment}</div>
                </div>
                <div>
                  <span className="text-slate-500 text-[11px]">Equity</span>
                  <div className="font-mono font-semibold text-emerald-400">${masterAccount.totalEquityUSDT?.toLocaleString()}</div>
                </div>
                <div>
                  <span className="text-slate-500 text-[11px]">Routing Mode</span>
                  <div className="font-semibold text-slate-300">{masterAccount.mode}</div>
                </div>
              </div>
            </div>

            <div className="mt-4 text-xs text-slate-400 space-y-2 bg-slate-950/40 p-3 rounded-lg border border-slate-800/60">
              <div className="flex items-start gap-2">
                <Shield className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Exact Order Copy:</strong> A Market order on the Master is copied to live replicas as a Market order, and a Limit order as a Limit order at the same price (scaled by each replica&apos;s multiplier). Paper replicas simulate a Market order as a Limit at the live price. Any exchange rejection shows in the log below.
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Replica Accounts Configuration Matrix */}
        <div className="lg:col-span-8 bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <span className="text-xs font-semibold text-white">Connected Replica Allocations</span>
              <span className="text-[11px] text-slate-500 font-mono">
                Active Replicas: {config.replicas.filter((r) => r.active).length}
              </span>
            </div>

            <div className="flex flex-col gap-3 mt-4">
              {config.replicas.map((rep) => {
                const targetAccount = accounts.find((a) => a.id === rep.accountId) || {
                  accountName: rep.accountId,
                  broker: 'unknown',
                  segment: 'SPOT',
                };
                return (
                  <div
                    key={rep.accountId}
                    className="p-4 bg-slate-950 border border-slate-800 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white">{targetAccount.accountName}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 capitalize">
                          {targetAccount.broker} ({targetAccount.segment})
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">{rep.note}</p>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <div className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800">
                        <span className="text-xs text-slate-400">Multiplier:</span>
                        <input
                          type="number"
                          step="0.1"
                          min="0.1"
                          max="5.0"
                          value={rep.multiplier}
                          onChange={(e) => handleUpdateReplica(rep.accountId, e.target.value, rep.active)}
                          className="w-16 bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-xs font-mono text-emerald-400 focus:outline-none focus:border-emerald-500"
                        />
                        <span className="text-xs text-slate-400">x</span>
                      </div>

                      <button
                        onClick={() => handleUpdateReplica(rep.accountId, rep.multiplier, !rep.active)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border ${
                          rep.active
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            : 'bg-slate-900 text-slate-500 border-slate-800'
                        }`}
                      >
                        {rep.active ? 'Mirrored' : 'Ignored'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Mirror Audit Logs */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-slate-400" />
            <span className="text-xs font-semibold text-white">Mirror Execution Audit Trail</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500 font-mono">Recent Actions: {config.logs?.length || 0}</span>
            <button
              onClick={downloadCsv}
              disabled={!config.logs?.length}
              className="px-3 py-1 text-xs font-semibold text-white bg-slate-700 hover:bg-emerald-600 border border-slate-600 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Download className="w-3 h-3" />
              Export CSV
            </button>
          </div>
        </div>
        <DataTable
          rows={config.logs || []}
          empty={'No mirror actions yet. Click "Simulate Master Signal" or place an order on the master account to see replication logs.'}
          columns={[
            { key: 'masterOrder', header: 'Master order', primary: true, mono: false, render: (l) => <b className="text-ink">{l.masterOrder}</b> },
            { key: 'timestamp', header: 'Time', render: (l) => <span className="text-xs text-muted">{new Date(l.timestamp).toLocaleTimeString()}</span> },
            { key: 'targetAccount', header: 'Replica', mono: false },
            { key: 'status', header: 'Status', mono: false, render: (l) => (
              <span className={`rounded px-2 py-0.5 text-xs font-bold ${l.status === 'EXECUTED' ? 'bg-up/10 text-up' : 'bg-live/10 text-live'}`}>{l.status === 'EXECUTED' ? '✓ ' : '! '}{l.status}</span>
            ) },
            { key: 'details', header: 'Notes', mono: false, render: (l) => <span className="text-xs text-ink2">{l.details}</span> },
          ]}
        />
      </div>
    </div>
  );
}
