import React, { useState, useEffect, useRef } from 'react';
import DataTable from '../ui/DataTable.jsx';
import {
  Search,
  Zap,
  ShieldCheck,
} from 'lucide-react';

// Squarified treemap: lays items (each with .area, summing to w*h) into rectangles that stay close to square.
function squarify(items, x, y, w, h) {
  const out = [];
  const rest = items.slice();
  const worst = (row, side) => {
    const sum = row.reduce((a, r) => a + r.area, 0);
    const mx = Math.max(...row.map((r) => r.area));
    const mn = Math.min(...row.map((r) => r.area));
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };
  while (rest.length) {
    const side = Math.min(w, h);
    const row = [];
    while (rest.length && (row.length === 0 || worst([...row, rest[0]], side) <= worst(row, side))) row.push(rest.shift());
    const sum = row.reduce((a, r) => a + r.area, 0);
    if (w >= h) {
      const colW = sum / h; let cy = y;
      row.forEach((r) => { const rh = r.area / colW; out.push({ item: r, x, y: cy, w: colW, h: rh }); cy += rh; });
      x += colW; w -= colW;
    } else {
      const rowH = sum / w; let cx = x;
      row.forEach((r) => { const rw = r.area / rowH; out.push({ item: r, x: cx, y, w: rw, h: rowH }); cx += rw; });
      y += rowH; h -= rowH;
    }
  }
  return out;
}

// Tiny 24h line. Colour follows direction and an arrow is not needed because the change column already carries one.
function Sparkline({ closes }) {
  if (!closes || closes.length < 2) return <span className="text-muted">—</span>;
  const lo = Math.min(...closes); const hi = Math.max(...closes); const span = hi - lo || 1;
  const pts = closes.map((c, i) => `${(i / (closes.length - 1)) * 80},${26 - ((c - lo) / span) * 24}`).join(' ');
  const up = closes[closes.length - 1] >= closes[0];
  return (
    <svg width="80" height="28" viewBox="0 0 80 28" role="img" aria-label={up ? '24 hour trend up' : '24 hour trend down'} className="mx-auto">
      <polyline points={pts} fill="none" strokeWidth="1.6" className={up ? 'stroke-up' : 'stroke-down'} />
    </svg>
  );
}

