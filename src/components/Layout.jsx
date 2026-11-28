import React, { useCallback, useEffect, useState } from 'react';
import CommandPalette from '../ui/CommandPalette.jsx';
import {
  Activity, Layers, ArrowLeftRight, ShieldCheck, Cpu, Server,
  TrendingUp, ShieldAlert, Bot, Sparkles, PieChart, Sun, Moon, Contrast, Rows3,
  PanelLeftClose, PanelLeftOpen, Menu, X,
} from 'lucide-react';

// Grouped by intent: trade, automate, portfolio, settings.
const NAV_GROUPS = [
  { title: 'Trade', items: [
    { id: 'dashboard', label: 'Terminal', icon: Activity },
    { id: 'screener', label: 'Screener', icon: TrendingUp },
  ] },
  { title: 'Automate', items: [
    { id: 'bots', label: 'Algo Bots', icon: Bot },
    { id: 'backtest', label: 'Backtesting', icon: Sparkles },
    { id: 'mirror', label: 'Mirror Trading', icon: Cpu },
  ] },
  { title: 'Portfolio', items: [
    { id: 'trades', label: 'Orders & Trades', icon: ArrowLeftRight },
    { id: 'risk', label: 'Risk Cockpit', icon: ShieldAlert },
    { id: 'positions', label: 'Positions & Balances', icon: Layers },
    { id: 'pnl', label: 'P&L', icon: PieChart },
  ] },
  { title: 'Settings', items: [
    { id: 'accounts', label: 'Exchange Accounts', icon: ShieldCheck },
    { id: 'test-api', label: 'API Console', icon: Server },
  ] },
];
const ALL_LINKS = NAV_GROUPS.flatMap((g) => g.items);

