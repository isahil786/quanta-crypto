import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  TrendingDown,
  AlertCircle,
  CheckCircle2,
  Sliders,
  ArrowDownUp,
  Clock,
  Zap,
  Search,
  Activity,
  Flame,
} from 'lucide-react';

export default function Dashboard({
  accounts,
  activeAccountId,
  tickers,
  selectedSymbol,
  setSelectedSymbol,
  onOrderPlaced,
}) {
  const activeAccount = accounts.find((a) => a.id === activeAccountId) || accounts[0];
  const broker = activeAccount?.broker || 'coinswitch';
  const isCoinSwitchSpot = broker === 'coinswitch' && activeAccount?.segment === 'SPOT';

  // Selected pair (from live Binance top 100)
  const currentPair = tickers.find((t) => t.symbol === selectedSymbol) || tickers[0] || {
    symbol: 'BTCUSDT',
    base: 'BTC',
    price: 76000.0,
    change24h: 2.1,
    high24h: 76500.0,
    low24h: 74200.0,
    volume24h: '2.1B',
    precision: 2,
    momentumRank: 1,
  };

  // Search filter for top 100 ribbon
  const [tickerSearch, setTickerSearch] = useState('');

  // Order Ticket State
  const [side, setSide] = useState('BUY');
  const [orderType, setOrderType] = useState('LIMIT');
  const [price, setPrice] = useState(currentPair.price.toString());
  const [size, setSize] = useState('0.1');
  const [leverage, setLeverage] = useState(broker === 'delta' ? 10 : 1);
  const [enableTpSl, setEnableTpSl] = useState(false);
  const [tpPrice, setTpPrice] = useState('');
  const [slPrice, setSlPrice] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState(null);

  // Depth Data State (Live from Binance)
  const [depth, setDepth] = useState({ bids: [], asks: [], spread: 0, spreadPercent: 0 });

  // Recent Trades State (Live from Binance)
  const [liveTrades, setLiveTrades] = useState([]);
  const [activeView, setActiveView] = useState('orderbook'); // 'orderbook' | 'recent_trades'

  // Update orderType if CoinSwitch spot is selected
  useEffect(() => {
    if (isCoinSwitchSpot && orderType === 'MARKET') {
      setOrderType('LIMIT');
    }
  }, [isCoinSwitchSpot, orderType]);

  // Sync price when pair changes or updates
  useEffect(() => {
    if (currentPair?.price) {
      setPrice(currentPair.price.toString());
    }
  }, [currentPair?.symbol]);

  // Fetch live orderbook depth from Binance
  useEffect(() => {
    let isMounted = true;
    const fetchDepth = async () => {
      try {
        const res = await fetch(`/api/market/depth?symbol=${currentPair.symbol}&limit=12`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted) setDepth(data);
        }
      } catch (err) {
        // silent fallback
      }
    };

    fetchDepth();
    const interval = setInterval(fetchDepth, 2000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [currentPair.symbol]);

  // Fetch live trades from Binance
  useEffect(() => {
    let isMounted = true;
    const fetchTrades = async () => {
      try {
        const res = await fetch(`/api/market/trades?symbol=${currentPair.symbol}&limit=15`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted) setLiveTrades(data);
        }
      } catch (err) {
        // silent fallback
      }
    };

    fetchTrades();
    const interval = setInterval(fetchTrades, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [currentPair.symbol]);

  // Order value calculation
  const numericPrice = orderType === 'MARKET' ? currentPair.price : Number(price) || currentPair.price;
  const numericSize = Number(size) || 0;
  const orderValue = numericPrice * numericSize;
  const estimatedMargin = leverage > 1 ? orderValue / leverage : orderValue;
  const estimatedFee = orderValue * (broker === 'delta' ? 0.0005 : 0.001);

  // Quick percent size
  const handlePercentSize = (percent) => {
    const available = activeAccount?.availableMarginUSDT || 10000;
    const alloc = (available * percent) / 100;
    const calculatedSize = (alloc * (leverage || 1)) / (numericPrice || 1);
    setSize(calculatedSize.toFixed(calculatedSize < 1 ? 4 : 2));
  };

  // Submit Order
  const handleSubmitOrder = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setNotice(null);

    try {
      const payload = {
        accountId: activeAccount.id,
        symbol: currentPair.symbol,
        side,
        orderType,
        price: orderType === 'MARKET' ? currentPair.price : Number(price),
        size: Number(size),
        leverage: isCoinSwitchSpot ? 1 : Number(leverage),
        tpPrice: enableTpSl && tpPrice ? Number(tpPrice) : undefined,
        slPrice: enableTpSl && slPrice ? Number(slPrice) : undefined,
      };

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to place order');
      }

      setNotice({
        type: 'success',
        text: `Order #${data.id} placed on ${activeAccount.accountName} @ $${data.price}! Status: ${data.status}`,
      });

      if (onOrderPlaced) onOrderPlaced();
    } catch (err) {
      setNotice({
        type: 'error',
        text: err.message,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Filter tickers for ribbon
  const visibleTickers = tickers.filter((t) => {
    if (!tickerSearch) return true;
    const q = tickerSearch.toLowerCase();
    return t.symbol.toLowerCase().includes(q) || t.base?.toLowerCase().includes(q);
  });

  return (
    <div className="flex flex-col gap-5">
      {/* 1. Live Top 100 Momentum Ribbon (Binance Live Feed) */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs px-1">
          <div className="flex items-center gap-2">
            <Flame className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-bold text-white tracking-tight">Top 100 Momentum Coins</span>
            <span className="text-[11px] text-slate-500 font-mono">
              Live Binance Feed · {tickers.length} active pairs
            </span>
          </div>

          <div className="relative">
            <Search className="w-3 h-3 text-slate-500 absolute left-2.5 top-2" />
            <input
              type="text"
              placeholder="Search coin..."
              value={tickerSearch}
              onChange={(e) => setTickerSearch(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-md pl-7 pr-2.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500 w-36"
            />
          </div>
        </div>

        {/* Scrollable Ribbon */}
        <div className="overflow-x-auto scrollbar-none flex items-center gap-2 py-1">
          {visibleTickers.slice(0, 30).map((t) => {
            const isSelected = t.symbol === currentPair.symbol;
            const isPositive = t.change24h >= 0;
            return (
              <button
                key={t.symbol}
                onClick={() => setSelectedSymbol(t.symbol)}
                className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg transition-all text-left shrink-0 ${
                  isSelected
                    ? 'bg-slate-800 border border-emerald-500/40 shadow-sm'
                    : 'bg-slate-950/60 hover:bg-slate-800/50 border border-slate-800/80'
                }`}
              >
                <span className="text-[10px] font-mono font-bold text-slate-500">#{t.momentumRank}</span>
                <div>
                  <div className="text-xs font-bold text-white flex items-center gap-1">
                    <span>{t.symbol}</span>
                  </div>
                  <div className="text-[11px] text-slate-300 font-mono tabular-nums">
                    ${t.price < 0.01 ? t.price.toFixed(6) : t.price.toLocaleString(undefined, { minimumFractionDigits: t.precision })}
                  </div>
                </div>
                <div className={`text-xs font-mono font-bold flex items-center gap-0.5 tabular-nums ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {isPositive ? '+' : ''}{t.change24h}%
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Pair Header & Exchange Capability Notice */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-slate-900/60 border border-slate-800/80 rounded-xl px-5 py-3.5">
        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 font-mono">
                Momentum Rank #{currentPair.momentumRank || 1}
              </span>
              <h1 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                <span>{currentPair.symbol}</span>
                <span className="text-xs text-slate-400 font-normal">Live Binance Stream</span>
              </h1>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
              <span>24h High: <strong className="text-slate-200 font-mono tabular-nums">${currentPair.high24h?.toLocaleString()}</strong></span>
              <span>·</span>
              <span>24h Low: <strong className="text-slate-200 font-mono tabular-nums">${currentPair.low24h?.toLocaleString()}</strong></span>
              <span>·</span>
              <span>24h Vol: <strong className="text-emerald-400 font-mono tabular-nums">${currentPair.volume24h}</strong></span>
              <span>·</span>
              <span>Trades: <strong className="text-slate-300 font-mono tabular-nums">{currentPair.tradesCount?.toLocaleString()}</strong></span>
            </div>
          </div>
        </div>

        {/* Dynamic Capability Notice */}
        <div className="text-xs flex items-center gap-2 bg-slate-950/70 border border-slate-800 px-3 py-1.5 rounded-lg text-slate-300">
          <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>
            {isCoinSwitchSpot && (
              <>CoinSwitch Spot: <strong className="text-amber-300">LIMIT orders only</strong>. Market orders gated to Futures.</>
            )}
            {broker === 'delta' && (
              <>Delta Exchange: <strong className="text-cyan-300">Bracket & TP/SL orders</strong>, 100x leverage enabled.</>
            )}
            {broker === 'coindcx' && (
              <>CoinDCX Prime: <strong className="text-blue-300">Target & Stop-loss edit</strong>, 20x margin enabled.</>
            )}
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

      {/* 3. Terminal Grid: Orderbook Depth + Fast Order Ticket */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left Column: Live Order Book & Real-Time Trades (7 Cols) */}
        <div className="lg:col-span-7 bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 text-xs font-semibold text-slate-300">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setActiveView('orderbook')}
                  className={`px-2.5 py-1 rounded text-xs transition-colors ${
                    activeView === 'orderbook' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Live Order Book (Binance)
                </button>
                <button
                  onClick={() => setActiveView('recent_trades')}
                  className={`px-2.5 py-1 rounded text-xs transition-colors ${
                    activeView === 'recent_trades' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Live Market Trades
                </button>
              </div>
              <span className="text-emerald-400 font-mono text-[11px] flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Live Stream
              </span>
            </div>

            {activeView === 'orderbook' ? (
              /* Live Orderbook */
              <div className="mt-2">
                <div className="grid grid-cols-3 text-[11px] font-medium text-slate-500 py-1.5 border-b border-slate-800/60">
                  <span>Price (USDT)</span>
                  <span className="text-right">Size ({currentPair.base})</span>
                  <span className="text-right">Total ({currentPair.base})</span>
                </div>

                {/* Asks (Sells) */}
                <div className="flex flex-col gap-0.5 py-1 font-mono text-xs tabular-nums">
                  {depth.asks?.slice(0, 6).map((ask, idx) => (
                    <div key={`ask-${idx}`} className="grid grid-cols-3 relative py-0.5 text-rose-400 items-center">
                      <div
                        className="absolute right-0 top-0 bottom-0 bg-rose-500/10 pointer-events-none rounded"
                        style={{ width: `${Math.min((ask.total / (depth.asks[0]?.total || 10)) * 100, 100)}%` }}
                      />
                      <span className="font-semibold">${ask.price < 0.01 ? ask.price.toFixed(6) : ask.price.toLocaleString(undefined, { minimumFractionDigits: currentPair.precision })}</span>
                      <span className="text-right text-slate-300">{ask.size.toFixed(4)}</span>
                      <span className="text-right text-slate-400">{ask.total.toFixed(4)}</span>
                    </div>
                  ))}
                </div>

                {/* Mark Price & Live Spread */}
                <div className="my-2 py-2 px-3 bg-slate-950/80 border border-slate-800/80 rounded-lg flex items-center justify-between text-xs font-mono">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-white tabular-nums">
                      ${currentPair.price < 0.01 ? currentPair.price.toFixed(6) : currentPair.price.toLocaleString(undefined, { minimumFractionDigits: currentPair.precision })}
                    </span>
                    <span className={`text-[11px] font-bold ${currentPair.change24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {currentPair.change24h >= 0 ? '▲' : '▼'} {currentPair.change24h}%
                    </span>
                  </div>
                  <span className="text-slate-400 text-[11px]">
                    Spread: ${depth.spread} ({depth.spreadPercent}%)
                  </span>
                </div>

                {/* Bids (Buys) */}
                <div className="flex flex-col gap-0.5 py-1 font-mono text-xs tabular-nums">
                  {depth.bids?.slice(0, 6).map((bid, idx) => (
                    <div key={`bid-${idx}`} className="grid grid-cols-3 relative py-0.5 text-emerald-400 items-center">
                      <div
                        className="absolute right-0 top-0 bottom-0 bg-emerald-500/10 pointer-events-none rounded"
                        style={{ width: `${Math.min((bid.total / (depth.bids[depth.bids.length - 1]?.total || 10)) * 100, 100)}%` }}
                      />
                      <span className="font-semibold">${bid.price < 0.01 ? bid.price.toFixed(6) : bid.price.toLocaleString(undefined, { minimumFractionDigits: currentPair.precision })}</span>
                      <span className="text-right text-slate-300">{bid.size.toFixed(4)}</span>
                      <span className="text-right text-slate-400">{bid.total.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              /* Live Trades Stream from Binance */
              <div className="mt-2 overflow-x-auto">
                <div className="grid grid-cols-4 text-[11px] font-medium text-slate-500 py-1.5 border-b border-slate-800/60">
                  <span>Price (USDT)</span>
                  <span className="text-right">Size ({currentPair.base})</span>
                  <span className="text-right">Value (USDT)</span>
                  <span className="text-right">Time</span>
                </div>
                <div className="flex flex-col gap-1 py-1 font-mono text-xs tabular-nums max-h-[300px] overflow-y-auto">
                  {liveTrades.map((trd) => (
                    <div key={trd.id} className="grid grid-cols-4 py-1 items-center hover:bg-slate-800/30">
                      <span className={`font-semibold ${trd.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>
                        ${trd.price < 0.01 ? trd.price.toFixed(6) : trd.price.toLocaleString(undefined, { minimumFractionDigits: currentPair.precision })}
                      </span>
                      <span className="text-right text-slate-200">{trd.size.toFixed(4)}</span>
                      <span className="text-right text-slate-400">${trd.quoteQty.toFixed(2)}</span>
                      <span className="text-right text-slate-500 text-[10px]">{new Date(trd.time).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Quick Footer */}
          <div className="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-slate-500" />
              Routing orders to {broker.toUpperCase()}
            </span>
            <span className="font-mono text-slate-500 text-[11px]">Direct Binance Feed</span>
          </div>
        </div>

        {/* Right Column: Fast Order Ticket (5 Cols) */}
        <div className="lg:col-span-5 bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
          <form onSubmit={handleSubmitOrder} className="flex flex-col gap-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-emerald-400" />
                <span>Trade {currentPair.symbol}</span>
              </div>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                Avail: ${activeAccount?.availableMarginUSDT?.toLocaleString() || '10,000'} USDT
              </div>
            </div>

            {/* Buy / Sell Toggle */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-950 border border-slate-800 rounded-lg">
              <button
                type="button"
                onClick={() => setSide('BUY')}
                className={`py-2 text-xs font-bold rounded-md transition-all ${
                  side === 'BUY'
                    ? 'bg-emerald-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                BUY / LONG
              </button>
              <button
                type="button"
                onClick={() => setSide('SELL')}
                className={`py-2 text-xs font-bold rounded-md transition-all ${
                  side === 'SELL'
                    ? 'bg-rose-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                SELL / SHORT
              </button>
            </div>

            {/* Order Type Tabs */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOrderType('LIMIT')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                  orderType === 'LIMIT'
                    ? 'bg-slate-800 text-white border-slate-700 shadow-sm'
                    : 'text-slate-400 border-transparent hover:text-slate-200'
                }`}
              >
                Limit
              </button>
              <button
                type="button"
                disabled={isCoinSwitchSpot}
                onClick={() => !isCoinSwitchSpot && setOrderType('MARKET')}
                title={isCoinSwitchSpot ? 'CoinSwitch Spot only supports LIMIT orders' : 'Execute immediately at market price'}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md border transition-colors relative ${
                  isCoinSwitchSpot
                    ? 'opacity-40 cursor-not-allowed text-slate-600 border-slate-900 bg-slate-950'
                    : orderType === 'MARKET'
                    ? 'bg-slate-800 text-white border-slate-700 shadow-sm'
                    : 'text-slate-400 border-transparent hover:text-slate-200'
                }`}
              >
                Market {isCoinSwitchSpot && '(Locked)'}
              </button>
            </div>

            {/* Leverage Slider */}
            {!isCoinSwitchSpot && (
              <div className="flex flex-col gap-1.5 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="flex items-center gap-1">
                    <Sliders className="w-3 h-3" />
                    Leverage Margin
                  </span>
                  <span className="text-emerald-400 font-mono font-bold">{leverage}x</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max={broker === 'delta' ? '100' : '20'}
                  step="1"
                  value={leverage}
                  onChange={(e) => setLeverage(Number(e.target.value))}
                  className="w-full accent-emerald-500 h-1 bg-slate-800 rounded-lg cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                  <span>1x (Spot)</span>
                  <span>10x</span>
                  <span>{broker === 'delta' ? '50x' : '15x'}</span>
                  <span>{broker === 'delta' ? '100x' : '20x'}</span>
                </div>
              </div>
            )}

            {/* Price Input */}
            {orderType === 'LIMIT' && (
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-slate-400">Limit Price (USDT)</label>
                <div className="relative">
                  <input
                    type="number"
                    step="any"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-emerald-500"
                  />
                  <button
                    type="button"
                    onClick={() => setPrice(currentPair.price.toString())}
                    className="absolute right-2 top-1.5 text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded font-mono"
                  >
                    Mark Price
                  </button>
                </div>
              </div>
            )}

            {/* Size Input */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Quantity ({currentPair.base})</span>
                <span className="font-mono">Est. Value: ${orderValue.toFixed(2)}</span>
              </div>
              <input
                type="number"
                step="any"
                min="0.0000001"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                required
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-emerald-500"
              />
              {/* Quick % buttons */}
              <div className="grid grid-cols-4 gap-1.5 mt-1">
                {[0.25, 0.5, 0.75, 1.0].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => handlePercentSize(pct)}
                    className="py-1 text-[10px] bg-slate-950 border border-slate-800 hover:border-slate-700 rounded text-slate-400 hover:text-white font-mono"
                  >
                    {pct * 100}%
                  </button>
                ))}
              </div>
            </div>

            {/* TP / SL Toggle */}
            {!isCoinSwitchSpot && (
              <div className="flex flex-col gap-2 pt-2 border-t border-slate-800">
                <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300 select-none">
                  <input
                    type="checkbox"
                    checked={enableTpSl}
                    onChange={(e) => setEnableTpSl(e.target.checked)}
                    className="accent-emerald-500 rounded"
                  />
                  <span>Attach Take Profit & Stop Loss Bracket</span>
                </label>

                {enableTpSl && (
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <div>
                      <label className="text-[10px] text-slate-400">Take Profit Price</label>
                      <input
                        type="number"
                        step="any"
                        placeholder="Target price"
                        value={tpPrice}
                        onChange={(e) => setTpPrice(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono text-emerald-400 focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Stop Loss Price</label>
                      <input
                        type="number"
                        step="any"
                        placeholder="Stop loss"
                        value={slPrice}
                        onChange={(e) => setSlPrice(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono text-rose-400 focus:outline-none focus:border-rose-500"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Summary */}
            <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3 text-[11px] text-slate-400 font-mono flex flex-col gap-1">
              <div className="flex justify-between">
                <span>Required Margin:</span>
                <span className="text-white font-bold">${estimatedMargin.toFixed(2)} USDT</span>
              </div>
              <div className="flex justify-between">
                <span>Estimated Taker Fee:</span>
                <span className="text-slate-300">${estimatedFee.toFixed(4)} USDT</span>
              </div>
              <div className="flex justify-between">
                <span>Account Routing:</span>
                <span className="text-slate-300">{activeAccount?.accountName}</span>
              </div>
            </div>

            {/* Place Order Button */}
            <button
              type="submit"
              disabled={isSubmitting}
              className={`w-full py-2.5 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-2 ${
                side === 'BUY'
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  : 'bg-rose-600 hover:bg-rose-500 text-white'
              } ${isSubmitting ? 'opacity-60 cursor-not-allowed' : ''}`}
            >
              {isSubmitting ? (
                <span>Routing to {broker.toUpperCase()}...</span>
              ) : (
                <span>
                  {side} {currentPair.symbol} {orderType}
                </span>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
