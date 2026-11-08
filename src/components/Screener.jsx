import React, { useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Search,
  Zap,
  ArrowUpDown,
  Flame,
  Activity,
  Award,
} from 'lucide-react';

export default function Screener({ tickers, onSelectPair }) {
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState('all'); // 'all', 'gainers', 'volume', 'breakouts', 'top10'
  const [sortBy, setSortBy] = useState('momentumRank');
  const [sortAsc, setSortAsc] = useState(true);

  // Filter pairs
  let processed = tickers.filter((p) => {
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!p.symbol.toLowerCase().includes(q) && !p.base?.toLowerCase().includes(q)) {
        return false;
      }
    }
    if (filterMode === 'gainers') return p.change24h > 0;
    if (filterMode === 'volume') return p.quoteVolume >= 50000000; // >$50M volume
    if (filterMode === 'breakouts') return p.rangePosition >= 75; // trading near 24h high
    if (filterMode === 'top10') return (p.momentumRank || 100) <= 10;
    return true;
  });

  // Sort pairs
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

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(field);
      setSortAsc(field === 'momentumRank'); // rank defaults ascending
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-slate-900/60 border border-slate-800/80 rounded-xl px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Flame className="w-5 h-5 text-amber-400" />
            <h1 className="text-lg font-bold text-white tracking-tight">
              Top 100 Momentum Coins Screener
            </h1>
            <span className="text-[11px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
              Live Binance Feed
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time ranking of the most active momentum crypto pairs based on 24h price change, trading volume, and breakout proximity.
          </p>
        </div>

        {/* Filter buttons & Search */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search coin (e.g. SOL, DOGE)..."
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
          </div>
        </div>
      </div>

      {/* Screener Table */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-3 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>Showing {processed.length} of {tickers.length} live momentum coins</span>
          <span className="font-mono text-[11px] text-emerald-400 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Live WebSocket/REST sync active
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-500 font-medium border-b border-slate-800 text-[11px]">
              <tr>
                <th className="py-2.5 px-4 cursor-pointer" onClick={() => handleSort('momentumRank')}>
                  <div className="flex items-center gap-1">
                    <span>Rank</span>
                    <ArrowUpDown className="w-3 h-3 text-slate-600" />
                  </div>
                </th>
                <th className="py-2.5 px-4 cursor-pointer" onClick={() => handleSort('symbol')}>
                  <div className="flex items-center gap-1">
                    <span>Market Pair</span>
                    <ArrowUpDown className="w-3 h-3 text-slate-600" />
                  </div>
                </th>
                <th className="py-2.5 px-4 text-right cursor-pointer" onClick={() => handleSort('price')}>
                  <div className="flex items-center justify-end gap-1">
                    <span>Live Mark Price</span>
                    <ArrowUpDown className="w-3 h-3 text-slate-600" />
                  </div>
                </th>
                <th className="py-2.5 px-4 text-right cursor-pointer" onClick={() => handleSort('change24h')}>
                  <div className="flex items-center justify-end gap-1">
                    <span>24h Momentum %</span>
                    <ArrowUpDown className="w-3 h-3 text-slate-600" />
                  </div>
                </th>
                <th className="py-2.5 px-4 text-right cursor-pointer" onClick={() => handleSort('quoteVolume')}>
                  <div className="flex items-center justify-end gap-1">
                    <span>24h Turnover (USDT)</span>
                    <ArrowUpDown className="w-3 h-3 text-slate-600" />
                  </div>
                </th>
                <th className="py-2.5 px-4 text-center cursor-pointer" onClick={() => handleSort('rangePosition')}>
                  <div className="flex items-center justify-center gap-1">
                    <span>24h Range Position</span>
                    <ArrowUpDown className="w-3 h-3 text-slate-600" />
                  </div>
                </th>
                <th className="py-2.5 px-4 text-right">24h High / Low</th>
                <th className="py-2.5 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
              {processed.map((pair) => {
                const isPositive = pair.change24h >= 0;
                return (
                  <tr key={pair.symbol} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-4 font-sans font-bold text-slate-400">
                      <span className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold ${
                        pair.momentumRank <= 3
                          ? 'text-amber-300 bg-amber-500/15 border border-amber-500/30'
                          : pair.momentumRank <= 10
                          ? 'text-cyan-300 bg-cyan-500/10 border border-cyan-500/20'
                          : 'text-slate-400'
                      }`}>
                        #{pair.momentumRank}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-sans">
                      <div className="font-bold text-white flex items-center gap-1.5">
                        <span>{pair.symbol}</span>
                      </div>
                      <div className="text-[11px] text-slate-400">{pair.base} / USDT</div>
                    </td>
                    <td className="py-3 px-4 text-right text-white font-bold">
                      ${pair.price < 0.01 ? pair.price.toFixed(6) : pair.price.toLocaleString(undefined, { minimumFractionDigits: pair.precision })}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                        isPositive ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'
                      }`}>
                        {isPositive ? '+' : ''}{pair.change24h}%
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-emerald-400 font-semibold">
                      ${pair.volume24h}
                    </td>
                    <td className="py-3 px-4 text-center font-sans">
                      <div className="flex flex-col items-center gap-1 w-28 mx-auto">
                        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              pair.rangePosition > 75 ? 'bg-emerald-400' : pair.rangePosition > 40 ? 'bg-cyan-400' : 'bg-slate-500'
                            }`}
                            style={{ width: `${Math.min(Math.max(pair.rangePosition || 50, 5), 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-slate-400 font-mono">
                          {pair.rangePosition}% of range
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right text-slate-400 text-[11px]">
                      <div>H: ${pair.high24h?.toLocaleString()}</div>
                      <div>L: ${pair.low24h?.toLocaleString()}</div>
                    </td>
                    <td className="py-3 px-4 text-center font-sans">
                      <button
                        onClick={() => onSelectPair(pair.symbol)}
                        className="px-3 py-1.5 text-xs font-semibold bg-emerald-600/15 hover:bg-emerald-600 text-emerald-400 hover:text-white border border-emerald-500/25 rounded-lg transition-colors flex items-center gap-1.5 mx-auto"
                      >
                        <Zap className="w-3 h-3" />
                        <span>Trade</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
