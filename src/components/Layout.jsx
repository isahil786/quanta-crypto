import React, { useEffect, useState } from 'react';
import CommandPalette from '../ui/CommandPalette.jsx';
import {
  Activity, Layers, ArrowLeftRight, ShieldCheck, Cpu, Server,
  TrendingUp, ShieldAlert, Bot, Sparkles, PieChart, Sun, Moon, Contrast, Rows3,
} from 'lucide-react';

// Grouped by intent: trade, automate, portfolio, settings.
const NAV_GROUPS = [
  [
    { id: 'dashboard', label: 'Terminal', icon: Activity },
    { id: 'screener', label: 'Screener', icon: TrendingUp },
  ],
  [
    { id: 'bots', label: 'Algo Bots', icon: Bot },
    { id: 'backtest', label: 'Backtesting', icon: Sparkles },
    { id: 'mirror', label: 'Mirror Trading', icon: Cpu },
  ],
  [
    { id: 'trades', label: 'Orders & Trades', icon: ArrowLeftRight },
    { id: 'risk', label: 'Risk Cockpit', icon: ShieldAlert },
    { id: 'positions', label: 'Positions & Balances', icon: Layers },
    { id: 'pnl', label: 'P&L', icon: PieChart },
  ],
  [
    { id: 'accounts', label: 'Exchange Accounts', icon: ShieldCheck },
    { id: 'test-api', label: 'API Console', icon: Server },
  ],
];
const ALL_LINKS = NAV_GROUPS.flat();

const BROKER = {
  coinswitch: { label: 'CoinSwitch PRO', dot: '#E8A838' },
  delta: { label: 'Delta India', dot: '#38BDF8' },
  coindcx: { label: 'CoinDCX Prime', dot: '#A78BFA' },
};
const THEMES = ['dark', 'light', 'contrast'];
const THEME_ICON = { dark: Moon, light: Sun, contrast: Contrast };

function usePref(key, fallback, attr) {
  const [value, setValue] = useState(() => {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  });
  useEffect(() => {
    document.documentElement.setAttribute(attr, value);
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  }, [key, value, attr]);
  return [value, setValue];
}

