import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Play,
  RotateCcw,
  TrendingUp,
  ArrowDownUp,
  CheckCircle2,
  AlertCircle,
  Sliders,
  DollarSign,
  Activity,
  Layers,
  Award,
  Zap,
  Clock,
  ArrowRight,
  ShieldAlert,
  Percent,
  Bot,
} from 'lucide-react';

export default function Backtesting({ tickers, onDeployToLiveBot }) {
  const [selectedSymbol, setSelectedSymbol] = useState(tickers[0]?.symbol || 'BTCUSDT');
  const [timeframe, setTimeframe] = useState('7d'); // '24h', '7d', '30d', '60d'
  const [initialCapital, setInitialCapital] = useState('1000');
  const [gridLower, setGridLower] = useState('');
  const [gridUpper, setGridUpper] = useState('');
  const [gridCount, setGridCount] = useState('14');
  const [gridMode, setGridMode] = useState('GEOMETRIC'); // 'ARITHMETIC' | 'GEOMETRIC'
  const [feeRate, setFeeRate] = useState('0.0005'); // 0.05%

  const [loading, setLoading] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [backtestResult, setBacktestResult] = useState(null);
  const [optimizedStrategies, setOptimizedStrategies] = useState(null);
  const [winningStrategy, setWinningStrategy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [activeView, setActiveView] = useState('summary'); // 'summary', 'strategies', 'rungs', 'trades'

  // Timeframe configurations mapped to Binance kline parameters
  const timeframeMap = {
    '24h': { interval: '15m', limit: 96, label: '24 Hours (15m bars)' },
    '7d': { interval: '1h', limit: 168, label: '7 Days (1h bars)' },
    '30d': { interval: '1h', limit: 500, label: '30 Days (1h bars)' },
    '60d': { interval: '4h', limit: 360, label: '60 Days (4h bars)' },
  };

  // Sync default range with selected symbol price
  useEffect(() => {
    const pair = tickers.find((t) => t.symbol === selectedSymbol);
    if (pair && pair.price) {
      const p = pair.price;
      const lower = Number((p * 0.94).toFixed(pair.precision || 2));
      const upper = Number((p * 1.06).toFixed(pair.precision || 2));
      setGridLower(lower.toString());
      setGridUpper(upper.toString());
    }
  }, [selectedSymbol, tickers]);

  // Run backtest against live Binance klines
  const handleRunBacktest = async (customParams = null) => {
    setLoading(true);
    setNotice(null);

    const tf = timeframeMap[timeframe] || timeframeMap['7d'];
    const payload = customParams || {
      symbol: selectedSymbol,
      interval: tf.interval,
      limit: tf.limit,
      initialCapital: Number(initialCapital) || 1000,
      lowerPrice: Number(gridLower),
      upperPrice: Number(gridUpper),
      gridCount: Number(gridCount) || 12,
      gridMode,
      feeRate: Number(feeRate) || 0.0005,
    };

    try {
      const res = await fetch('/api/backtest/grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to execute backtest');

      setBacktestResult(data);
      setNotice({
        type: 'success',
        text: `Backtest completed on ${data.candlesCount} real Binance candles! Net Return: +${data.totalNetProfit} USDT (${data.netReturnPercent}% / ~${data.annualizedApr}% APR).`,
      });
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  // Run Multi-Strategy Optimizer (parameter sweep)
  const handleRunOptimizer = async () => {
    setOptimizing(true);
    setNotice(null);

    const tf = timeframeMap[timeframe] || timeframeMap['7d'];
    try {
      const res = await fetch('/api/backtest/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbol,
          interval: tf.interval,
          limit: tf.limit,
          initialCapital: Number(initialCapital) || 1000,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to run strategy optimization');

      setOptimizedStrategies(data.strategies);
      setWinningStrategy(data.winner);
      setActiveView('strategies');

      // Also set the winner's full simulation as current result
      if (data.winner?.fullSimulation) {
        setBacktestResult(data.winner.fullSimulation);
      }

      setNotice({
        type: 'success',
        text: `Grid Optimizer analyzed 5 strategic models over ${data.candlesTested} Binance bars. Top strategy: "${data.winner?.name}" with +${data.winner?.netReturnPercent}% return!`,
      });
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    } finally {
      setOptimizing(false);
    }
  };

  // Apply optimized strategy parameters into active form
  const applyStrategy = (strat) => {
    setGridLower(strat.lowerPrice.toString());
    setGridUpper(strat.upperPrice.toString());
    setGridCount(strat.gridCount.toString());
    setGridMode(strat.gridMode);
    if (strat.fullSimulation) {
      setBacktestResult(strat.fullSimulation);
    }
    setActiveView('summary');
    setNotice({
      type: 'success',
      text: `Loaded parameters from "${strat.name}". Ready to deploy or test.`,
    });
  };

  // Quick range multipliers
  const setRangeOffset = (percent) => {
    const pair = tickers.find((t) => t.symbol === selectedSymbol);
    const p = pair?.price || (Number(gridLower) + Number(gridUpper)) / 2 || 100;
    const lower = Number((p * (1 - percent / 100)).toFixed(pair?.precision || 2));
    const upper = Number((p * (1 + percent / 100)).toFixed(pair?.precision || 2));
    setGridLower(lower.toString());
    setGridUpper(upper.toString());
  };

  // Initial auto-run on first load
  useEffect(() => {
    if (!backtestResult && selectedSymbol && gridLower && gridUpper) {
      handleRunBacktest();
    }
  }, [selectedSymbol]);

  const currentPair = tickers.find((t) => t.symbol === selectedSymbol);

  // SVG Equity Curve Calculation
  const renderEquityCurve = () => {
    if (!backtestResult?.equityHistory || backtestResult.equityHistory.length < 2) return null;
    const points = backtestResult.equityHistory;

    const minEquity = Math.min(...points.map((p) => Math.min(p.equity, p.benchmark)));
    const maxEquity = Math.max(...points.map((p) => Math.max(p.equity, p.benchmark)));
    const range = maxEquity - minEquity || 1;

    const width = 800;
    const height = 220;
    const paddingX = 40;
    const paddingY = 25;

    const getX = (i) => paddingX + (i / (points.length - 1)) * (width - paddingX * 2);
    const getY = (val) => height - paddingY - ((val - minEquity) / range) * (height - paddingY * 2);

    const equityPathD = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(p.equity).toFixed(1)}`)
      .join(' ');

    const benchmarkPathD = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(p.benchmark).toFixed(1)}`)
      .join(' ');

    const areaPathD = `${equityPathD} L ${getX(points.length - 1)} ${height - paddingY} L ${getX(0)} ${height - paddingY} Z`;

    return (
      <div className="relative w-full overflow-hidden">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-56 select-none">
          <defs>
            <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id="equityLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="100%" stopColor="#10b981" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <line x1={paddingX} y1={paddingY} x2={width - paddingX} y2={paddingY} stroke="#1e293b" strokeDasharray="3 3" />
          <line x1={paddingX} y1={height / 2} x2={width - paddingX} y2={height / 2} stroke="#1e293b" strokeDasharray="3 3" />
          <line x1={paddingX} y1={height - paddingY} x2={width - paddingX} y2={height - paddingY} stroke="#334155" />

          {/* Benchmark line (Buy and Hold) */}
          <path d={benchmarkPathD} fill="none" stroke="#64748b" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.7" />

          {/* Shaded Area under Grid Equity */}
          <path d={areaPathD} fill="url(#equityFill)" />

          {/* Grid Equity Curve */}
          <path d={equityPathD} fill="none" stroke="url(#equityLine)" strokeWidth="2.5" />

          {/* Endpoint markers */}
          <circle cx={getX(points.length - 1)} cy={getY(points[points.length - 1].equity)} r="4" fill="#10b981" />
          <circle cx={getX(points.length - 1)} cy={getY(points[points.length - 1].benchmark)} r="3" fill="#64748b" />

          {/* Labels */}
          <text x={paddingX} y={paddingY - 8} fill="#94a3b8" fontSize="10" fontFamily="monospace">
            Peak: ${maxEquity.toFixed(1)} USDT
          </text>
          <text x={paddingX} y={height - 8} fill="#94a3b8" fontSize="10" fontFamily="monospace">
            Floor: ${minEquity.toFixed(1)} USDT
          </text>
          <text x={width - paddingX} y={paddingY - 8} fill="#10b981" fontSize="10" fontFamily="monospace" textAnchor="end" fontWeight="bold">
            Grid Final: ${points[points.length - 1].equity.toFixed(1)}
          </text>
        </svg>

        {/* Legend */}
        <div className="flex items-center justify-between text-xs text-slate-400 px-4 mt-1 font-mono">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-emerald-400 font-semibold">
              <span className="w-3 h-0.5 bg-emerald-400 rounded-full" />
              Grid Strategy Equity
            </span>
            <span className="flex items-center gap-1.5 text-slate-400">
              <span className="w-3 h-0.5 bg-slate-500 rounded-full border-dashed" />
              Buy & Hold Benchmark
            </span>
          </div>
          <span className="text-[11px] text-slate-500">
            {points.length} Historical Sample Points
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-slate-900/60 border border-slate-800/80 rounded-xl px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-emerald-400" />
            <h1 className="text-lg font-bold text-white tracking-tight">
              Grid Strategy Backtesting & Quantitative Optimizer
            </h1>
            <span className="text-[11px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
              100% Live Binance Historical Klines
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Walk-forward market simulation against real Binance candles with fee friction, dynamic spread harvesting, and multi-model parameter optimization.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={handleRunOptimizer}
            disabled={optimizing || loading}
            className="px-3.5 py-2 text-xs font-bold text-amber-300 bg-amber-500/15 border border-amber-500/35 hover:bg-amber-500/25 rounded-lg flex items-center gap-1.5 transition-all shadow-sm"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>{optimizing ? 'Analyzing Models...' : 'Auto-Optimize Strategy'}</span>
          </button>

          <button
            onClick={() => handleRunBacktest()}
            disabled={loading || optimizing}
            className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg flex items-center gap-2 transition-colors shadow-sm"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{loading ? 'Simulating...' : 'Run Backtest'}</span>
          </button>

          {onDeployToLiveBot && (
            <button
              onClick={() => onDeployToLiveBot()}
              className="px-3.5 py-2 text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg flex items-center gap-1.5 transition-colors"
              title="Switch to Algo Bots to deploy live execution nodes"
            >
              <Bot className="w-3.5 h-3.5 text-purple-400" />
              <span>Deploy Live Bot</span>
            </button>
          )}
        </div>
      </div>

      {/* Notice alert */}
      {notice && (
        <div
          className={`px-4 py-3 rounded-lg text-xs flex items-center justify-between border ${
            notice.type === 'success'
              ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800 shadow-[0_0_15px_rgba(16,185,129,0.1)]'
              : 'bg-rose-950/40 text-rose-300 border-rose-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" /> : <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />}
            <span>{notice.text}</span>
          </div>
          <button onClick={() => setNotice(null)} className="text-slate-400 hover:text-white">✕</button>
        </div>
      )}

      {/* Parameter Control Panel */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800 text-xs">
          <span className="font-semibold text-slate-200 flex items-center gap-2">
            <Sliders className="w-4 h-4 text-emerald-400" />
            <span>Backtesting Parameters</span>
          </span>
          <span className="font-mono text-slate-400 text-[11px]">
            Mark: <strong className="text-white">${currentPair?.price < 0.01 ? currentPair?.price.toFixed(6) : currentPair?.price.toLocaleString()}</strong>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          {/* Pair Selector */}
          <div>
            <label className="text-[11px] text-slate-400 font-medium">Momentum Pair</label>
            <select
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-white font-mono mt-1 focus:outline-none focus:border-emerald-500"
            >
              {tickers.slice(0, 40).map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  #{t.momentumRank} {t.symbol}
                </option>
              ))}
            </select>
          </div>

          {/* Timeframe */}
          <div>
            <label className="text-[11px] text-slate-400 font-medium">Historical Sample</label>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-white mt-1 focus:outline-none focus:border-emerald-500 font-mono"
            >
              <option value="24h">24 Hours (15m bars)</option>
              <option value="7d">7 Days (1h bars)</option>
              <option value="30d">30 Days (1h bars)</option>
              <option value="60d">60 Days (4h bars)</option>
            </select>
          </div>

          {/* Initial Capital */}
          <div>
            <label className="text-[11px] text-slate-400 font-medium">Initial Capital (USDT)</label>
            <input
              type="number"
              value={initialCapital}
              onChange={(e) => setInitialCapital(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-white font-mono mt-1 focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Lower Price */}
          <div>
            <label className="text-[11px] text-slate-400 font-medium">Lower Price (USDT)</label>
            <input
              type="number"
              step="any"
              value={gridLower}
              onChange={(e) => setGridLower(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-white font-mono mt-1 focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Upper Price */}
          <div>
            <label className="text-[11px] text-slate-400 font-medium">Upper Price (USDT)</label>
            <input
              type="number"
              step="any"
              value={gridUpper}
              onChange={(e) => setGridUpper(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-white font-mono mt-1 focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Grid Count & Mode */}
          <div>
            <label className="text-[11px] text-slate-400 font-medium">Grids & Mode</label>
            <div className="flex gap-1 mt-1">
              <input
                type="number"
                min="3"
                max="45"
                value={gridCount}
                onChange={(e) => setGridCount(e.target.value)}
                className="w-16 bg-slate-950 border border-slate-800 rounded px-2 py-1.5 text-xs text-purple-300 font-bold font-mono focus:outline-none focus:border-purple-500"
              />
              <select
                value={gridMode}
                onChange={(e) => setGridMode(e.target.value)}
                className="flex-1 bg-slate-950 border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-emerald-500 font-mono"
              >
                <option value="GEOMETRIC">Geom (%)</option>
                <option value="ARITHMETIC">Arith ($)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Quick Range Helper Pills */}
        <div className="flex items-center justify-between flex-wrap gap-2 pt-2 border-t border-slate-800/80 text-[11px]">
          <div className="flex items-center gap-1.5 text-slate-400">
            <span>Quick Range Presets:</span>
            <button
              onClick={() => setRangeOffset(3)}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
            >
              ±3% Tight
            </button>
            <button
              onClick={() => setRangeOffset(6)}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
            >
              ±6% Standard
            </button>
            <button
              onClick={() => setRangeOffset(10)}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
            >
              ±10% Wide
            </button>
            <button
              onClick={() => setRangeOffset(15)}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
            >
              ±15% Macro
            </button>
          </div>

          <div className="flex items-center gap-3 text-slate-400">
            <span>Taker Fee: <strong>{(Number(feeRate) * 100).toFixed(2)}%</strong></span>
            <span>Est. Order Size: <strong className="text-white">${((Number(initialCapital) || 1000) / ((Number(gridCount) || 10) + 1)).toFixed(2)} USDT</strong></span>
          </div>
        </div>
      </div>

      {/* Radiant Light Patches KPI Strip */}
      {backtestResult && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Light Patch 1: Net Profit & Return */}
          <div className="relative overflow-hidden bg-gradient-to-br from-emerald-950/60 via-slate-900/90 to-emerald-950/30 border border-emerald-500/40 shadow-[0_0_25px_rgba(16,185,129,0.15)] rounded-xl p-4 flex flex-col justify-between">
            <div className="absolute -top-10 -right-10 w-28 h-28 bg-emerald-400/20 rounded-full blur-2xl pointer-events-none" />
            <div className="relative z-10 flex items-center justify-between text-xs text-emerald-300">
              <span className="flex items-center gap-1.5 font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.9)]"></span>
                </span>
                Net Realized Return
              </span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-400/20 text-emerald-300 font-mono text-[10px] font-bold border border-emerald-400/30">
                +{backtestResult.netReturnPercent}%
              </span>
            </div>
            <div className="relative z-10 mt-2">
              <div className="text-2xl font-black font-mono tracking-tight bg-gradient-to-r from-emerald-200 via-emerald-400 to-teal-300 bg-clip-text text-transparent drop-shadow-[0_2px_12px_rgba(16,185,129,0.35)] tabular-nums">
                +{backtestResult.totalNetProfit} USDT
              </div>
              <div className="text-[11px] text-emerald-400 font-mono mt-0.5">
                Backtested APR: ~{backtestResult.annualizedApr}%
              </div>
            </div>
            <div className="relative z-10 mt-2 pt-2 border-t border-emerald-500/20 flex justify-between text-[11px] text-slate-400">
              <span>Pure Spread Captured</span>
              <span className="text-emerald-300 font-bold font-mono">
                +${backtestResult.cumulativeRealizedProfit} USDT
              </span>
            </div>
          </div>

          {/* Light Patch 2: Alpha / Outperformance vs Buy & Hold */}
          <div className="relative overflow-hidden bg-gradient-to-br from-cyan-950/50 via-slate-900/90 to-slate-900/80 border border-cyan-500/35 shadow-[0_0_20px_rgba(6,182,212,0.12)] rounded-xl p-4 flex flex-col justify-between">
            <div className="absolute -top-10 -right-10 w-28 h-28 bg-cyan-400/15 rounded-full blur-2xl pointer-events-none" />
            <div className="relative z-10 flex items-center justify-between text-xs text-cyan-300 font-medium">
              <span>Alpha vs Buy & Hold</span>
              <TrendingUp className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="relative z-10 mt-2">
              <div className="text-2xl font-black font-mono tracking-tight text-white tabular-nums">
                {backtestResult.outperformance >= 0 ? '+' : ''}{backtestResult.outperformance}%
              </div>
              <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                Benchmark: {backtestResult.buyAndHoldReturn >= 0 ? '+' : ''}{backtestResult.buyAndHoldReturn}%
              </div>
            </div>
            <div className="relative z-10 mt-2 pt-2 border-t border-cyan-500/20 flex justify-between text-[11px] text-slate-400">
              <span>Risk Metric</span>
              <span className="text-cyan-300 font-mono font-bold">
                Sharpe: {backtestResult.sharpeRatio}
              </span>
            </div>
          </div>

          {/* Light Patch 3: Arbitrage Velocity & Sweeps */}
          <div className="relative overflow-hidden bg-gradient-to-br from-purple-950/50 via-slate-900/90 to-slate-900/80 border border-purple-500/35 shadow-[0_0_20px_rgba(168,85,247,0.12)] rounded-xl p-4 flex flex-col justify-between">
            <div className="absolute -top-10 -right-10 w-28 h-28 bg-purple-400/15 rounded-full blur-2xl pointer-events-none" />
            <div className="relative z-10 flex items-center justify-between text-xs text-purple-300 font-medium">
              <span>Arbitrage Sweeps</span>
              <Activity className="w-4 h-4 text-purple-400" />
            </div>
            <div className="relative z-10 mt-2">
              <div className="text-2xl font-black font-mono tracking-tight text-purple-200 tabular-nums">
                {backtestResult.completedSweeps} Rounds
              </div>
              <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                {backtestResult.totalTrades} Total Fills ({backtestResult.buyFills}B / {backtestResult.sellFills}S)
              </div>
            </div>
            <div className="relative z-10 mt-2 pt-2 border-t border-purple-500/20 flex justify-between text-[11px] text-slate-400">
              <span>Win Rate on Sweeps</span>
              <span className="text-purple-300 font-bold font-mono">100% Fixed Spread</span>
            </div>
          </div>

          {/* Light Patch 4: Risk & Drawdown */}
          <div className="relative overflow-hidden bg-gradient-to-br from-slate-900/90 via-slate-900/90 to-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Max Equity Drawdown</span>
              <ShieldAlert className="w-4 h-4 text-rose-400" />
            </div>
            <div className="mt-2">
              <div className="text-2xl font-black font-mono text-rose-400 tabular-nums">
                -{backtestResult.maxDrawdownPercent}%
              </div>
              <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                -${backtestResult.maxDrawdownUSDT} USDT from Peak
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-slate-800 flex justify-between text-[11px] text-slate-400">
              <span>Fee Friction</span>
              <span className="text-slate-300 font-mono">
                ${backtestResult.totalFeesPaid} USDT
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Navigation Sub-Tabs */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveView('summary')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeView === 'summary'
                ? 'bg-slate-800 text-white shadow-sm border border-slate-700'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Walk-Forward Equity Simulation
          </button>
          <button
            onClick={() => setActiveView('strategies')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 ${
              activeView === 'strategies'
                ? 'bg-slate-800 text-amber-300 shadow-sm border border-amber-500/30'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>Strategy Optimizer Matrix {optimizedStrategies ? `(${optimizedStrategies.length})` : ''}</span>
          </button>
          <button
            onClick={() => setActiveView('rungs')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeView === 'rungs'
                ? 'bg-slate-800 text-purple-300 shadow-sm border border-slate-700'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Rung Yield Heatmap ({backtestResult?.rungs?.length || 0})
          </button>
          <button
            onClick={() => setActiveView('trades')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeView === 'trades'
                ? 'bg-slate-800 text-cyan-300 shadow-sm border border-slate-700'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Simulated Trade Fills ({backtestResult?.tradeLogs?.length || 0})
          </button>
        </div>

        {backtestResult && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-slate-400 hidden sm:inline">
              Period: {backtestResult.durationDays} days ({backtestResult.candlesCount} bars)
            </span>
          </div>
        )}
      </div>

      {/* VIEW 1: Walk-Forward Equity Curve */}
      {activeView === 'summary' && backtestResult && (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <div>
              <h3 className="text-xs font-bold text-white flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <span>Simulated Portfolio Equity Curve vs Buy & Hold</span>
              </h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Simulated mark-to-market performance from candle 1 to candle {backtestResult.candlesCount} on Binance public tape.
              </p>
            </div>
            <div className="text-right font-mono text-xs">
              <span className="text-slate-400">Final Equity: </span>
              <strong className="text-emerald-400">${backtestResult.finalEquity} USDT</strong>
            </div>
          </div>

          {/* SVG Visualizer */}
          {renderEquityCurve()}

          {/* Metric Comparison Table */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-slate-800 text-xs font-mono">
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80">
              <span className="text-[10px] text-slate-400">Start Capital:</span>
              <div className="text-white font-bold mt-0.5">${backtestResult.initialCapital} USDT</div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80">
              <span className="text-[10px] text-slate-400">Final Equity:</span>
              <div className="text-emerald-400 font-bold mt-0.5">${backtestResult.finalEquity} USDT</div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80">
              <span className="text-[10px] text-slate-400">Grid Net Profit:</span>
              <div className="text-emerald-300 font-bold mt-0.5">
                +${backtestResult.totalNetProfit} ({backtestResult.netReturnPercent}%)
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80">
              <span className="text-[10px] text-slate-400">Buy & Hold Return:</span>
              <div className={`font-bold mt-0.5 ${backtestResult.buyAndHoldReturn >= 0 ? 'text-slate-200' : 'text-rose-400'}`}>
                {backtestResult.buyAndHoldReturn >= 0 ? '+' : ''}{backtestResult.buyAndHoldReturn}%
              </div>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 2: Strategy Optimizer Comparison Matrix */}
      {activeView === 'strategies' && (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-xs font-bold text-amber-300 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>Multi-Strategy Grid Optimizer (Parameter Sweep)</span>
              </h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Automated quantitative scan testing 5 distinct structural grid architectures across real Binance candles.
              </p>
            </div>
            <button
              onClick={handleRunOptimizer}
              disabled={optimizing}
              className="px-3 py-1.5 text-xs font-bold text-amber-300 bg-amber-500/15 border border-amber-500/30 rounded-lg hover:bg-amber-500/25 transition-colors flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{optimizing ? 'Scanning...' : 'Re-run Optimizer'}</span>
            </button>
          </div>

          {!optimizedStrategies && !optimizing && (
            <div className="text-center py-12 flex flex-col items-center justify-center gap-3">
              <Sparkles className="w-10 h-10 text-amber-400/50" />
              <div className="text-sm font-bold text-white">No strategy scan active</div>
              <p className="text-xs text-slate-400 max-w-md">
                Click "Auto-Optimize Strategy" to test ultra-tight scalpers, balanced institutional grids, and wide swing structures against live Binance candles.
              </p>
              <button
                onClick={handleRunOptimizer}
                className="px-4 py-2 text-xs font-bold text-amber-300 bg-amber-500/20 border border-amber-500/40 rounded-lg hover:bg-amber-500/30 transition-colors"
              >
                Scan Top 5 Strategic Models
              </button>
            </div>
          )}

          {optimizing && (
            <div className="py-16 text-center flex flex-col items-center justify-center gap-3">
              <span className="w-8 h-8 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
              <div className="text-xs font-mono text-slate-300">
                Running parameter sweep against {timeframeMap[timeframe]?.limit} real Binance klines...
              </div>
            </div>
          )}

          {optimizedStrategies && !optimizing && (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] text-slate-400 font-mono uppercase tracking-wider">
                    <th className="py-2.5 px-3">Strategy Model</th>
                    <th className="py-2.5 px-3">Range & Levels</th>
                    <th className="py-2.5 px-3">Mode</th>
                    <th className="py-2.5 px-3">Net Profit</th>
                    <th className="py-2.5 px-3">Est. APR</th>
                    <th className="py-2.5 px-3">Max DD</th>
                    <th className="py-2.5 px-3">Sweeps</th>
                    <th className="py-2.5 px-3">Sharpe</th>
                    <th className="py-2.5 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {optimizedStrategies.map((strat) => {
                    const isWinner = strat.isWinner;
                    return (
                      <tr
                        key={strat.id}
                        className={`transition-colors ${
                          isWinner
                            ? 'bg-amber-950/20 hover:bg-amber-950/30'
                            : 'hover:bg-slate-800/40'
                        }`}
                      >
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2">
                            {isWinner && (
                              <span className="p-1 rounded bg-amber-500/20 border border-amber-400/40 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.2)]">
                                <Award className="w-3.5 h-3.5" />
                              </span>
                            )}
                            <div>
                              <div className="font-bold text-white text-xs font-sans flex items-center gap-1.5">
                                <span>{strat.name}</span>
                                {isWinner && (
                                  <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-amber-400/20 text-amber-300 border border-amber-400/40 font-bold">
                                    TOP PICK
                                  </span>
                                )}
                              </div>
                              <span className="text-[10px] text-slate-400 font-sans block mt-0.5">
                                {strat.description}
                              </span>
                            </div>
                          </div>
                        </td>

                        <td className="py-3 px-3 text-slate-300">
                          <div>${strat.lowerPrice.toLocaleString()} - ${strat.upperPrice.toLocaleString()}</div>
                          <span className="text-[10px] text-purple-300 font-semibold">{strat.gridCount} rungs</span>
                        </td>

                        <td className="py-3 px-3">
                          <span className={`text-[10px] px-2 py-0.5 rounded border ${
                            strat.gridMode === 'GEOMETRIC'
                              ? 'text-purple-300 bg-purple-500/10 border-purple-500/30'
                              : 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30'
                          }`}>
                            {strat.gridMode}
                          </span>
                        </td>

                        <td className="py-3 px-3">
                          <div className="font-bold text-emerald-400">
                            +${strat.netProfit}
                          </div>
                          <span className="text-[10px] text-slate-400">+{strat.netReturnPercent}%</span>
                        </td>

                        <td className="py-3 px-3 text-emerald-300 font-bold">
                          ~{strat.annualizedApr}%
                        </td>

                        <td className="py-3 px-3 text-rose-400">
                          -{strat.maxDrawdownPercent}%
                        </td>

                        <td className="py-3 px-3 text-slate-200">
                          {strat.completedSweeps} sweeps
                        </td>

                        <td className="py-3 px-3 text-cyan-300 font-bold">
                          {strat.sharpeRatio}
                        </td>

                        <td className="py-3 px-3 text-right">
                          <button
                            onClick={() => applyStrategy(strat)}
                            className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors flex items-center gap-1.5 ml-auto ${
                              isWinner
                                ? 'bg-amber-500 text-slate-950 hover:bg-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.25)]'
                                : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                            }`}
                          >
                            <span>Apply</span>
                            <ArrowRight className="w-3 h-3" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* VIEW 3: Rung Yield Heatmap */}
      {activeView === 'rungs' && backtestResult && (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-xs font-bold text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-purple-400" />
                <span>Grid Rung Distribution & Harvest Yield Heatmap</span>
              </h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Breakdown of order fills and captured spread profits per price rung over the test period.
              </p>
            </div>
            <span className="text-xs font-mono text-purple-300 font-semibold">
              {backtestResult.gridParams?.gridCount} levels ({backtestResult.gridParams?.gridMode})
            </span>
          </div>

          <div className="grid grid-cols-1 gap-1.5 font-mono text-xs">
            {backtestResult.rungs?.map((rung) => {
              const hasFills = (rung.fillsCount || 0) > 0;
              const hasProfit = (rung.profitCaptured || 0) > 0;
              const isSell = rung.side === 'SELL';

              return (
                <div
                  key={rung.id}
                  className={`flex items-center justify-between py-2 px-3 rounded-lg border transition-all ${
                    hasProfit
                      ? 'bg-emerald-950/40 border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.1)]'
                      : isSell
                      ? 'bg-rose-950/20 border-rose-900/30 text-rose-300'
                      : 'bg-emerald-950/20 border-emerald-900/30 text-emerald-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                      isSell ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'
                    }`}>
                      {rung.side}
                    </span>
                    <span className="font-bold text-white">${rung.price?.toLocaleString()}</span>
                    <span className="text-slate-500 text-[11px]">→ Target ${rung.targetPrice?.toLocaleString()}</span>
                  </div>

                  <div className="flex items-center gap-4 text-slate-300">
                    <span className="text-slate-400 text-[11px]">
                      {rung.fillsCount || 0} fills
                    </span>

                    {hasProfit ? (
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-400/20 text-emerald-200 border border-emerald-400/30 shadow-[0_0_8px_rgba(16,185,129,0.2)] flex items-center gap-1">
                        <Sparkles className="w-3 h-3 text-emerald-300" />
                        <span>+${rung.profitCaptured} USDT</span>
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-500 font-mono">0 spread gain</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* VIEW 4: Simulated Trade Fills Log */}
      {activeView === 'trades' && backtestResult && (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-xs font-bold text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-cyan-400" />
                <span>Simulated Order Execution Tape</span>
              </h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Timestamped limit order executions, fee deductions, and spread gain realizations.
              </p>
            </div>
            <span className="text-xs font-mono text-cyan-400 font-semibold">
              {backtestResult.tradeLogs?.length || 0} Recent Fills
            </span>
          </div>

          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] text-slate-400 uppercase tracking-wider sticky top-0 bg-slate-900">
                  <th className="py-2 px-3">Candle Time</th>
                  <th className="py-2 px-3">Side</th>
                  <th className="py-2 px-3">Fill Price</th>
                  <th className="py-2 px-3">Quantity</th>
                  <th className="py-2 px-3">Turnover</th>
                  <th className="py-2 px-3">Fee</th>
                  <th className="py-2 px-3">Harvested Profit</th>
                  <th className="py-2 px-3 text-right">Cash Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {backtestResult.tradeLogs?.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-800/40">
                    <td className="py-2 px-3 text-slate-400 text-[11px]">{t.timeLabel}</td>
                    <td className="py-2 px-3">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        t.side === 'BUY'
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      }`}>
                        {t.side}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-white font-bold">${t.price?.toLocaleString()}</td>
                    <td className="py-2 px-3 text-slate-300">{t.size}</td>
                    <td className="py-2 px-3 text-slate-300">${t.cost}</td>
                    <td className="py-2 px-3 text-slate-500">${t.fee}</td>
                    <td className="py-2 px-3">
                      {t.profit > 0 ? (
                        <span className="text-emerald-400 font-bold">
                          +${t.profit}
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-300 font-mono">
                      ${t.cashBalance}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
