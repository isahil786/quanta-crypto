import {
  getLiveTop100MomentumCoins as okxTop100,
  getLiveOrderBookDepth as okxDepth,
  getLiveRecentTrades as okxTrades,
  getLiveKlines as okxKlines,
} from './okx.js';

// Live Binance Market Data Engine
// Pulls live 24hr tickers, live orderbook depth, and live trades for Top 100 Momentum Coins

export const STABLE_PAIRS = new Set([
  'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'EURUSDT', 'BUSDUSDT',
  'DAIUSDT', 'AEURUSDT', 'USDPUSDT', 'WBTCUSDT', 'WBETHUSDT',
]);

let cachedTop100 = [];
// Every liquid USDT pair (not just the top 100 by 24h change). Bots, GTT rules, orders and
// positions must be priced for any tradable symbol, e.g. BTCUSDT even when it is not a top mover.
let cachedIndex = new Map();
let lastFetchTime = 0;
let inflight = null; // dedupes concurrent fetches
export const feedStatus = { stale: false, lastError: null, lastSuccess: 0 };

// ============================================================================
// Binance WebSocket Real-Time Price Feed
// Replaces REST polling with live WebSocket ticker updates for sub-second pricing.
// ============================================================================

const WS_HOSTS = [
  'wss://stream.binance.com:9443',
  'wss://stream.binance.com:9443/ws',
];

let ws = null;
let wsReconnectTimer = null;
let wsConnecting = false;
let wsSubscriptions = new Set(); // individual symbol subscriptions
let wsIndex = new Map(); // symbol -> live coin (WebSocket-updated)
let wsLastUpdate = 0; // timestamp of last WebSocket message
let wsReconnectDelay = 1000;

/** Build a live-coin object from a Binance 24hr ticker payload. */
function coinFromTicker(t) {
  const symbol = String(t.s || t.symbol || '').toUpperCase();
  const price = Number(t.c ?? t.lastPrice ?? 0);
  return {
    symbol,
    base: symbol.replace('USDT', ''),
    quote: 'USDT',
    name: symbol.replace('USDT', ''),
    price,
    change24h: Number((t.P ?? t.priceChangePercent ?? 0)),
    high24h: Number(t.h ?? t.highPrice ?? price),
    low24h: Number(t.l ?? t.lowPrice ?? price),
    volume: Number(t.v ?? t.volume ?? 0),
    quoteVolume: Number(t.q ?? t.quoteVolume ?? 0),
    tradesCount: Number(t.n ?? t.count ?? 0),
    bidPrice: Number(t.b ?? t.bidPrice ?? price),
    askPrice: Number(t.a ?? t.askPrice ?? price),
    weightedAvgPrice: Number(t.w ?? t.weightedAvgPrice ?? price),
    lastUpdate: t.E ?? t.eventTime ?? Date.now(),
    precision: getPrecision(price),
    tickSize: price >= 1000 ? 0.1 : price >= 10 ? 0.01 : 0.0001,
  };
}

/** Merge a single ticker into the WebSocket index. */
function mergeTicker(t) {
  const coin = coinFromTicker(t);
  const symbol = coin.symbol;
  const prev = wsIndex.get(symbol);
  wsIndex.set(symbol, prev ? { ...prev, ...coin, lastUpdate: Date.now() } : coin);
  wsLastUpdate = Date.now();
  feedStatus.stale = false;
  feedStatus.lastSuccess = wsLastUpdate;
}

/** Process an incoming WebSocket message. */
function onWsMessage(data) {
  try {
    const msg = JSON.parse(data);
    if (Array.isArray(msg)) {
      // Combined !ticker@arr stream: array of tickers
      for (const t of msg) mergeTicker(t);
    } else if (msg && msg.s) {
      // Individual symbol ticker stream
      mergeTicker(msg);
    } else if (msg && msg.result === null && msg.id) {
      // Subscription confirmation
      if (msg.params && msg.params.symbol) wsSubscriptions.add(msg.params.symbol.toUpperCase());
    }
  } catch (err) {
    console.error('[WS] message parse error:', err.message);
  }
}

/** Open the Binance WebSocket connection. */
function connectWebSocket() {
  if (wsConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  wsConnecting = true;
  try {
    const url = `${WS_HOSTS[0]}/ws/!ticker@arr`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      wsConnecting = false;
      wsReconnectDelay = 1000;
      console.log('[WS] Binance WebSocket connected (combined ticker)');
      // Subscribe to individual streams for symbols with active bots
      resubscribeActiveSymbols();
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf-8');
      onWsMessage(data);
    };
    ws.onerror = (err) => {
      console.error('[WS] Binance WebSocket error:', err.message);
    };
    ws.onclose = () => {
      wsConnecting = false;
      ws = null;
      feedStatus.stale = true;
      console.log('[WS] Binance WebSocket closed, reconnecting...');
      scheduleReconnect();
    };
  } catch (err) {
    wsConnecting = false;
    console.error('[WS] Failed to connect:', err.message);
    scheduleReconnect();
  }
}

