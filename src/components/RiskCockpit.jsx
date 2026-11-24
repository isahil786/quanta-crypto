import React, { useEffect, useMemo, useState } from 'react';

const BROKER_COLOR = { coinswitch: '#E8A838', delta: '#38BDF8', coindcx: '#A78BFA' };
const BROKER_NAME = { coinswitch: 'CoinSwitch', delta: 'Delta India', coindcx: 'CoinDCX' };
const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const usd = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const usd2 = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const x = a.slice(-n); const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n; const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

function Tile({ label, value, tone = 'text-ink', hint }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-semibold ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** What you are exposed to right now, across every account. Read-only: it never places or changes orders. */
export default function RiskCockpit({ accounts = [] }) {
  const [positions, setPositions] = useState([]);
  const [trades, setTrades] = useState([]);
  const [returns, setReturns] = useState({});
  const [loading, setLoading] = useState(true);
  const [marginWarn] = useState(60); // % of equity; turns the tile warning-coloured
  const [liqWarn] = useState(10); // % distance from mark

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [p, t] = await Promise.all([fetch('/api/positions'), fetch('/api/trades')]);
        if (p.ok && alive) setPositions(await p.json());
        if (t.ok && alive) { const d = await t.json(); setTrades(Array.isArray(d) ? d : d.trades || []); }
      } catch { /* keep last data */ } finally { if (alive) setLoading(false); }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const symbols = useMemo(() => {
    const held = [...new Set(positions.map((p) => p.symbol))];
    return [...held, ...DEFAULT_SYMBOLS.filter((s) => !held.includes(s))].slice(0, 5);
  }, [positions]);

  // 30 days of daily closes, once per symbol set
  useEffect(() => {
    let alive = true;
    Promise.all(symbols.map(async (sym) => {
      try {
        const res = await fetch(`/api/market/klines?symbol=${sym}&interval=1d&limit=31`);
        if (!res.ok) return [sym, []];
        const rows = await res.json();
        const closes = rows.map((k) => k.close);
        return [sym, closes.slice(1).map((c, i) => (c - closes[i]) / closes[i])];
      } catch { return [sym, []]; }
    })).then((pairs) => { if (alive) setReturns(Object.fromEntries(pairs)); });
    return () => { alive = false; };
  }, [symbols]);

  const equity = accounts.reduce((s, a) => s + Number(a.totalEquityUSDT || 0), 0);
  const unrealized = positions.reduce((s, p) => s + Number(p.unrealizedPnl || 0), 0);
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const realizedToday = trades.filter((t) => t.timestamp && new Date(t.timestamp) >= startOfDay).reduce((s, t) => s + Number(t.realizedPnl || 0), 0);
  const dayPnl = realizedToday + unrealized;
  const marginUsed = positions.reduce((s, p) => s + Number(p.margin || 0), 0);
  const marginPct = equity > 0 ? (marginUsed / equity) * 100 : 0;
  const liqDistances = positions.filter((p) => p.liquidationPrice && p.markPrice).map((p) => ({ p, d: (Math.abs(p.markPrice - p.liquidationPrice) / p.markPrice) * 100 }));
  const nearest = liqDistances.length ? liqDistances.reduce((a, b) => (b.d < a.d ? b : a)) : null;

  const byBroker = {};
  positions.forEach((p) => {
    const k = p.broker || 'other';
    byBroker[k] = byBroker[k] || { long: 0, short: 0 };
    byBroker[k][p.side === 'LONG' ? 'long' : 'short'] += Math.abs(Number(p.size || 0) * Number(p.markPrice || 0));
  });
  const brokerRows = Object.entries(byBroker);
  const maxSide = Math.max(1, ...brokerRows.flatMap(([, v]) => [v.long, v.short]));
  const net = brokerRows.reduce((s, [, v]) => s + v.long - v.short, 0);
  const netPct = equity > 0 ? (net / equity) * 100 : 0;

  const events = [];
  if (marginPct > marginWarn) events.push(['Margin', 'warn', `Margin used is ${marginPct.toFixed(0)}% of equity (limit ${marginWarn}%)`]);
  liqDistances.filter((x) => x.d < liqWarn).forEach((x) => events.push(['Liquidation', 'down', `${x.p.symbol} is ${x.d.toFixed(1)}% from liquidation`]));
  positions.filter((p) => Number(p.unrealizedPnl) < 0 && equity > 0 && Math.abs(p.unrealizedPnl) / equity > 0.01).forEach((p) => events.push(['Loss', 'down', `${p.symbol} is down ${usd2(p.unrealizedPnl)}`]));

  const tone = { warn: 'bg-live/15 text-live', down: 'bg-down/15 text-down' };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Risk cockpit</h1>
        <p className="text-sm text-muted">What you are exposed to right now, across all exchanges.</p>
      </div>

      {loading ? <div className="h-24 animate-pulse rounded-xl bg-raised" aria-busy="true" /> : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Tile label="Equity, all accounts" value={usd(equity)} />
            <Tile label="Day P&L" value={`${dayPnl >= 0 ? '▲ ' : '▼ '}${usd2(dayPnl)}`} tone={dayPnl >= 0 ? 'text-up' : 'text-down'} />
            <Tile label="Margin used" value={`${marginPct.toFixed(0)}%`} tone={marginPct > marginWarn ? 'text-live' : 'text-ink'} hint={`Warns above ${marginWarn}%`} />
            <Tile
              label="Nearest liquidation"
              value={nearest ? `${nearest.d.toFixed(1)}% away` : 'None'}
              tone={nearest && nearest.d < liqWarn ? 'text-down' : nearest ? 'text-live' : 'text-ink'}
              hint={nearest ? `${nearest.p.symbol} ${nearest.p.side}` : 'No leveraged positions'}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <section className="rounded-xl border border-line bg-surface p-5">
              <h2 className="mb-4 text-sm font-semibold text-ink">Exposure by exchange</h2>
              {brokerRows.length === 0 && <p className="text-sm text-muted">No open positions.</p>}
              {brokerRows.map(([k, v]) => (
                <div key={k} className="mb-4">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="size-2.5 rounded-full" style={{ background: BROKER_COLOR[k] || '#8e97a8' }} aria-hidden />
                    <b className="text-ink">{BROKER_NAME[k] || k}</b>
                    <span className="ml-auto font-mono text-xs text-muted">Long {usd(v.long)} · Short {usd(v.short)}</span>
                  </div>
                  <div className="mt-2 space-y-1">
                    <div className="h-1.5 rounded-full bg-raised"><div className="h-full rounded-full bg-up" style={{ width: `${(v.long / maxSide) * 100}%` }} /></div>
                    <div className="h-1.5 rounded-full bg-raised"><div className="h-full rounded-full bg-down" style={{ width: `${(v.short / maxSide) * 100}%` }} /></div>
                  </div>
                </div>
              ))}
              {brokerRows.length > 0 && <p className="text-xs text-muted">Net exposure {net >= 0 ? '+' : '−'}{usd(Math.abs(net))}, {Math.abs(netPct).toFixed(0)}% of equity. Not leverage-adjusted.</p>}
            </section>

            <section className="rounded-xl border border-line bg-surface p-5">
              <h2 className="mb-4 text-sm font-semibold text-ink">Correlation, 30 days</h2>
              <div className="grid gap-1.5" style={{ gridTemplateColumns: `auto repeat(${symbols.length}, 1fr)` }}>
                <span />
                {symbols.map((s) => <span key={s} className="text-center text-[11px] text-muted">{s.replace('USDT', '')}</span>)}
                {symbols.map((a) => (
                  <React.Fragment key={a}>
                    <span className="pr-1 text-[11px] text-muted">{a.replace('USDT', '')}</span>
                    {symbols.map((b) => {
                      const c = a === b ? 1 : correlation(returns[a] || [], returns[b] || []);
                      return (
                        <span key={b} title={c == null ? 'No data' : c.toFixed(2)} className="rounded-md py-2 text-center font-mono text-xs text-ink" style={{ background: c == null ? 'transparent' : `color-mix(in srgb, var(--c-accent) ${Math.round(Math.max(0, c) * 70)}%, transparent)` }}>
                          {c == null ? '—' : c.toFixed(2)}
                        </span>
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted">Highly correlated positions behave like one bet. Daily returns from the same candles the chart uses.</p>
            </section>

            <section className="rounded-xl border border-line bg-surface p-5">
              <h2 className="mb-2 text-sm font-semibold text-ink">Risk events</h2>
              {events.length === 0 && <p className="text-sm text-muted">Nothing needs attention right now.</p>}
              {events.map(([k, t, text], i) => (
                <div key={i} className="flex items-start gap-3 border-t border-line py-2.5 text-sm first:border-0">
                  <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${tone[t]}`}>{k}</span>
                  <span className="text-ink2">{text}</span>
                </div>
              ))}
              <p className="mt-2 text-xs text-muted">Checked live from your positions. Thresholds are fixed for now.</p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