export default function Layout({ activeTab, setActiveTab, accounts, activeAccountId, setActiveAccountId, feedOk = true, wsConnected = false, tickers = [], onSelectPair, children }) {
  const [theme, setTheme] = usePref('qc-theme', 'dark', 'data-theme');
  const [density, setDensity] = usePref('qc-density', 'comfortable', 'data-density');
  const activeAccount = accounts.find((a) => a.id === activeAccountId) || accounts[0];
  const isLive = activeAccount?.mode === 'REAL';
  const broker = BROKER[activeAccount?.broker] || { label: 'Exchange', dot: '#8e97a8' };
  const ThemeIcon = THEME_ICON[theme];
  const current = ALL_LINKS.find((l) => l.id === activeTab);

  const cycleTheme = () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]);

  return (
    <div className="min-h-screen bg-canvas text-ink font-sans md:grid md:grid-cols-[72px_1fr]">
      <CommandPalette
        pages={ALL_LINKS.map((l) => ({ ...l, shortcut: { dashboard: 'G T', positions: 'G P', trades: 'G O' }[l.id] }))}
        tickers={tickers}
        onGoPage={setActiveTab}
        onSelectPair={(sym) => { onSelectPair?.(sym); setActiveTab('dashboard'); }}
        extraActions={[
          { label: 'Switch theme', hint: '', run: cycleTheme },
          { label: 'Toggle compact density', hint: '', run: () => setDensity(density === 'compact' ? 'comfortable' : 'compact') },
        ]}
      />
      {isLive && <div aria-hidden className="fixed inset-x-0 top-0 h-1 bg-live-stripe z-50" />}

      {/* Icon rail (tablet and desktop) */}
      <aside className="hidden md:flex sticky top-0 h-screen flex-col items-center gap-1 border-r border-line bg-surface py-6">
        <div className="mb-4 grid size-10 place-items-center rounded-xl bg-accent font-bold text-canvas">Q</div>
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className="flex flex-col items-center gap-1 border-t border-line/60 pt-2 first:border-0 first:pt-0 mt-2 first:mt-0">
            {group.map(({ id, label, icon: Icon }) => {
              const on = activeTab === id;
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  aria-label={label}
                  aria-current={on ? 'page' : undefined}
                  title={label}
                  className={`group relative grid size-11 place-items-center rounded-xl transition-colors ${
                    on ? 'bg-raised text-ink ring-1 ring-line' : 'text-muted hover:bg-raised/60 hover:text-ink'
                  }`}
                >
                  <Icon className="size-5" strokeWidth={1.7} />
                  <span className="pointer-events-none absolute left-14 z-50 whitespace-nowrap rounded-lg border border-line bg-raised px-2.5 py-1 text-xs font-medium text-ink opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        <div className="mt-auto flex flex-col gap-1">
          <button onClick={cycleTheme} aria-label={`Theme: ${theme}. Click to change`} title={`Theme: ${theme}`} className="grid size-11 place-items-center rounded-xl text-muted hover:bg-raised/60 hover:text-ink">
            <ThemeIcon className="size-5" strokeWidth={1.7} />
          </button>
          <button
            onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
            aria-pressed={density === 'compact'}
            aria-label="Compact density"
            title={`Density: ${density}`}
            className={`grid size-11 place-items-center rounded-xl hover:bg-raised/60 ${density === 'compact' ? 'text-accent' : 'text-muted hover:text-ink'}`}
          >
            <Rows3 className="size-5" strokeWidth={1.7} />
          </button>
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-col pb-16 md:pb-0">
        {/* Top bar: page context left, account and mode right. Mode is visible at every width. */}
        <header className="sticky top-1 z-40 flex h-14 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur lg:px-6">
          <div className="md:hidden grid size-8 place-items-center rounded-lg bg-accent text-sm font-bold text-canvas">Q</div>
          <h1 className="truncate text-sm font-semibold text-ink">{current?.label}</h1>
          <div className="flex-1" />
          <button
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}
            className="hidden items-center gap-3 rounded-xl border border-line bg-surface px-3 py-1.5 text-xs text-muted hover:text-ink sm:flex"
            aria-label="Open command palette"
          >
            Search pairs, pages
            <kbd className="rounded border border-line px-1.5 font-mono text-[11px]">Ctrl K</kbd>
          </button>
          {activeAccount && (
            <div
              title={isLive ? 'Orders on this account are sent to the real exchange' : 'Orders are simulated; nothing is sent to the exchange'}
              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 ${
                isLive ? 'border-live/50 bg-live/10' : 'border-line bg-surface'
              }`}
            >
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: broker.dot }} aria-hidden />
              <label className="sr-only" htmlFor="acct">Account</label>
              <select
                id="acct"
                value={activeAccountId}
                onChange={(e) => setActiveAccountId(e.target.value)}
                className="max-w-[10rem] cursor-pointer truncate bg-transparent text-xs font-semibold text-ink"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id} className="bg-surface text-ink">
                    {acc.accountName} ({acc.segment})
                  </option>
                ))}
              </select>
              <span className="hidden text-xs text-muted lg:inline">{broker.label}</span>
              <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${isLive ? 'bg-live text-canvas' : 'bg-paper/15 text-paper'}`}>
                {isLive ? 'LIVE' : 'PAPER'}
              </span>
            </div>
          )}
        </header>

        <main className="mx-auto flex w-full max-w-[1720px] flex-1 flex-col p-4 lg:p-6">{children}</main>

        {/* Status bar: real connection state */}
        <footer className="hidden h-9 items-center gap-5 border-t border-line bg-surface px-6 font-mono text-xs text-muted md:flex">
          <span className={`flex items-center gap-2 ${feedOk ? 'text-up' : 'text-down'}`}>
            <span className={`size-2 rounded-full ${feedOk ? 'bg-up' : 'bg-down'}`} />
            {feedOk ? 'Binance REST synced' : 'Binance price feed unavailable'}
          </span>
          <span className={`flex items-center gap-2 ${wsConnected ? 'text-up' : 'text-muted'}`}>
            <span className={`size-2 rounded-full ${wsConnected ? 'bg-up' : 'bg-line2'}`} />
            {wsConnected ? 'WebSocket live' : 'WebSocket connecting…'}
          </span>
        </footer>
      </div>

      {/* Bottom tab bar (phones) */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex h-16 overflow-x-auto border-t border-line bg-surface md:hidden scrollbar-none" aria-label="Main">
        {ALL_LINKS.map(({ id, label, icon: Icon }) => {
          const on = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              aria-current={on ? 'page' : undefined}
              className={`flex min-w-[4.5rem] flex-1 flex-col items-center justify-center gap-1 text-[11px] ${on ? 'text-ink' : 'text-muted'}`}
            >
              <Icon className="size-5" strokeWidth={1.7} />
              <span className="max-w-full truncate px-1">{label.split(' ')[0]}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