const BROKER = {
  coinswitch: { label: 'CoinSwitch PRO', dot: '#E8A838' },
  delta: { label: 'Delta India', dot: '#38BDF8' },
  coindcx: { label: 'CoinDCX Prime', dot: '#A78BFA' },
  binance: { label: 'Binance Spot', dot: '#F0B90B' },
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

/** Tracks a CSS media query so the sidebar can behave as a rail on desktop and a drawer on phones. */
function useMediaQuery(query) {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : true));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
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

  // Sidebar: a slim rail (desktop, remembered) or an off-canvas drawer (phones)
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('qc-sidebar') === 'collapsed'; } catch { return false; }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem('qc-sidebar', collapsed ? 'collapsed' : 'open'); } catch { /* storage unavailable */ }
  }, [collapsed]);
  useEffect(() => { if (isDesktop) setDrawerOpen(false); }, [isDesktop]);
  const toggleSidebar = useCallback(() => {
    if (isDesktop) setCollapsed((c) => !c); else setDrawerOpen((o) => !o);
  }, [isDesktop]);
  // Ctrl/Cmd+B toggles; Escape closes the phone drawer; the page behind it does not scroll while it is open
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
      else if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [drawerOpen]);

  const go = (id) => { setActiveTab(id); setDrawerOpen(false); };
  // On phones the drawer is always full width with labels; only desktop uses the rail
  const rail = isDesktop && collapsed;
  const labelCls = `overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 ${rail ? 'max-w-0 opacity-0' : 'max-w-[180px] opacity-100'}`;
  const tip = (text) => rail && (
    <span role="tooltip" className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-lg border border-line bg-raised px-2.5 py-1 text-xs font-medium text-ink opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
      {text}
    </span>
  );
  const itemCls = (on) => `group relative flex h-10 w-full items-center gap-3 rounded-xl px-[10px] text-sm font-medium transition-colors ${
    on ? 'bg-raised text-ink ring-1 ring-line' : 'text-muted hover:bg-raised/60 hover:text-ink'
  }`;

  return (
    <div className="min-h-screen bg-canvas text-ink font-sans md:flex">
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

      {/* Phone drawer backdrop */}
      {drawerOpen && !isDesktop && (
        <button aria-label="Close menu" tabIndex={-1} onClick={() => setDrawerOpen(false)} className="fixed inset-0 z-[55] bg-black/55 md:hidden" />
      )}

      {/* Sidebar: slides between full width and a slim rail on desktop; off-canvas drawer on phones */}
      <aside
        id="sidebar"
        data-sidebar
        inert={!isDesktop && !drawerOpen}
        aria-label="Sidebar"
        className={`fixed inset-y-0 left-0 z-[60] flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface transition-[transform,width] duration-200 ease-out
          ${drawerOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}
          md:sticky md:top-0 md:z-50 md:h-screen md:max-w-none md:shrink-0 md:translate-x-0 md:shadow-none ${collapsed ? 'md:w-16' : 'md:w-64'}`}
      >
        <div className={`flex h-14 shrink-0 items-center gap-2 px-3 ${rail ? 'justify-center' : 'justify-between'}`}>
          {!rail && (
            <div className="flex min-w-0 items-center gap-2.5 pl-0.5">
              <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-sm font-bold text-canvas">Q</div>
              <span className="truncate text-sm font-semibold tracking-tight text-ink">Quanta Crypto</span>
            </div>
          )}
          <button
            onClick={toggleSidebar}
            aria-label={isDesktop ? (collapsed ? 'Expand sidebar' : 'Collapse sidebar') : 'Close menu'}
            aria-expanded={isDesktop ? !collapsed : drawerOpen}
            aria-controls="sidebar"
            title={isDesktop ? `${collapsed ? 'Expand' : 'Collapse'} sidebar (Ctrl+B)` : 'Close menu'}
            className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-raised/60 hover:text-ink"
          >
            {!isDesktop ? <X className="size-5" strokeWidth={1.7} /> : collapsed ? <PanelLeftOpen className="size-5" strokeWidth={1.7} /> : <PanelLeftClose className="size-5" strokeWidth={1.7} />}
          </button>
        </div>

        <nav aria-label="Main" className="scrollbar-none flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.title} className="mt-3 first:mt-1">
              {rail
                ? (gi > 0 && <div className="mx-2 mb-2 border-t border-line/60" />)
                : <div className="px-[10px] pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted/80">{group.title}</div>}
              <div className="flex flex-col gap-0.5">
                {group.items.map(({ id, label, icon: Icon }) => {
                  const on = activeTab === id;
                  return (
                    <button key={id} onClick={() => go(id)} aria-label={label} aria-current={on ? 'page' : undefined} className={itemCls(on)}>
                      <Icon className="size-5 shrink-0" strokeWidth={1.7} />
                      <span className={labelCls}>{label}</span>
                      {tip(label)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="shrink-0 space-y-0.5 border-t border-line/60 p-3">
          <button onClick={cycleTheme} aria-label={`Theme: ${theme}. Click to change`} className={itemCls(false)}>
            <ThemeIcon className="size-5 shrink-0" strokeWidth={1.7} />
            <span className={`${labelCls} capitalize`}>Theme: {theme}</span>
            {tip(`Theme: ${theme}`)}
          </button>
          <button onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')} aria-pressed={density === 'compact'} aria-label="Compact density" className={`${itemCls(false)} ${density === 'compact' ? '!text-accent' : ''}`}>
            <Rows3 className="size-5 shrink-0" strokeWidth={1.7} />
            <span className={labelCls}>{density === 'compact' ? 'Compact density' : 'Comfortable density'}</span>
            {tip(`Density: ${density}`)}
          </button>
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {/* Top bar: page context left, account and mode right. Mode is visible at every width. */}
        <header className="sticky top-1 z-40 flex h-14 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur lg:px-6">
          <button onClick={toggleSidebar} aria-label="Open menu" aria-controls="sidebar" aria-expanded={drawerOpen} className="grid size-9 place-items-center rounded-lg text-muted hover:bg-raised/60 hover:text-ink md:hidden">
            <Menu className="size-5" strokeWidth={1.7} />
          </button>
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

        <main className="mx-auto flex w-full max-w-[1720px] flex-1 flex-col p-4 lg:p-6">
          {children}
        </main>

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
    </div>
  );
}
