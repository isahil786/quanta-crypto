import React from 'react';
import {
  Activity,
  Layers,
  ArrowLeftRight,
  ShieldCheck,
  Cpu,
  Sliders,
  Server,
  TrendingUp,
  Bot,
  Sparkles,
} from 'lucide-react';

export default function Layout({ activeTab, setActiveTab, accounts, activeAccountId, setActiveAccountId, feedOk = true, wsConnected = false, children }) {
  const activeAccount = accounts.find((a) => a.id === activeAccountId) || accounts[0];

  const navLinks = [
    { id: 'dashboard', label: 'Terminal', icon: Activity },
    { id: 'bots', label: 'Algo Bots', icon: Bot },
    { id: 'backtest', label: 'Backtesting', icon: Sparkles },
    { id: 'trades', label: 'Orders & Trades', icon: ArrowLeftRight },
    { id: 'positions', label: 'Positions & Balances', icon: Layers },
    { id: 'gtt', label: 'GTT Rules', icon: Sliders },
    { id: 'mirror', label: 'Mirror Trading', icon: Cpu },
    { id: 'accounts', label: 'Exchange Accounts', icon: ShieldCheck },
    { id: 'screener', label: 'Screener', icon: TrendingUp },
    { id: 'test-api', label: 'API Console', icon: Server },
  ];

  const getBrokerBadge = (broker) => {
    switch (broker) {
      case 'coinswitch':
        return { label: 'CoinSwitch PRO', color: 'text-amber-400 border-amber-500/30 bg-amber-500/10' };
      case 'delta':
        return { label: 'Delta India', color: 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10' };
      case 'coindcx':
        return { label: 'CoinDCX Prime', color: 'text-blue-400 border-blue-500/30 bg-blue-500/10' };
      default:
        return { label: 'Crypto Exchange', color: 'text-slate-400 border-slate-700 bg-slate-800' };
    }
  };

  const badge = activeAccount ? getBrokerBadge(activeAccount.broker) : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500/20">
      {/* Top Bar Contract: Zone 1 (Wordmark) - Zone 2 (Nav Links) - Zone 3 (Account & Actions) */}
      <header className="h-14 border-b border-slate-800/80 bg-slate-900/70 backdrop-blur-md px-4 lg:px-6 flex items-center justify-between gap-6 shrink-0 z-40 sticky top-0">
        {/* Zone 1: Brand Wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-7 h-7 rounded bg-gradient-to-tr from-emerald-500 to-cyan-400 flex items-center justify-center font-black text-slate-950 text-sm tracking-tighter">
            QC
          </div>
          <span className="font-bold text-base tracking-tight text-white whitespace-nowrap">
            QuantaCrypto <span className="text-xs font-normal text-slate-400">Terminal</span>
          </span>
        </div>

        {/* Zone 2: Navigation Links */}
        <nav className="hidden xl:flex items-center gap-1">
          {navLinks.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-slate-800 text-emerald-400 shadow-sm border border-slate-700/60'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Active Account & Segment Selector */}
        <div className="flex items-center gap-3 shrink-0">
          {activeAccount && (
            <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-lg p-1">
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${badge.color}`}>
                {badge.label}
              </span>
              <select
                value={activeAccountId}
                onChange={(e) => setActiveAccountId(e.target.value)}
                className="bg-transparent text-xs text-slate-300 font-medium focus:outline-none cursor-pointer pr-2"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id} className="bg-slate-900 text-slate-200">
                    {acc.accountName} ({acc.segment})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-2 text-xs text-slate-400 pl-2 border-l border-slate-800 hidden md:flex">
            <span>Paper Trading</span>
            <span className="w-2 h-2 rounded-full bg-amber-400" title="Orders are simulated; nothing is sent to the exchanges" />
          </div>
        </div>
      </header>

      {/* Sub-header navigation on mobile/tablet screens */}
      <div className="xl:hidden bg-slate-900/90 border-b border-slate-800/80 px-4 py-2 flex items-center gap-1 overflow-x-auto scrollbar-none">
        {navLinks.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-slate-800 text-emerald-400 border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-[1720px] mx-auto p-4 lg:p-6 flex flex-col">
        {children}
      </main>

      {/* Footer */}
      <footer className="h-10 border-t border-slate-800/80 bg-slate-950 px-6 flex items-center justify-between text-xs text-slate-500 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-slate-400">Live Binance Feed</span>
          <span>·</span>
          <span className="text-emerald-400 font-mono">Top 100 Momentum Coins</span>
          <span>·</span>
          <span>CoinSwitch (Ed25519)</span>
          <span>·</span>
          <span>Delta India (HMAC)</span>
          <span>·</span>
          <span>CoinDCX (HMAC)</span>
        </div>
        <div className="flex items-center gap-2 font-mono tabular-nums text-slate-400 text-[11px]">
          <span className={`w-2 h-2 rounded-full ${feedOk ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
          <span className={`font-bold ${feedOk ? 'text-emerald-400' : 'text-rose-400'}`}>
            {feedOk ? 'Binance REST: Synchronized' : 'Binance price feed unavailable'}
          </span>
          <span className="text-slate-500">·</span>
          <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`} />
          <span className={`font-bold ${wsConnected ? 'text-emerald-400' : 'text-slate-400'}`}>
            {wsConnected ? 'Live WebSocket' : 'WebSocket connecting…'}
          </span>
        </div>
      </footer>
    </div>
  );
}