/** Schedule a WebSocket reconnection with exponential backoff. */
function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    connectWebSocket();
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
  }, wsReconnectDelay);
}

/** Subscribe to individual ticker streams for symbols that have active bots. */
export function subscribeSymbol(symbol) {
  const s = String(symbol).toUpperCase();
  if (!s.endsWith('USDT')) return;
  wsSubscriptions.add(s);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${s.toLowerCase()}@ticker`], id: Date.now() }));
  }
}

/** Unsubscribe from an individual ticker stream. */
export function unsubscribeSymbol(symbol) {
  const s = String(symbol).toUpperCase();
  wsSubscriptions.delete(s);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [`${s.toLowerCase()}@ticker`], id: Date.now() }));
  }
}

/** Re-subscribe to all active bot symbols after reconnect. */
export function resubscribeActiveSymbols() {
  for (const s of wsSubscriptions) {
    ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${s.toLowerCase()}@ticker`], id: Date.now() }));
  }
}

/** Start the WebSocket feed (call once at server boot). */
export function startPriceFeed() {
  connectWebSocket();
  // Heartbeat: if no WS message for 15s, mark stale and force reconnect
  setInterval(() => {
    if (wsLastUpdate > 0 && Date.now() - wsLastUpdate > 15000) {
      feedStatus.stale = true;
      console.warn('[WS] No ticker update for 15s, marking feed stale');
      if (ws) { ws.close(); ws = null; scheduleReconnect(); }
    }
  }, 5000);
}

/** Get live price index from WebSocket (primary) with REST fallback. */
export async function getLivePriceIndex() {
  // Prefer WebSocket index if it has data and is fresh
  if (wsIndex.size > 0 && Date.now() - wsLastUpdate < 10000) {
    return wsIndex;
  }
  // Fallback: REST poll (existing behavior)
  await getLiveTop100MomentumCoins();
  return cachedIndex;
}

/** Is the WebSocket feed stale (no recent updates)? */
export function isFeedStale() {
  // No WS data yet: fall back to REST-based staleness
  if (wsIndex.size === 0) return feedStatus.stale && Date.now() - feedStatus.lastSuccess > 15000;
  return Date.now() - wsLastUpdate > 10000;
}

/** Get a single live coin from the WebSocket index. */
export async function getLiveCoin(symbol) {
  const s = String(symbol).toUpperCase();
  // Prefer WebSocket
  if (wsIndex.has(s)) return wsIndex.get(s);
  // Fallback to REST
  return (await getLivePriceIndex()).get(s);
}

// Binance global API endpoints; Render IPs are sometimes blocked on api.binance.com (HTTP 451).
// Fall back through the mirror hostnames so live data keeps working.
const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];
const FETCH_TIMEOUT_MS = 10000;

async function fetchBinance(urlPath, init = {}) {
  let lastErr;
  for (const base of BINANCE_HOSTS) {
    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`${base}${urlPath}`, { signal: controller.signal, ...init });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`Binance HTTP ${res.status}: ${res.statusText}`);
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
    }
  }
  throw lastErr;
}

// Legacy Binance leveraged tokens (BTCUP, ETHDOWN, ...). Matching a bare "UP" suffix
// would wrongly drop real coins such as JUP, so the base must be a known major.
export const LEVERAGED_RE = /^(BTC|ETH|BNB|ADA|XRP|LINK|DOT|LTC|EOS|TRX|XLM|BCH|SXP|FIL|AAVE|SUSHI|UNI|1INCH|YFI)(UP|DOWN|BULL|BEAR)USDT$/;
const CACHE_TTL_MS = 3000; // 3 seconds refresh

/**
 * Determine decimal precision based on price magnitude
 */
export function getPrecision(price) {
  if (price >= 1000) return 2;
  if (price >= 1) return 2;
  if (price >= 0.01) return 4;
  if (price >= 0.0001) return 6;
  return 8;
}

/**
 * Fetch and compute Top 100 Momentum Coins from Binance
 */
