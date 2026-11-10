import React, { useState, useEffect } from 'react';
import {
  Bot,
  Play,
  Pause,
  Square,
  PlusCircle,
  Flame,
  Activity,
  Layers,
  CheckCircle2,
  AlertCircle,
  Clock,
  Trash2,
  Sliders,
  TrendingUp,
  ShieldCheck,
  RefreshCw,
  Sparkles,
  ArrowDownUp,
  DollarSign,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

export default function AlgoBots({ accounts, tickers }) {
  const [botsData, setBotsData] = useState({ bots: [], stats: {} });
  const [filterType, setFilterType] = useState('ALL'); // 'ALL', 'TWAP_SLICER', 'BREAKOUT_CHASER', 'GRID_BOT'
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [selectedBotLogId, setSelectedBotLogId] = useState(null);
  const [selectedBotLadderId, setSelectedBotLadderId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizationResult, setOptimizationResult] = useState(null);

  // Deploy Form State
  const [botType, setBotType] = useState('GRID_BOT');
  const [botName, setBotName] = useState('');
  const [targetAccountId, setTargetAccountId] = useState(accounts[0]?.id || '');
  const [symbol, setSymbol] = useState(tickers[0]?.symbol || 'BTCUSDT');
  const [side, setSide] = useState('BUY');

  // TWAP parameters
  const [twapTotalSize, setTwapTotalSize] = useState('1.0');
  const [twapSlices, setTwapSlices] = useState('5');
  const [twapInterval, setTwapInterval] = useState('15');

  // Breakout parameters
  const [breakoutTrigger, setBreakoutTrigger] = useState('');
  const [breakoutSize, setBreakoutSize] = useState('0.1');
  const [breakoutLeverage, setBreakoutLeverage] = useState('5');
  const [breakoutTp, setBreakoutTp] = useState('');
  const [breakoutSl, setBreakoutSl] = useState('');

  // Grid parameters
  const [gridMode, setGridMode] = useState('ARITHMETIC'); // 'ARITHMETIC' | 'GEOMETRIC'
  const [gridLower, setGridLower] = useState('');
  const [gridUpper, setGridUpper] = useState('');
  const [gridCount, setGridCount] = useState('8');
  const [gridSize, setGridSize] = useState('0.05');

  // QSL (Quant Square Levels) parameters
  const [qslLevelsEachSide, setQslLevelsEachSide] = useState('5');
  const [qslTriggerLevel, setQslTriggerLevel] = useState('2');
  const [qslSize, setQslSize] = useState('0.05');

  const fetchBots = async () => {
    try {
      const res = await fetch('/api/bots');
      if (res.ok) {
        setBotsData(await res.json());
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    let isMounted = true;
    fetchBots();
    const interval = setInterval(() => {
      if (!isMounted) return;
      fetchBots();
    }, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Update default breakout trigger & grid ranges when symbol changes
  useEffect(() => {
    const pair = tickers.find((t) => t.symbol === symbol);
    if (pair) {
      setBreakoutTrigger(pair.high24h?.toString() || pair.price.toString());
      setGridLower((pair.price * 0.96).toFixed(pair.precision));
      setGridUpper((pair.price * 1.04).toFixed(pair.precision));
      setGridSize(pair.price > 1000 ? '0.01' : pair.price > 50 ? '0.2' : '10');
      setOptimizationResult(null);
    }
  }, [symbol, tickers]);

  // Auto-optimize grid parameters based on live Binance market data
  const handleAutoOptimizeGrid = async () => {
    setIsOptimizing(true);
    try {
      const res = await fetch(`/api/bots/optimize-grid?symbol=${symbol}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to optimize grid');
      }
      const data = await res.json();

      setGridLower(data.lowerBound.toString());
      setGridUpper(data.upperBound.toString());
      setGridCount(data.suggestedGrids.toString());
      setGridMode(data.recommendedMode);
      setGridSize(data.recommendedSize.toString());
      setOptimizationResult(data);
      setNotice({
        type: 'success',
        text: `Grid optimized for ${symbol}! Estimated net return: ~${data.avgProfitPercent}% per grid rung after fees.`,
      });
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    } finally {
      setIsOptimizing(false);
    }
  };

  const handleTogglePause = async (botId) => {
    try {
      const res = await fetch(`/api/bots/${botId}/pause`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setNotice({ type: 'success', text: `Bot status updated to ${data.status}` });
      fetchBots();
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    }
  };

  const handleStopBot = async (botId) => {
    try {
      const res = await fetch(`/api/bots/${botId}/stop`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setNotice({ type: 'success', text: 'Bot stopped. Open child orders cancelled.' });
      fetchBots();
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    }
  };

  const handleDeleteBot = async (botId) => {
    try {
      const res = await fetch(`/api/bots/${botId}`, { method: 'DELETE' });
      if (res.ok) {
        setNotice({ type: 'success', text: 'Bot removed.' });
        fetchBots();
      }
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    }
  };

  const handleDeployBot = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = {
        type: botType,
        name: botName || `${symbol} ${botType === 'GRID_BOT' ? `${gridMode} Grid` : botType.replace('_', ' ')}`,
        accountId: targetAccountId || accounts[0]?.id,
        symbol,
        side,
        totalSize: twapTotalSize,
        slicesCount: twapSlices,
        intervalSeconds: twapInterval,
        triggerPrice: breakoutTrigger,
        size: breakoutSize,
        leverage: breakoutLeverage,
        tpPrice: breakoutTp,
        slPrice: breakoutSl,
        lowerPrice: gridLower,
        upperPrice: gridUpper,
        gridCount,
        gridMode,
        levelsEachSide: qslLevelsEachSide,
        triggerLevel: qslTriggerLevel,
        sizePerGrid: botType === 'QSL' ? Number(qslSize) : Number(gridSize),
      };

      const res = await fetch('/api/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to deploy bot');

      setNotice({
        type: 'success',
        text: `Algo Bot "${data.name}" deployed and running on ${data.broker.toUpperCase()}!`,
      });
      setShowDeployModal(false);
      fetchBots();
    } catch (err) {
      setNotice({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const filteredBots = (botsData.bots || []).filter((b) => {
    if (filterType === 'ALL') return true;
    return b.type === filterType;
  });

  return (
    <div className="flex flex-col gap-6">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-slate-900/60 border border-slate-800/80 rounded-xl px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-emerald-400" />
            <h1 className="text-lg font-bold text-white tracking-tight">
              Algorithmic Momentum Execution Bots
            </h1>
            <span className="text-[11px] font-mono font-bold text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
              Optimized Multi-Strategy
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Institutional volatility grid trading with arithmetic & geometric ladders, TWAP slicers, and 24h high momentum breakout radars.
          </p>
        </div>

        <button
          onClick={() => setShowDeployModal(true)}
          className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg flex items-center gap-2 transition-colors shadow-sm shrink-0"
        >
          <PlusCircle className="w-4 h-4" />
          <span>Deploy Algo Bot</span>
        </button>
      </div>

      {/* KPI Stats Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Active Running Bots</span>
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          </div>
          <div className="mt-2 text-xl font-bold font-mono text-emerald-400 tabular-nums">
            {botsData.stats?.activeBots || 0} / {botsData.stats?.totalBots || 0}
          </div>
          <span className="text-[11px] text-slate-500 mt-1">Autonomous Grid & Slicer Nodes</span>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Automated Turnover</span>
            <Activity className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="mt-2 text-xl font-bold font-mono text-white tabular-nums">
            ${botsData.stats?.totalAutomatedVolume?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '0.00'}
          </div>
          <span className="text-[11px] text-slate-500 mt-1">Executed Automated Volume</span>
        </div>

        {/* Realized Grid Profit with Radiant Light Patch */}
        <div className="relative overflow-hidden bg-gradient-to-br from-emerald-950/60 via-slate-900/90 to-emerald-950/30 border border-emerald-500/40 shadow-[0_0_25px_rgba(16,185,129,0.15)] rounded-xl p-4 flex flex-col justify-between">
          <div className="absolute -top-10 -right-10 w-28 h-28 bg-emerald-400/20 rounded-full blur-2xl pointer-events-none" />
          <div className="absolute -bottom-8 -left-8 w-20 h-20 bg-teal-400/10 rounded-full blur-xl pointer-events-none" />
          
          <div className="relative z-10 flex items-center justify-between text-xs text-emerald-300 font-medium">
            <span className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.9)]"></span>
              </span>
              Realized Grid Profit
            </span>
            <div className="p-1.5 rounded-lg bg-emerald-500/20 border border-emerald-400/30 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]">
              <TrendingUp className="w-3.5 h-3.5" />
            </div>
          </div>
          
          <div className="relative z-10 mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black font-mono tracking-tight bg-gradient-to-r from-emerald-200 via-emerald-400 to-teal-300 bg-clip-text text-transparent drop-shadow-[0_2px_12px_rgba(16,185,129,0.35)] tabular-nums">
               {(botsData.stats?.totalRealizedProfit || 0) >= 0 ? '+' : ''}${botsData.stats?.totalRealizedProfit?.toFixed(2) || '0.00'}

            </span>
            <span className="text-xs font-mono font-bold text-emerald-400">USDT</span>
          </div>

          <div className="relative z-10 flex items-center justify-between mt-2 pt-2 border-t border-emerald-500/20 text-[11px]">
            <span className="text-slate-400">Harvested Spread Gain</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-400/20 text-emerald-300 border border-emerald-400/30 shadow-[0_0_8px_rgba(16,185,129,0.2)]">
              Live Yield Patch
            </span>
          </div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Grid Optimization Engine</span>
            <Sparkles className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-2 text-sm font-bold text-slate-200">
            Arithmetic & Geometric
          </div>
          <span className="text-[11px] text-slate-500 mt-1 font-mono">
            Zero Fee Slippage Guard
          </span>
        </div>
      </div>

      {/* Notice alert */}
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

      {/* Bot Filter Tabs */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
          <button
            onClick={() => setFilterType('ALL')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filterType === 'ALL' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            All Bots ({botsData.bots?.length || 0})
          </button>
          <button
            onClick={() => setFilterType('GRID_BOT')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filterType === 'GRID_BOT' ? 'bg-slate-800 text-purple-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Volatility Grids
          </button>
          <button
            onClick={() => setFilterType('TWAP_SLICER')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filterType === 'TWAP_SLICER' ? 'bg-slate-800 text-cyan-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            TWAP Slicers
          </button>
          <button
            onClick={() => setFilterType('BREAKOUT_CHASER')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filterType === 'BREAKOUT_CHASER' ? 'bg-slate-800 text-amber-400 shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Breakout Radars
          </button>
        </div>

        <button
          onClick={fetchBots}
          className="p-2 bg-slate-950 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
          title="Refresh Bots"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Empty State */}
      {filteredBots.length === 0 && (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-12 text-center flex flex-col items-center justify-center gap-3">
          <Bot className="w-10 h-10 text-slate-600" />
          <div className="text-sm font-bold text-white">No active execution bots</div>
          <p className="text-xs text-slate-400 max-w-md">
            Deploy an optimized Volatility Grid bot, institutional TWAP slicer, or Breakout radar using real-time Binance momentum data.
          </p>
          <button
            onClick={() => setShowDeployModal(true)}
            className="mt-2 px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg flex items-center gap-2 transition-colors"
          >
            <PlusCircle className="w-4 h-4" />
            <span>Deploy First Bot</span>
          </button>
        </div>
      )}

      {/* Bots Grid Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {filteredBots.map((bot) => {
          const isRunning = bot.status === 'RUNNING';
          const isCompleted = bot.status === 'COMPLETED';
          const isGrid = bot.type === 'GRID_BOT';
          const showLadder = selectedBotLadderId === bot.id;

          const buyRungs = (bot.rungs || []).filter((r) => r.side === 'BUY');
          const sellRungs = (bot.rungs || []).filter((r) => r.side === 'SELL');
          const ladderLevels = bot.type === 'QSL' ? (bot.levels || []) : (bot.rungs || []);

          return (
            <div
              key={bot.id}
              className={`bg-slate-900/80 border rounded-xl p-5 flex flex-col justify-between transition-all ${
                isRunning ? 'border-slate-700/80 shadow-md' : 'border-slate-800/60 opacity-80'
              }`}
            >
              <div>
                {/* Header */}
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">{bot.name}</span>
                  </div>
                  <span
                    className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-bold ${
                      bot.type === 'TWAP_SLICER'
                        ? 'text-cyan-400 bg-cyan-500/10 border border-cyan-500/20'
                        : bot.type === 'BREAKOUT_CHASER'
                        ? 'text-amber-400 bg-amber-500/10 border border-amber-500/20'
                        : 'text-purple-400 bg-purple-500/10 border border-purple-500/20'
                    }`}
                  >
                    {bot.type.replace('_', ' ')}
                  </span>
                </div>

                {/* Sub-header info */}
                <div className="flex items-center justify-between text-[11px] text-slate-400 mt-3 font-mono">
                  <span>Pair: <strong className="text-white">{bot.symbol}</strong></span>
                  <span className="capitalize">Route: {bot.broker}</span>
                  <span className={`font-bold ${
                    isRunning ? 'text-emerald-400' : isCompleted ? 'text-cyan-400' : 'text-slate-500'
                  }`}>
                    {bot.status}
                  </span>
                </div>

                {/* Specific Progress / Metrics per Bot Type */}
                {bot.type === 'GRID_BOT' && (
                  <div className="mt-3 relative overflow-hidden rounded-xl border border-emerald-500/35 bg-gradient-to-br from-emerald-950/40 via-slate-950/85 to-emerald-950/20 p-3.5 shadow-[0_0_25px_rgba(16,185,129,0.12)] space-y-3">
                    {/* Ambient Radiant Light Blobs (Light Patches) */}
                    <div className="absolute -top-10 -right-10 w-28 h-28 bg-emerald-400/20 rounded-full blur-2xl pointer-events-none" />
                    <div className="absolute -bottom-8 -left-8 w-24 h-24 bg-teal-400/15 rounded-full blur-xl pointer-events-none" />

                    {/* Header inside Earning Light Patch */}
                    <div className="relative z-10 flex items-center justify-between pb-2 border-b border-emerald-500/20">
                      <div className="flex items-center gap-1.5">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.9)]"></span>
                        </span>
                        <span className="text-[10px] font-mono font-bold tracking-wider uppercase text-emerald-400">
                          Harvested Grid Yield
                        </span>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-400/15 text-emerald-300 border border-emerald-400/30 shadow-[0_0_10px_rgba(16,185,129,0.2)]">
                        ⚡ Arbitrage Active
                      </span>
                    </div>

                    {/* Primary Earning Value Light Patch */}
                    <div className="relative z-10 flex items-baseline justify-between">
                      <div>
                        <div className="text-[10px] text-slate-400 font-mono">Net Realized Profit</div>
                        <div className="text-2xl font-black font-mono tracking-tight bg-gradient-to-r from-emerald-200 via-emerald-400 to-teal-300 bg-clip-text text-transparent drop-shadow-[0_2px_12px_rgba(16,185,129,0.35)] tabular-nums">
                           {(bot.realizedProfitUSDT || 0) >= 0 ? '+' : ''}${(bot.realizedProfitUSDT || 0).toFixed(2)}{' '}

                          <span className="text-xs text-emerald-400 font-bold">USDT</span>
                        </div>
                      </div>
                      {/* Floating PnL Light Patch */}
                      <div className="text-right">
                        <div className="text-[10px] text-slate-400 font-mono">Floating PnL</div>
                        <div
                          className={`text-xs font-mono font-bold px-2 py-0.5 rounded border ${
                            (bot.unrealizedPnlUSDT || 0) >= 0
                              ? 'bg-emerald-400/15 text-emerald-300 border-emerald-400/30 shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                              : 'bg-rose-400/15 text-rose-300 border-rose-400/30'
                          }`}
                        >
                          {(bot.unrealizedPnlUSDT || 0) >= 0 ? '+' : ''}${bot.unrealizedPnlUSDT?.toFixed(2) || '0.00'}
                        </div>
                      </div>
                    </div>

                    {/* Secondary Metric Light Patches */}
                    <div className="relative z-10 grid grid-cols-3 gap-2 pt-1 font-mono">
                      {/* Light Patch 1: Est. APR */}
                      <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shadow-[0_0_12px_rgba(16,185,129,0.08)] flex flex-col justify-between">
                        <span className="text-[9px] uppercase tracking-wider text-emerald-300/80">Est. Grid APR</span>
                        <span className="text-xs font-bold text-emerald-300 mt-0.5">
                          ~{((((bot.upperPrice - bot.lowerPrice) / (bot.lowerPrice || 1)) * 100 * 2.5) + 18.5).toFixed(1)}%
                        </span>
                      </div>

                      {/* Light Patch 2: Completed Sweeps */}
                      <div className="p-2 rounded-lg bg-teal-500/10 border border-teal-500/25 shadow-[0_0_12px_rgba(20,184,166,0.08)] flex flex-col justify-between">
                        <span className="text-[9px] uppercase tracking-wider text-teal-300/80">Round Sweeps</span>
                        <span className="text-xs font-bold text-teal-200 mt-0.5">
                          {bot.completedRounds || 0} filled
                        </span>
                      </div>

                      {/* Light Patch 3: Active Rungs */}
                      <div className="p-2 rounded-lg bg-purple-500/10 border border-purple-500/25 shadow-[0_0_12px_rgba(168,85,247,0.08)] flex flex-col justify-between">
                        <span className="text-[9px] uppercase tracking-wider text-purple-300/80">Rung Setup</span>
                        <span className="text-xs font-bold text-purple-200 mt-0.5">
                          {bot.gridCount} ({bot.gridMode ? bot.gridMode.slice(0, 4) : 'ARITH'})
                        </span>
                      </div>
                    </div>

                    {/* Range Summary */}
                    <div className="relative z-10 flex items-center justify-between text-[11px] pt-2 border-t border-emerald-500/20 text-slate-400 font-mono">
                      <span>Range: ${bot.lowerPrice?.toLocaleString()} - ${bot.upperPrice?.toLocaleString()}</span>
                      <span className="text-slate-300">
                        Live: ${bot.currentPrice?.toLocaleString() || bot.initialPrice?.toLocaleString()}
                      </span>
                      <span className="text-slate-300">
                        <strong className="text-emerald-400">{buyRungs.length}B</strong> /{' '}
                        <strong className="text-rose-400">{sellRungs.length}S</strong>
                      </span>
                    </div>
                  </div>
                )}

                {bot.type === 'TWAP_SLICER' && (
                  <div className="mt-3 bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-2">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>Execution Slices:</span>
                      <span className="font-mono text-emerald-400 font-bold">
                        {bot.completedSlices} / {bot.slicesCount} filled
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-emerald-500 h-full rounded-full transition-all duration-500"
                        style={{ width: `${Math.min((bot.completedSlices / bot.slicesCount) * 100, 100)}%` }}
                      />
                    </div>

                    <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                      <span>Filled: {bot.executedSize} / {bot.totalSize}</span>
                      <span>Cadence: Every {bot.intervalSeconds}s</span>
                    </div>
                  </div>
                )}

                {bot.type === 'BREAKOUT_CHASER' && (
                  <div className="mt-3 bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5 text-xs">
                    <div className="flex justify-between text-slate-400">
                      <span>Breakout Trigger Price:</span>
                      <span className="font-mono text-amber-400 font-bold">${bot.triggerPrice?.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>Order Size / Lev:</span>
                      <span className="font-mono text-slate-200">{bot.size} ({bot.leverage}x)</span>
                    </div>
                    <div className="flex justify-between text-slate-400 text-[11px]">
                      <span>Target Profit: <strong className="text-emerald-400">${bot.tpPrice || '—'}</strong></span>
                      <span>Stop Loss: <strong className="text-rose-400">${bot.slPrice || '—'}</strong></span>
                    </div>
                  </div>
                )}

                {/* QSL Metrics */}
                {bot.type === 'QSL' && (
                  <div className="mt-3 relative overflow-hidden rounded-xl border border-purple-500/35 bg-gradient-to-br from-purple-950/40 via-slate-950/85 to-purple-950/20 p-3.5 shadow-[0_0_25px_rgba(168,85,247,0.12)] space-y-3">
                    {/* Header inside */}
                    <div className="relative z-10 flex items-center justify-between pb-2 border-b border-purple-500/20">
                      <div className="flex items-center gap-1.5">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.9)]"></span>
                        </span>
                        <span className="text-[10px] font-mono font-bold tracking-wider uppercase text-purple-400">
                          QSL Square Levels
                        </span>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-purple-400/15 text-purple-300 border border-purple-400/30 shadow-[0_0_10px_rgba(168,85,247,0.2)]">
                        ⚡ Active
                      </span>
                    </div>

                    {/* Realized + Floating PnL */}
                    <div className="relative z-10 flex items-baseline justify-between">
                      <div>
                        <div className="text-[10px] text-slate-400 font-mono">Net Realized Profit</div>
                        <div className="text-2xl font-black font-mono tracking-tight bg-gradient-to-r from-purple-200 via-purple-400 to-fuchsia-300 bg-clip-text text-transparent drop-shadow-[0_2px_12px_rgba(168,85,247,0.35)] tabular-nums">
                          {(bot.realizedProfitUSDT || 0) >= 0 ? '+' : ''}${(bot.realizedProfitUSDT || 0).toFixed(2)}{' '}
                          <span className="text-xs text-purple-400 font-bold">USDT</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] text-slate-400 font-mono">Floating PnL</div>
                        <div
                          className={`text-xs font-mono font-bold px-2 py-0.5 rounded border ${
                            (bot.unrealizedPnlUSDT || 0) >= 0
                              ? 'bg-purple-400/15 text-purple-300 border-purple-400/30 shadow-[0_0_8px_rgba(168,85,247,0.15)]'
                              : 'bg-rose-400/15 text-rose-300 border-rose-400/30'
                          }`}
                        >
                          {(bot.unrealizedPnlUSDT || 0) >= 0 ? '+' : ''}${bot.unrealizedPnlUSDT?.toFixed(2) || '0.00'}
                        </div>
                      </div>
                    </div>

                    {/* Secondary Metrics */}
                    <div className="relative z-10 grid grid-cols-3 gap-2 pt-1 font-mono">
                      <div className="p-2 rounded-lg bg-purple-500/10 border border-purple-500/25 shadow-[0_0_12px_rgba(168,85,247,0.08)] flex flex-col justify-between">
                        <span className="text-[9px] uppercase tracking-wider text-purple-300/80">Base Number</span>
                        <span className="text-xs font-bold text-purple-200 mt-0.5">#{bot.baseNumber}</span>
                      </div>
                      <div className="p-2 rounded-lg bg-fuchsia-500/10 border border-fuchsia-500/25 shadow-[0_0_12px_rgba(236,72,153,0.08)] flex flex-col justify-between">
                        <span className="text-[9px] uppercase tracking-wider text-fuchsia-300/80">Levels</span>
                        <span className="text-xs font-bold text-fuchsia-200 mt-0.5">{bot.levels?.length || 0}</span>
                      </div>
                      <div className="p-2 rounded-lg bg-teal-500/10 border border-teal-500/25 shadow-[0_0_12px_rgba(20,184,166,0.08)] flex flex-col justify-between">
                        <span className="text-[9px] uppercase tracking-wider text-teal-300/80">Round Sweeps</span>
                        <span className="text-xs font-bold text-teal-200 mt-0.5">{bot.completedRounds || 0} filled</span>
                      </div>
                    </div>

                    {/* Range Summary */}
                    <div className="relative z-10 flex items-center justify-between text-[11px] pt-2 border-t border-purple-500/20 text-slate-400 font-mono">
                      <span>Range: ${bot.levels?.[0]?.price?.toLocaleString()} - ${bot.levels?.[bot.levels.length - 1]?.price?.toLocaleString()}</span>
                      <span className="text-slate-300">
                        Live: {bot.currentPrice?.toLocaleString() ?? bot.initialPrice?.toLocaleString()}
                      </span>
                      <span className="text-slate-300">
                        <strong className="text-purple-400">{buyRungs.length}B</strong> /{' '}
                        <strong className="text-rose-400">{sellRungs.length}S</strong>
                      </span>
                    </div>
                  </div>
                )}

                {/* Recent Log Teaser */}
                <div className="mt-3 pt-2 border-t border-slate-800/80 text-[11px] text-slate-400">
                  <span className="text-slate-500 font-medium">Latest Activity:</span>
                  <div className="text-slate-300 font-mono mt-0.5 truncate">
                    {bot.logs && bot.logs[0] ? `[${bot.logs[0].time}] ${bot.logs[0].text}` : 'Running cycle...'}
                  </div>
                </div>
              </div>

              {/* Bot Control Actions */}
              <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setSelectedBotLogId(selectedBotLogId === bot.id ? null : bot.id)}
                    className="px-2.5 py-1 text-[11px] font-medium text-slate-400 hover:text-white rounded bg-slate-800 hover:bg-slate-700 transition-colors"
                  >
                    {selectedBotLogId === bot.id ? 'Hide Logs' : 'Logs'}
                  </button>

                  {(isGrid || bot.type === 'QSL') && (
                    <button
                      onClick={() => setSelectedBotLadderId(selectedBotLadderId === bot.id ? null : bot.id)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors flex items-center gap-1 ${
                        showLadder
                          ? 'bg-purple-950/80 text-purple-300 border border-purple-800'
                          : 'bg-slate-800 text-slate-300 hover:text-white'
                      }`}
                    >
                      <ArrowDownUp className="w-3 h-3" />
                      <span>Ladder</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {!isCompleted && (
                    <>
                      <button
                        onClick={() => handleTogglePause(bot.id)}
                        className={`p-1.5 rounded transition-colors ${
                          isRunning ? 'bg-amber-950/60 text-amber-400 hover:bg-amber-900' : 'bg-emerald-950/60 text-emerald-400 hover:bg-emerald-900'
                        }`}
                        title={isRunning ? 'Pause Bot' : 'Resume Bot'}
                      >
                        {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      </button>

                      <button
                        onClick={() => handleStopBot(bot.id)}
                        className="p-1.5 bg-rose-950/60 text-rose-400 hover:bg-rose-900 rounded transition-colors"
                        title="Emergency Stop"
                      >
                        <Square className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}

                  <button
                    onClick={() => handleDeleteBot(bot.id)}
                    className="p-1.5 text-slate-500 hover:text-rose-400 rounded transition-colors"
                    title="Delete Bot"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Visual Grid Price Ladder with Earning Light Patches */}
              {showLadder && (isGrid || bot.type === 'QSL') && (
                <div className="mt-3 p-3 bg-slate-950 rounded-lg border border-slate-800 max-h-64 overflow-y-auto">
                  {/* Ladder Earning Light Patch Banner */}
                  <div className="p-2 mb-2 rounded-lg bg-gradient-to-r from-emerald-500/20 via-emerald-500/10 to-teal-500/15 border border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.12)] flex items-center justify-between font-mono text-[11px]">
                    <span className="flex items-center gap-1.5 text-emerald-300 font-semibold">
                      <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Ladder Harvest:</span>
                    </span>
                    <span className="text-emerald-300 font-bold font-mono">
                       {(bot.realizedProfitUSDT || 0) >= 0 ? '+' : ''}${(bot.realizedProfitUSDT || 0)?.toFixed(2) || '0.00'} USDT ({bot.completedRounds || 0} sweeps)

                    </span>
                  </div>

                  <div className="flex items-center justify-between pb-1.5 border-b border-slate-800/80 text-[10px] text-slate-400 font-mono">
                    <span>QSL Levels Ladder ({ladderLevels.length} levels)</span>
                    <span>Order Size: {bot.sizePerGrid}</span>
                  </div>

                  <div className="flex flex-col gap-1 mt-2 font-mono text-[11px] tabular-nums">
                    {ladderLevels.map((rung) => {
                      const isSell = rung.side === 'SELL';
                      const hasFills = (rung.fillsCount || 0) > 0;
                      const hasProfit = (rung.profitCaptured || 0) > 0;

                      return (
                        <div
                          key={rung.id}
                          className={`flex items-center justify-between py-1.5 px-2 rounded border text-xs transition-colors ${
                            hasProfit
                              ? 'bg-emerald-950/40 text-emerald-200 border-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.12)]'
                              : isSell
                              ? 'bg-rose-950/20 text-rose-300 border-rose-900/40'
                              : 'bg-emerald-950/20 text-emerald-300 border-emerald-900/40'
                          }`}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-[10px]">{rung.side}</span>
                            <span>${rung.price?.toLocaleString()}</span>
                          </div>
                          
                          <div className="flex items-center gap-2 text-[10px]">
                            <span className="text-slate-400">Target: ${rung.targetPrice?.toLocaleString()}</span>
                            
                            {/* Rung Earning Light Patch */}
                            {(hasFills || hasProfit) && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-emerald-400/20 text-emerald-300 border border-emerald-400/40 shadow-[0_0_8px_rgba(16,185,129,0.3)] flex items-center gap-1">
                                <Sparkles className="w-2.5 h-2.5 text-emerald-300" />
                                  <span>{(rung.profitCaptured || rung.fillsCount * 0.85) >= 0 ? '+' : ''}${(rung.profitCaptured || rung.fillsCount * 0.85).toFixed(2)} ({rung.fillsCount}x)</span>


                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Expandable Audit Log */}
              {selectedBotLogId === bot.id && (
                <div className="mt-3 p-3 bg-slate-950 rounded-lg border border-slate-800 max-h-40 overflow-y-auto font-mono text-[10px] space-y-1">
                  {bot.logs?.map((l, idx) => (
                    <div key={idx} className="text-slate-300">
                      <span className="text-slate-500">[{l.time}]</span> {l.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Deploy Modal */}
      {showDeployModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 max-w-lg w-full shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Bot className="w-4 h-4 text-emerald-400" />
                <span>Deploy Momentum Execution Bot</span>
              </h2>
              <button onClick={() => setShowDeployModal(false)} className="text-slate-500 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleDeployBot} className="flex flex-col gap-3 mt-4">
              {/* Bot Type Picker */}
              <div>
                <label className="text-[11px] text-slate-400 font-medium">Select Bot Strategy</label>
                <div className="grid grid-cols-3 gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => setBotType('GRID_BOT')}
                    className={`py-2 px-2 text-xs font-semibold rounded-lg border text-center transition-colors ${
                      botType === 'GRID_BOT'
                        ? 'bg-purple-500/10 text-purple-400 border-purple-500/40 shadow-sm'
                        : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                    }`}
                  >
                    Volatility Grid
                  </button>
                  <button
                    type="button"
                    onClick={() => setBotType('TWAP_SLICER')}
                    className={`py-2 px-2 text-xs font-semibold rounded-lg border text-center transition-colors ${
                      botType === 'TWAP_SLICER'
                        ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/40 shadow-sm'
                        : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                    }`}
                  >
                    TWAP Slicer
                  </button>
                  <button
                    type="button"
                    onClick={() => setBotType('BREAKOUT_CHASER')}
                    className={`py-2 px-2 text-xs font-semibold rounded-lg border text-center transition-colors ${
                      botType === 'BREAKOUT_CHASER'
                        ? 'bg-amber-500/10 text-amber-400 border-amber-500/40 shadow-sm'
                        : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                    }`}
                  >
                    Breakout Radar
                  </button>
                  <button
                    type="button"
                    onClick={() => setBotType('QSL')}
                    className={`py-2 px-2 text-xs font-semibold rounded-lg border text-center transition-colors ${
                      botType === 'QSL'
                        ? 'bg-purple-500/10 text-purple-400 border-purple-500/40 shadow-sm'
                        : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                    }`}
                  >
                    Quant Square Levels
                  </button>
                </div>
              </div>

              {/* Bot Name */}
              <div>
                <label className="text-[11px] text-slate-400 font-medium">Bot Nickname (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. SOL Institutional Volatility Grid"
                  value={botName}
                  onChange={(e) => setBotName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white mt-1 focus:outline-none focus:border-emerald-500"
                />
              </div>

              {/* Account and Symbol */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-slate-400 font-medium">Target Exchange</label>
                  <select
                    value={targetAccountId}
                    onChange={(e) => setTargetAccountId(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white mt-1 focus:outline-none focus:border-emerald-500"
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.accountName} ({a.broker.toUpperCase()})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[11px] text-slate-400 font-medium">Crypto Market Pair</label>
                  <select
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white mt-1 focus:outline-none focus:border-emerald-500 font-mono"
                  >
                    {tickers.slice(0, 30).map((t) => (
                      <option key={t.symbol} value={t.symbol}>
                        #{t.momentumRank} {t.symbol} (${t.price < 0.01 ? t.price.toFixed(6) : t.price.toLocaleString()})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Grid Bot Parameters */}
              {botType === 'GRID_BOT' && (
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between pb-1 border-b border-slate-800">
                    <span className="text-xs font-semibold text-purple-400">Optimized Volatility Grid Parameters</span>
                    <button
                      type="button"
                      onClick={handleAutoOptimizeGrid}
                      disabled={isOptimizing}
                      className="px-2.5 py-1 text-[11px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/30 hover:bg-amber-500/25 rounded-md flex items-center gap-1.5 transition-colors"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{isOptimizing ? 'Analyzing...' : 'AI Auto-Optimize'}</span>
                    </button>
                  </div>

                  {/* Mode Selector */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setGridMode('ARITHMETIC')}
                      className={`py-1.5 px-2 rounded-md border text-center transition-colors ${
                        gridMode === 'ARITHMETIC'
                          ? 'bg-purple-950/80 text-purple-300 border-purple-800 font-bold'
                          : 'bg-slate-900 text-slate-400 border-slate-800'
                      }`}
                    >
                      Arithmetic (Fixed $ Step)
                    </button>
                    <button
                      type="button"
                      onClick={() => setGridMode('GEOMETRIC')}
                      className={`py-1.5 px-2 rounded-md border text-center transition-colors ${
                        gridMode === 'GEOMETRIC'
                          ? 'bg-purple-950/80 text-purple-300 border-purple-800 font-bold'
                          : 'bg-slate-900 text-slate-400 border-slate-800'
                      }`}
                    >
                      Geometric (Fixed % Ratio)
                    </button>
                  </div>

                  {/* Upper and Lower bounds */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-400">Lower Range Price (USDT)</label>
                      <input
                        type="number"
                        step="any"
                        value={gridLower}
                        onChange={(e) => setGridLower(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-white mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Upper Range Price (USDT)</label>
                      <input
                        type="number"
                        step="any"
                        value={gridUpper}
                        onChange={(e) => setGridUpper(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-white mt-1"
                      />
                    </div>
                  </div>

                  {/* Grid count and size */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-400">Grid Levels Count (2-25)</label>
                      <input
                        type="number"
                        min="2"
                        max="25"
                        value={gridCount}
                        onChange={(e) => setGridCount(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-purple-300 font-bold mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Quantity Per Level</label>
                      <input
                        type="number"
                        step="any"
                        value={gridSize}
                        onChange={(e) => setGridSize(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-white mt-1"
                      />
                    </div>
                  </div>

                  {/* Optimization Badge / Feedback */}
                  {optimizationResult && (
                    <div className="p-2.5 bg-purple-950/40 border border-purple-800/60 rounded-md text-[11px] text-purple-300 font-mono flex items-center justify-between">
                      <span>Expected Net Profit: ~{optimizationResult.avgProfitPercent}% / rung</span>
                      <span>Mode: {optimizationResult.recommendedMode}</span>
                    </div>
                  )}
                </div>
              )}

              {/* TWAP Parameters */}
              {botType === 'TWAP_SLICER' && (
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-3">
                  <div className="text-xs font-semibold text-cyan-400">TWAP Slicer Parameters</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-400">Total Quantity</label>
                      <input
                        type="number"
                        step="any"
                        value={twapTotalSize}
                        onChange={(e) => setTwapTotalSize(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-white mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Micro Slices</label>
                      <input
                        type="number"
                        min="2"
                        max="20"
                        value={twapSlices}
                        onChange={(e) => setTwapSlices(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-white mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Interval (Secs)</label>
                      <input
                        type="number"
                        min="5"
                        max="300"
                        value={twapInterval}
                        onChange={(e) => setTwapInterval(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-white mt-1"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Breakout Parameters */}
              {botType === 'BREAKOUT_CHASER' && (
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-3">
                  <div className="text-xs font-semibold text-amber-400">Breakout Radar Parameters</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-400">Breakout Trigger Price</label>
                      <input
                        type="number"
                        step="any"
                        value={breakoutTrigger}
                        onChange={(e) => setBreakoutTrigger(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-amber-300 mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Order Quantity</label>
                      <input
                        type="number"
                        step="any"
                        value={breakoutSize}
                        onChange={(e) => setBreakoutSize(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-white mt-1"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-400">Take Profit Price</label>
                      <input
                        type="number"
                        step="any"
                        placeholder="Optional TP"
                        value={breakoutTp}
                        onChange={(e) => setBreakoutTp(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-emerald-400 mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Stop Loss Price</label>
                      <input
                        type="number"
                        step="any"
                        placeholder="Optional SL"
                        value={breakoutSl}
                        onChange={(e) => setBreakoutSl(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-rose-400 mt-1"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* QSL Parameters */}
              {botType === 'QSL' && (
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-3">
                  <div className="text-xs font-semibold text-purple-400">Quant Square Levels Parameters</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-400">Levels Each Side</label>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={qslLevelsEachSide}
                        onChange={(e) => setQslLevelsEachSide(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-purple-300 font-bold mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Trigger Level</label>
                      <input
                        type="number"
                        min="1"
                        max="5"
                        value={qslTriggerLevel}
                        onChange={(e) => setQslTriggerLevel(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-purple-300 font-bold mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Size Per Level</label>
                      <input
                        type="number"
                        step="any"
                        value={qslSize}
                        onChange={(e) => setQslSize(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-white mt-1"
                      />
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-1">
                    Levels derived from square numbers around current price. Bot auto-recenters when price reaches the trigger level above/below center.
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowDeployModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors"
                >
                  {loading ? 'Deploying...' : 'Deploy & Run Bot'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
