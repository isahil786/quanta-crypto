import React, { useState, useEffect } from 'react';
import {
  Sliders,
  Clock,
  Zap,
  Search,
  Flame,
} from 'lucide-react';
import { useToast } from '../ui/Toast.jsx';
import ConfirmSheet from '../ui/ConfirmSheet.jsx';
import PriceChart from '../ui/PriceChart.jsx';
import PriceCell from '../ui/PriceCell.jsx';
import PositionsDock from '../ui/PositionsDock.jsx';
import PriceLadder from '../ui/PriceLadder.jsx';

// Live orders worth more than this (USD) also need a typed confirmation.
const TYPED_CONFIRM_ABOVE_USD = 5000;

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
  const toast = useToast();
  const isLive = activeAccount?.mode === 'REAL';
  const [pendingOrder, setPendingOrder] = useState(null);

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

  // Depth Data State (Live from Binance)
  const [depth, setDepth] = useState({ bids: [], asks: [], spread: 0, spreadPercent: 0 });

  // Recent Trades State (Live from Binance)
  const [liveTrades, setLiveTrades] = useState([]);
  const [activeView, setActiveView] = useState('orderbook'); // 'orderbook' | 'recent_trades'

// Update orderType if CoinSwitch spot is selected

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
  // Click a book level to prefill the ticket as a limit order at that price. Never sends anything itself;
  // live orders still go through the confirm sheet.
  const fillTicketFromBook = (nextSide, px) => {
    setSide(nextSide);
    setOrderType('LIMIT');
    setPrice(String(px));
  };

  // Paper accounts send straight away. Live accounts open the confirm sheet first.
  const handleSubmitOrder = (e) => {
    e.preventDefault();
    if (activeAccount?.mode !== 'REAL') { submitOrder(); return; }
    const px = orderType === 'MARKET' ? currentPair.price : Number(price);
    const value = Number(size) * px;
    setPendingOrder({ px, value });
  };

  // override: { side, orderType, price, size } from the ladder; otherwise the ticket fields are used.
  // Ladder entry point. Paper sends at once; live always opens the confirm sheet first.
  const requestOrder = (o) => {
    if (!isLive) { submitOrder(o); return; }
    setPendingOrder({ px: o.price, value: o.size * o.price, order: o });
  };

  const submitOrder = async (override) => {
    const o = override || { side, orderType, price: orderType === 'MARKET' ? currentPair.price : Number(price), size: Number(size) };
    setIsSubmitting(true);

    try {
      const payload = {
        accountId: activeAccount.id,
        symbol: currentPair.symbol,
        side: o.side,
        orderType: o.orderType,
        price: o.orderType === 'MARKET' ? currentPair.price : o.price,
        size: o.size,
        leverage: isCoinSwitchSpot ? 1 : Number(leverage),
        tpPrice: !override && enableTpSl && tpPrice ? Number(tpPrice) : undefined,
        slPrice: !override && enableTpSl && slPrice ? Number(slPrice) : undefined,
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

      toast('success', `Order #${data.id} ${String(data.status || 'placed').toLowerCase()}`, `${o.side} ${o.size} ${currentPair.symbol} @ ${data.price}`);
      setPendingOrder(null);
      if (onOrderPlaced) onOrderPlaced();
    } catch (err) {
      toast('error', 'Order rejected', err.message);
      setPendingOrder(null);
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
      {/* Movers strip: one line of top coins plus search */}
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
        <Flame className="size-4 shrink-0 text-live" aria-hidden />
        <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {visibleTickers.slice(0, 30).map((t) => {
            const isSelected = t.symbol === currentPair.symbol;
            const up = t.change24h >= 0;
            return (
              <button
                key={t.symbol}
                onClick={() => setSelectedSymbol(t.symbol)}
                aria-pressed={isSelected}
                className={`flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1 font-mono text-xs ${isSelected ? 'bg-raised text-ink ring-1 ring-accent' : 'text-muted hover:bg-raised/60 hover:text-ink'}`}
              >
                <span className="font-sans font-semibold">{t.symbol.replace('USDT', '')}</span>
                <span className={up ? 'text-up' : 'text-down'}>{up ? '▲ +' : '▼ '}{t.change24h}%</span>
              </button>
            );
          })}
        </div>
        <div className="relative shrink-0">
          <Search className="absolute left-2.5 top-2 size-3 text-muted" aria-hidden />
          <input
            type="text"
            aria-label="Search coin"
            placeholder="Search coin"
            value={tickerSearch}
            onChange={(e) => setTickerSearch(e.target.value)}
            className="w-32 rounded-lg border border-line bg-canvas py-1 pl-7 pr-2 text-xs text-ink"
          />
        </div>
      </div>

      {/* One pair header: symbol, price, change, 24h stats. Broker notes live in the info tooltip. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-ink">
          {currentPair.symbol}
          <span
            tabIndex={0}
            role="img"
            aria-label="Exchange notes"
            title={
              isCoinSwitchSpot ? 'CoinSwitch Spot: Market & Limit orders with TP/SL. Mirror Trading copies master orders to replicas.'
                : broker === 'delta' ? 'Delta Exchange: bracket and TP/SL orders, up to 100x leverage.'
                : broker === 'coindcx' ? 'CoinDCX Prime: target and stop-loss edit, up to 20x margin.' : ''
            }
            className="grid size-5 cursor-help place-items-center rounded-full border border-line text-[11px] text-muted"
          >
            i
          </span>
        </h1>
        <PriceCell value={currentPair.price} decimals={currentPair.precision ?? 2} className="text-2xl font-semibold" />
        <span className={`rounded-lg px-2 py-0.5 font-mono text-sm font-semibold ${currentPair.change24h >= 0 ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>
          {currentPair.change24h >= 0 ? '▲ +' : '▼ '}{currentPair.change24h}%
        </span>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {[
            ['24h high', `$${currentPair.high24h?.toLocaleString()}`],
            ['24h low', `$${currentPair.low24h?.toLocaleString()}`],
            ['24h volume', `$${currentPair.volume24h}`],
            ['Trades', currentPair.tradesCount?.toLocaleString()],
          ].map(([k, v]) => (
            <div key={k}><dt className="text-muted">{k}</dt><dd className="font-mono text-sm text-ink">{v}</dd></div>
          ))}
        </dl>
      </div>

      {/* 3. Terminal Grid: Orderbook Depth + Fast Order Ticket */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Chart (left), ticket (right, full height), book under the chart */}
        <PriceChart symbol={currentPair.symbol} className="lg:col-span-8" height={400} />
        {/* Left Column: Live Order Book & Real-Time Trades (7 Cols) */}
        <div className="lg:col-span-8 lg:col-start-1 bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
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
                    <button
                      type="button"
                      key={`ask-${idx}`}
                      onClick={() => fillTicketFromBook('SELL', ask.price)}
                      title="Click to fill the order ticket at this price. Nothing is sent until you place the order."
                      className="grid w-full grid-cols-3 relative py-0.5 text-left text-rose-400 items-center rounded hover:bg-raised">
                      <div
                        className="absolute right-0 top-0 bottom-0 bg-rose-500/10 pointer-events-none rounded"
                        style={{ width: `${Math.min((ask.total / (depth.asks[0]?.total || 10)) * 100, 100)}%` }}
                      />
                      <span className="font-semibold">${ask.price < 0.01 ? ask.price.toFixed(6) : ask.price.toLocaleString(undefined, { minimumFractionDigits: currentPair.precision })}</span>
                      <span className="text-right text-slate-300">{ask.size.toFixed(4)}</span>
                      <span className="text-right text-slate-400">{ask.total.toFixed(4)}</span>
                    </button>
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
                    <button
                      type="button"
                      key={`bid-${idx}`}
                      onClick={() => fillTicketFromBook('BUY', bid.price)}
                      title="Click to fill the order ticket at this price. Nothing is sent until you place the order."
                      className="grid w-full grid-cols-3 relative py-0.5 text-left text-emerald-400 items-center rounded hover:bg-raised">
                      <div
                        className="absolute right-0 top-0 bottom-0 bg-emerald-500/10 pointer-events-none rounded"
                        style={{ width: `${Math.min((bid.total / (depth.bids[depth.bids.length - 1]?.total || 10)) * 100, 100)}%` }}
                      />
                      <span className="font-semibold">${bid.price < 0.01 ? bid.price.toFixed(6) : bid.price.toLocaleString(undefined, { minimumFractionDigits: currentPair.precision })}</span>
                      <span className="text-right text-slate-300">{bid.size.toFixed(4)}</span>
                      <span className="text-right text-slate-400">{bid.total.toFixed(4)}</span>
                    </button>
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

        <PriceLadder
          key={`${activeAccountId}-${currentPair.symbol}`}
          depth={depth}
          price={currentPair.price}
          precision={currentPair.precision}
          isLive={isLive}
          onOrder={requestOrder}
          className="lg:col-span-8 lg:col-start-1"
        />

        {/* Right Column: Fast Order Ticket (5 Cols) */}
        <div className={`lg:col-span-4 lg:col-start-9 lg:row-start-1 lg:row-span-2 bg-slate-900/80 border ${isLive ? 'border-live/60' : 'border-slate-800'} rounded-xl p-5 flex flex-col justify-between`}>
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
                className={`py-2 text-xs font-bold rounded-md border transition-all ${
                  side === 'BUY'
                    ? 'bg-emerald-600 text-white border-emerald-500 shadow shadow-emerald-900/40'
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/20'
                }`}
              >
                BUY / LONG
              </button>
              <button
                type="button"
                onClick={() => setSide('SELL')}
                className={`py-2 text-xs font-bold rounded-md border transition-all ${
                  side === 'SELL'
                    ? 'bg-rose-600 text-white border-rose-500 shadow shadow-rose-900/40'
                    : 'bg-rose-500/10 text-rose-400 border-rose-500/25 hover:bg-rose-500/20'
                }`}
              >
                SELL / SHORT
              </button>
            </div>

            {/* Order Type Tabs */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-950 border border-slate-800 rounded-lg">
              <button
                type="button"
                onClick={() => setOrderType('LIMIT')}
                className={`py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                  orderType === 'LIMIT'
                    ? 'bg-cyan-600 text-white border-cyan-500 shadow'
                    : 'bg-slate-900 text-slate-300 border-slate-700 hover:bg-slate-800 hover:text-white'
                }`}
              >
                Limit
              </button>
              <button
                type="button"
                onClick={() => setOrderType('MARKET')}
                title="Execute immediately at the best available market price"
                className={`py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                  orderType === 'MARKET'
                    ? 'bg-cyan-600 text-white border-cyan-500 shadow'
                    : 'bg-slate-900 text-slate-300 border-slate-700 hover:bg-slate-800 hover:text-white'
                }`}
              >
                Market
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
                  {isLive ? `Review live order · ${side} ${currentPair.symbol}` : `${side} ${currentPair.symbol} ${orderType} (paper)`}
                </span>
              )}
            </button>
          </form>
        </div>
      </div>
      <PositionsDock accountId={activeAccountId} isLive={isLive} />
      <ConfirmSheet
        open={!!pendingOrder}
        title="Send live order?"
        subtitle={`This goes to ${activeAccount?.accountName} with real money.`}
        rows={(() => {
          const po = pendingOrder?.order;
          const rows = [
            ['Pair', currentPair.symbol],
            ['Side', po ? po.side : side],
            ['Type', po ? po.orderType : orderType],
            ['Size', String(po ? po.size : size)],
          ];
          if ((po ? po.orderType : orderType) === 'LIMIT') rows.push(['Limit price', String(po ? po.price : price)]);
          if (!isCoinSwitchSpot) rows.push(['Leverage', `${leverage}x`]);
          if (!po && enableTpSl && tpPrice) rows.push(['Take profit', String(tpPrice)]);
          if (!po && enableTpSl && slPrice) rows.push(['Stop loss', String(slPrice)]);
          rows.push(['Value', `≈ $${(pendingOrder?.value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`]);
          return rows;
        })()}
        warning={pendingOrder && pendingOrder.value > TYPED_CONFIRM_ABOVE_USD ? 'This is a large order. Type the side to confirm.' : undefined}
        typeToConfirm={pendingOrder && pendingOrder.value > TYPED_CONFIRM_ABOVE_USD ? (pendingOrder.order ? pendingOrder.order.side : side) : undefined}
        busy={isSubmitting}
        onConfirm={() => submitOrder(pendingOrder?.order)}
        onCancel={() => setPendingOrder(null)}
      />
    </div>
  );
}