export async function getLiveTop100MomentumCoins() {
  const now = Date.now();
  if (cachedTop100.length > 0 && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedTop100;
  }
  if (inflight) return inflight;
  inflight = fetchTop100(now).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Snapshot of the cached top-100 list (empty until the first successful fetch). */
export function getCachedTop100() {
  return cachedTop100;
}

/** Merge a websocket ticker update into the caches. */
export function applyTickerUpdate(symbol, update) {
  const merge = (c) => ({ ...c, ...update, lastUpdate: Date.now() });
  const i = cachedTop100.findIndex((c) => c.symbol === symbol);
  if (i >= 0) cachedTop100[i] = merge(cachedTop100[i]);
  const c = cachedIndex.get(symbol);
  if (c) cachedIndex.set(symbol, merge(c));
}

async function fetchTop100(now) {
  try {
    const res = await fetchBinance('/api/v3/ticker/24hr');

    const allTickers = await res.json();

    // Filter valid liquid USDT pairs
    const usdtPairs = allTickers.filter((t) => {
      const sym = t.symbol;
      if (!sym.endsWith('USDT')) return false;
      if (STABLE_PAIRS.has(sym)) return false;
      if (LEVERAGED_RE.test(sym)) return false;
      const quoteVol = parseFloat(t.quoteVolume);
      const price = parseFloat(t.lastPrice);
      // Require at least $1M 24h turnover and price > 0 to filter out dead illiquid pairs
      return quoteVol >= 1000000 && price > 0;
    });

    // Score momentum: combine magnitude of 24h % move with trading volume
    // High positive momentum is prioritized, but high-volatility momentum movers are ranked
    const scored = usdtPairs.map((t) => {
      const change24h = parseFloat(t.priceChangePercent);
      const quoteVol = parseFloat(t.quoteVolume);
      const price = parseFloat(t.lastPrice);
      const high = parseFloat(t.highPrice);
      const low = parseFloat(t.lowPrice);
      const base = t.symbol.replace('USDT', '');

      // Range position: 0 to 1 where current price sits in 24h range
      const rangeSpan = high - low;
      const rangePosition = rangeSpan > 0 ? (price - low) / rangeSpan : 0.5;

      // Momentum Score: weighted by 24h % change and liquidity
      const momentumScore = change24h * Math.log10(quoteVol);

      return {
        symbol: t.symbol,
        base,
        quote: 'USDT',
        name: base,
        price,
        change24h: Number(change24h.toFixed(2)),
        high24h: high,
        low24h: low,
        volume: parseFloat(t.volume),
        quoteVolume: quoteVol,
        volume24h: quoteVol >= 1e9 
          ? `${(quoteVol / 1e9).toFixed(2)}B` 
          : `${(quoteVol / 1e6).toFixed(1)}M`,
        tradesCount: t.count,
        bidPrice: parseFloat(t.bidPrice),
        askPrice: parseFloat(t.askPrice),
        weightedAvgPrice: parseFloat(t.weightedAvgPrice),
        rangePosition: Number((rangePosition * 100).toFixed(1)),
        momentumScore,
        precision: getPrecision(price),
        tickSize: price >= 1000 ? 0.1 : price >= 10 ? 0.01 : 0.0001,
      };
    });

    // Sort by momentum score (highest momentum gainers / strongest market movers first)
    scored.sort((a, b) => b.change24h - a.change24h); // ranked by 24h % change; momentumScore is exposed for clients

    // Take top 100 and assign rank
    const top100 = scored.slice(0, 100).map((coin, index) => ({
      ...coin,
      momentumRank: index + 1,
    }));

    cachedTop100 = top100;
    cachedIndex = new Map(scored.map((c) => [c.symbol, c]));
    lastFetchTime = now;
    feedStatus.stale = false;
    feedStatus.lastError = null;
    feedStatus.lastSuccess = now;
    return top100;
  } catch (err) {
    console.error('Binance Live Data Fetch Error:', err.message);
    feedStatus.stale = true;
    feedStatus.lastError = err.message;
    if (cachedTop100.length > 0) return cachedTop100;
    // Binance fully blocked (e.g. HTTP 451 from Render IPs): fall back to OKX tickers in production only.
    if (process.env.NODE_ENV === 'production') {
      try {
        const okxCoins = await okxTop100();
        cachedTop100 = okxCoins;
        cachedIndex = new Map(okxCoins.map((c) => [c.symbol, c]));
        lastFetchTime = now;
        feedStatus.stale = false;
        feedStatus.lastError = null;
        feedStatus.lastSuccess = now;
        return cachedTop100;
      } catch (okxErr) {
        console.error('OKX Live Data Fetch Error:', okxErr.message);
      }
    }
    return cachedTop100; // empty list rather than undefined so callers never crash
  }
}

/**
 * Fetch live order book depth from Binance for any symbol
 */
export async function getLiveOrderBookDepth(symbol = 'BTCUSDT', limit = 15) {
  try {
    const formattedSym = symbol.toUpperCase().replace('/', '');
    if (!/^[A-Z0-9]{5,12}$/.test(formattedSym)) {
      throw new Error(`Invalid symbol: ${symbol}`);
    }
    const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 5000);
    const res = await fetchBinance(`/api/v3/depth?symbol=${encodeURIComponent(formattedSym)}&limit=${cleanLimit}`);
    if (!res.ok) {
      throw new Error(`Binance depth error: ${res.statusText}`);
    }

    const data = await res.json();

    let cumBid = 0;
    const bids = data.bids.map(([priceStr, sizeStr]) => {
      const price = parseFloat(priceStr);
      const size = parseFloat(sizeStr);
      cumBid += size;
      return {
        price,
        size,
        total: Number(cumBid.toFixed(4)),
      };
    });

    let cumAsk = 0;
    const asks = data.asks.map(([priceStr, sizeStr]) => {
      const price = parseFloat(priceStr);
      const size = parseFloat(sizeStr);
      cumAsk += size;
      return {
        price,
        size,
        total: Number(cumAsk.toFixed(4)),
      };
    });

    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 0;
    const spread = bestAsk > bestBid ? Number((bestAsk - bestBid).toFixed(4)) : 0;
    const spreadPercent = bestBid > 0 ? Number(((spread / bestBid) * 100).toFixed(4)) : 0;

    return {
      symbol: formattedSym,
      lastUpdateId: data.lastUpdateId,
      bestBid,
      bestAsk,
      spread,
      spreadPercent,
      bids,
      asks: asks.reverse(), // Top-down asks
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error(`Failed to fetch live depth for ${symbol}:`, err.message);
    // Binance blocked (HTTP 451) or down: fall back to OKX in production only.
    if (process.env.NODE_ENV === 'production') {
      try {
        return await okxDepth(symbol, limit);
      } catch (okxErr) {
        console.error(`OKX depth fallback failed for ${symbol}:`, okxErr.message);
      }
    }
    throw err;
  }
}

/**
 * Fetch live recent trades from Binance for any symbol
 */
export async function getLiveRecentTrades(symbol = 'BTCUSDT', limit = 20) {
  try {
    const formattedSym = symbol.toUpperCase().replace('/', '');
    if (!/^[A-Z0-9]{5,12}$/.test(formattedSym)) {
      throw new Error(`Invalid symbol: ${symbol}`);
    }
    const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
    const res = await fetchBinance(`/api/v3/trades?symbol=${encodeURIComponent(formattedSym)}&limit=${cleanLimit}`);
    if (!res.ok) {
      throw new Error(`Binance trades error: ${res.statusText}`);
    }
    const data = await res.json();
    return data.map((t) => ({
      id: t.id,
      price: parseFloat(t.price),
      size: parseFloat(t.qty),
      quoteQty: parseFloat(t.quoteQty),
      time: t.time,
      isBuyerMaker: t.isBuyerMaker,
      side: t.isBuyerMaker ? 'SELL' : 'BUY',
    })).reverse();
  } catch (err) {
    console.error(`Failed to fetch live trades for ${symbol}:`, err.message);
    // Binance blocked (HTTP 451) or down: fall back to OKX in production only.
    if (process.env.NODE_ENV === 'production') {
      try {
        return await okxTrades(symbol, limit);
      } catch (okxErr) {
        console.error(`OKX trades fallback failed for ${symbol}:`, okxErr.message);
      }
    }
    throw err;
  }
}

/**
 * Fetch live historical candles (klines) from Binance for any symbol
 * Intervals supported: '15m', '30m', '1h', '2h', '4h', '1d'
 */
export async function getLiveKlines(symbol = 'BTCUSDT', interval = '1h', limit = 500) {
  try {
    const formattedSym = symbol.toUpperCase().replace('/', '');
    if (!/^[A-Z0-9]{5,12}$/.test(formattedSym)) {
      throw new Error(`Invalid symbol: ${symbol}`);
    }
    const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 10), 1000);
    const res = await fetchBinance(
      `/api/v3/klines?symbol=${encodeURIComponent(formattedSym)}&interval=${encodeURIComponent(interval)}&limit=${cleanLimit}`,
    );
    if (!res.ok) {
      throw new Error(`Binance klines error: ${res.statusText}`);
    }
    const data = await res.json();
    return data.map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
      quoteVolume: parseFloat(k[7]),
      tradesCount: k[8],
    }));
  } catch (err) {
    console.error(`Failed to fetch live klines for ${symbol}:`, err.message);
    // Binance blocked (HTTP 451) or down: fall back to OKX in production only.
    if (process.env.NODE_ENV === 'production') {
      try {
        return await okxKlines(symbol, interval, limit);
      } catch (okxErr) {
        console.error(`OKX klines fallback failed for ${symbol}:`, okxErr.message);
      }
    }
    throw err;
  }
}

// No futures funding in spot-only mode