export default function Screener({ tickers, onSelectPair }) {
  const [view, setView] = useState('table'); // 'table' | 'heatmap'
  const mapRef = useRef(null);
  const [mapW, setMapW] = useState(0);
  const [spark, setSpark] = useState({}); // symbol -> closes over the last 24 hourly candles
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState('all'); // 'all', 'halal', 'gainers', 'volume', 'breakouts', 'top10'
  const [sortBy, setSortBy] = useState('momentumRank');
  const [sortAsc, setSortAsc] = useState(true);

  // Live halal coin data fetched from the server (merged with live Binance prices).
  const [halalCoins, setHalalCoins] = useState([]);
  const [halalMeta, setHalalMeta] = useState(null);
  const [halalLoading, setHalalLoading] = useState(true);

  const fetchHalal = () => {
    fetch('/api/halal/coins')
      .then((r) => {
        if (r.ok) return r.json();
        throw new Error('halal feed unavailable');
      })
      .then((data) => {
        setHalalCoins(data.tradable || []);
        setHalalMeta(data.meta || null);
      })
      .catch(() => {
        setHalalCoins([]);
      })
      .finally(() => {
        setHalalLoading(false);
      });
  };

  useEffect(() => {
    if (filterMode !== 'halal') {
      setHalalCoins([]);
      setHalalMeta(null);
      setHalalLoading(true);
      return;
    }
    fetchHalal();
    const timer = setInterval(fetchHalal, 3000); // live refresh like the momentum screener
    return () => clearInterval(timer);
  }, [filterMode]);

  // Build the active list: either live halal coins or the local momentum tickers.
  let processed;
  let listTitle;
  let listSubtitle;
  if (filterMode === 'halal') {
    processed = halalCoins.filter((p) => {
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!p.symbol.toLowerCase().includes(q) && !p.base?.toLowerCase().includes(q) && !p.name?.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });
    processed.sort((a, b) => {
      const va = Number(a[sortBy] ?? a.halalRank) || 0;
      const vb = Number(b[sortBy] ?? b.halalRank) || 0;
      if (valGt(va, vb)) return sortAsc ? -1 : 1;
      if (valGt(vb, va)) return sortAsc ? 1 : -1;
      return 0;
    });
    listTitle = 'Halal Screened Coins';
    listSubtitle = `${processed.length} live halal USDT pairs${halalMeta ? ` • ${halalMeta.listed} listed on coinranking` : ''}`;
  } else {
    processed = tickers.filter((p) => {
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!p.symbol.toLowerCase().includes(q) && !p.base?.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (filterMode === 'gainers') return p.change24h > 0;
      if (filterMode === 'volume') return p.quoteVolume >= 50000000;
      if (filterMode === 'breakouts') return p.rangePosition >= 75;
      if (filterMode === 'top10') return (p.momentumRank || 100) <= 10;
      return true;
    });
    processed.sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (sortBy === 'price' || sortBy === 'change24h' || sortBy === 'quoteVolume' || sortBy === 'momentumRank' || sortBy === 'rangePosition') {
        valA = Number(valA) || 0;
        valB = Number(valB) || 0;
      }
      if (valA < valB) return sortAsc ? -1 : 1;
      if (valA > valB) return sortAsc ? 1 : -1;
      return 0;
    });
    listTitle = 'Top 100 Momentum Coins Screener';
    listSubtitle = 'Top 100 liquid USDT pairs ranked by 24h price change (minimum $1M daily turnover); volume and range position shown for context.';
  }

  function valGt(x, y) {
    return x > y;
  }

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(field);
      setSortAsc(field === 'momentumRank' || field === 'halalRank');
    }
  };

  const isHalalActive = filterMode === 'halal';

  // Heatmap width, so the treemap can pick a sensible height for phones and desktops
  useEffect(() => {
    if (view !== 'heatmap' || !mapRef.current) return undefined;
    setMapW(mapRef.current.clientWidth);
    const ro = new ResizeObserver(([e]) => setMapW(e.contentRect.width));
    ro.observe(mapRef.current);
    return () => ro.disconnect();
  }, [view]);

  // Sparklines: fetch the first 20 listed rows only (one klines call each, cached), not all 100.
  const sparkKey = processed.slice(0, 20).map((r) => r.symbol).join(',');
  useEffect(() => {
    let alive = true;
    const todo = sparkKey.split(',').filter((sym) => sym && !spark[sym]);
    (async () => {
      for (let i = 0; i < todo.length && alive; i += 5) {
        const batch = todo.slice(i, i + 5);
        const got = await Promise.all(batch.map(async (sym) => {
          try {
            const res = await fetch(`/api/market/klines?symbol=${sym}&interval=1h&limit=24`);
            if (!res.ok) return [sym, []];
            return [sym, (await res.json()).map((k) => k.close)];
          } catch { return [sym, []]; }
        }));
        if (alive) setSpark((prev) => ({ ...prev, ...Object.fromEntries(got) }));
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sparkKey]);

  const byVolume = processed.slice().sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0));

  // Treemap: tile area is proportional to 24h turnover. A small floor (0.5% of the total) keeps tiny coins clickable.
  const mapItems = byVolume.slice(0, 60);
  const mapH = mapW < 640 ? Math.round(mapW * 1.3) : Math.round(mapW * 0.5);
  const totalVol = mapItems.reduce((a, r) => a + (r.quoteVolume || 0), 0) || 1;
  const floored = mapItems.map((r) => ({ r, v: Math.max(r.quoteVolume || 0, totalVol * 0.005) }));
  const flooredSum = floored.reduce((a, t) => a + t.v, 0);
  const tiles = mapW > 0 ? squarify(floored.map((t) => ({ ...t.r, area: (t.v / flooredSum) * mapW * mapH })), 0, 0, mapW, mapH) : [];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-slate-900/60 border border-slate-800/80 rounded-xl px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <h1 className="text-lg font-bold text-white tracking-tight">
              {listTitle}
            </h1>
            <span className="text-[11px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
              {isHalalActive ? 'Live Halal Feed' : 'Live Binance Feed'}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">{listSubtitle}</p>
        </div>

        {/* Filter buttons & Search */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder={isHalalActive ? 'Search halal coin...' : 'Search coin (e.g. SOL, DOGE)...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500 w-52"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
            <button
              onClick={() => setFilterMode('all')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                filterMode === 'all' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All 100
            </button>
            <button
              onClick={() => setFilterMode('top10')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                filterMode === 'top10' ? 'bg-amber-950/80 text-amber-300 shadow-sm border border-amber-800/60' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Top 10 Elite
            </button>
            <button
              onClick={() => setFilterMode('gainers')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                filterMode === 'gainers' ? 'bg-emerald-950/80 text-emerald-300 shadow-sm border border-emerald-800/60' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Gainers
            </button>
            <button
              onClick={() => setFilterMode('breakouts')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                filterMode === 'breakouts' ? 'bg-cyan-950/80 text-cyan-300 shadow-sm border border-cyan-800/60' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Near 24h High
            </button>
            <button
              onClick={() => setFilterMode('volume')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                filterMode === 'volume' ? 'bg-purple-950/80 text-purple-300 shadow-sm border border-purple-800/60' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              &gt; $50M Vol
            </button>
            <button
              onClick={() => setFilterMode('halal')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                filterMode === 'halal'
                  ? 'bg-emerald-900 text-emerald-400 shadow-sm border border-emerald-500/50'
                  : 'text-emerald-400/70 hover:text-ember-400 hover:bg-emerald-500/10'
              }`}
            >
              {halalLoading ? <ShieldCheck className="w-3 h-3 animate-spin mr-1" /> : <ShieldCheck className="w-3 h-3 mr-1" />}
              Halal Coins
            </button>
          </div>
        </div>
      </div>

      {isHalalActive && halalLoading && (
        <div className="flex items-center gap-2 py-8 text-center">
          <ShieldCheck className="w-4 h-4 text-emerald-400 animate-spin" />
          <span className="text-sm text-emerald-400">Loading live halal feed…</span>
        </div>
      )}

      {/* Screener Table */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-3 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>
            Showing {processed.length} of {isHalalActive ? (halalMeta?.listed ?? halalCoins.length) : tickers.length}
            {isHalalActive ? ' live halal coins' : ' live momentum coins'}
          </span>
          <div role="group" aria-label="View" className="flex gap-1 rounded-lg border border-line bg-surface p-0.5">
            {[['table', 'Table'], ['heatmap', 'Heatmap']].map(([v, l]) => (
              <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={`rounded-md px-2.5 py-1 text-xs font-semibold ${view === v ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>{l}</button>
            ))}
          </div>
          <span className="font-mono text-[11px] text-emerald-400 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            {isHalalActive ? 'Live halal feed' : 'REST refresh every 3s'}
          </span>
        </div>
        {view === 'table' ? (
        <DataTable
          rows={processed}
          rowKey={(r) => r.symbol}
          sortBy={sortBy}
          sortAsc={sortAsc}
          onSort={handleSort}
          empty={isHalalActive ? 'No halal coins match your filter.' : 'No coins match your filter.'}
          columns={[
            { key: 'pair', header: 'Market Pair', primary: true, mono: false, sortable: 'symbol', render: (r) => (
              <span className="flex items-center gap-3">
                <span className={`rounded px-2 py-0.5 font-mono text-xs font-bold ${(r.halalRank ?? r.momentumRank) <= 3 ? 'bg-live/15 text-live' : (r.halalRank ?? r.momentumRank) <= 10 ? 'bg-paper/10 text-paper' : 'bg-raised text-muted'}`}>#{r.halalRank ?? r.momentumRank}</span>
                <span><b className="text-ink">{r.symbol}</b><span className="block text-xs text-muted">{r.base} / USDT</span></span>
              </span>
            ) },
            { key: 'price', header: 'Price', align: 'right', sortable: 'price', render: (r) => { const v = Number(r.price || 0); return <b className="text-ink">${v < 0.01 ? v.toFixed(6) : v.toLocaleString(undefined, { minimumFractionDigits: 2 })}</b>; } },
            { key: 'change24h', header: '24h change', align: 'right', sortable: 'change24h', render: (r) => { const up = Number(r.change24h || 0) >= 0; return <span className={`rounded px-2 py-0.5 text-xs font-bold ${up ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>{up ? '▲ +' : '▼ '}{Number(r.change24h || 0)}%</span>; } },
            { key: 'spark', header: 'Last 24h', align: 'center', mono: false, render: (r) => <Sparkline closes={spark[r.symbol]} /> },
    { key: 'volume24h', header: '24h turnover', align: 'right', sortable: 'quoteVolume', render: (r) => <span className="text-up">${r.volume24h}</span> },
            { key: 'range', header: '24h range', align: 'center', sortable: 'rangePosition', mono: false, render: (r) => (
              <span className="mx-auto flex w-28 flex-col items-center gap-1">
                <span className="h-1.5 w-full overflow-hidden rounded-full bg-raised"><span className={`block h-full rounded-full ${r.rangePosition > 75 ? 'bg-up' : r.rangePosition > 40 ? 'bg-paper' : 'bg-muted'}`} style={{ width: `${Math.min(Math.max(Number(r.rangePosition || 50), 5), 100)}%` }} /></span>
                <span className="font-mono text-xs text-muted">{r.rangePosition}% of range</span>
              </span>
            ) },
            { key: 'hl', header: '24h high / low', align: 'right', render: (r) => <span className="text-xs text-muted">H {r.high24h?.toLocaleString()}<br />L {r.low24h?.toLocaleString()}</span> },
            { key: 'action', header: 'Action', align: 'center', actions: true, mono: false, render: (r) => (
              <button onClick={() => onSelectPair(r.symbol)} className="inline-flex w-full items-center justify-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-canvas md:w-auto">
                <Zap className="size-3" /> Trade
              </button>
            ) },
          ]}
        />
        ) : (
          <div className="p-3">
            {byVolume.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">No coins match your filter.</p>
            ) : (
              <div ref={mapRef} className="relative w-full overflow-hidden rounded-xl" style={{ height: mapH || 400 }}>
                {tiles.map(({ item: r, x, y, w, h }) => {
                  const chg = Number(r.change24h || 0);
                  const up = chg >= 0;
                  const mix = Math.min(80, 18 + Math.abs(chg) * 9);
                  const showName = w > 52 && h > 34;
                  const showPct = w > 52 && h > 50;
                  return (
                    <button
                      key={r.symbol}
                      onClick={() => onSelectPair(r.symbol)}
                      title={`${r.symbol}: ${up ? '+' : ''}${chg}% · 24h turnover $${r.volume24h}. Click to trade.`}
                      aria-label={`${r.symbol} ${up ? 'up' : 'down'} ${Math.abs(chg)} percent. Open in Terminal`}
                      className="absolute overflow-hidden border border-canvas p-1.5 text-left transition-[filter] hover:brightness-125"
                      style={{ left: x, top: y, width: w, height: h, background: `color-mix(in srgb, var(${up ? '--c-up' : '--c-down'}) ${mix}%, var(--c-surface))` }}
                    >
                      {showName && <div className="truncate text-xs font-semibold text-ink">{r.base || r.symbol.replace('USDT', '')}</div>}
                      {showPct && <div className="truncate font-mono text-[11px] text-ink">{up ? '▲ +' : '▼ '}{chg}%</div>}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="mt-3 text-xs text-muted">Tile area is proportional to 24h turnover (with a small minimum so tiny coins stay clickable). Colour is 24h change, with an arrow as well. Hover a small tile for its name. Click to open it in the Terminal.</p>
          </div>
        )}
      </div>
    </div>
  );
}
