// OKX v5 Market Data: candles/klines and tickers fallback source
// Used when Binance hostnames are blocked (e.g. HTTP 451 from Render IPs).

import { STABLE_PAIRS, LEVERAGED_RE, getPrecision } from './binance.js';

const OKX_HOSTS = [
  'https://www.okx.com',
  'https://okx.com',
];

const FETCH_TIMEOUT_MS = 10000;

// OKX bar interval names (v5). Binance uses lowercase (1h, 4h, 1d); OKX uses uppercase (1H, 4H, 1D).
const INTERVAL_MAP = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '2h': '2H',
  '4h': '4H',
  '6h': '6H',
  '8h': '4H',    // no 8H on OKX; fall back to 4H
  '12h': '12H',
  '1d': '1D',
  '3d': '1D',    // no 3D on OKX; fall back to 1D
  '1w': '1W',
  '1M': '1M',
};

async function fetchOkx(urlPath, init = {}) {
  let lastErr;
  for (const base of OKX_HOSTS) {
    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`${base}${urlPath}`, { signal: controller.signal, ...init });
      clearTimeout(timeout);
      if (!res.ok) {
        throw new Error(`OKX HTTP ${res.status}: ${res.statusText}`);
      }
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
    }
  }
  throw lastErr;
}

function normalizeSymbol(symbol) {
  let sym = symbol.toUpperCase().replace('/', '');
  // OKX instId uses BASE-QUOTE (e.g. BTC-USDT). Binance passes BASEQUOTE (e.g. BTCUSDT).
  if (sym.endsWith('USDT') && !sym.includes('-')) {
    sym = sym.slice(0, -4) + '-USDT';
  }
  return sym;
}

export function okxBar(interval) {
  return INTERVAL_MAP[interval] || interval;
}

/**
 * OKX tickers -> same shape as Binance's getLiveTop100MomentumCoins output.
 * Filters to liquid USDT spot pairs, excluding stablecoins and leveraged tokens.
 */
export async function getLiveTop100MomentumCoins() {
  const res = await fetchOkx('/api/v5/market/tickers?instType=SPOT');
  const json = await res.json();

  if (json.code !== '0' || !Array.isArray(json.data)) {
    throw new Error(`OKX tickers error: ${json.msg || json.code}`);
  }

  const rows = json.data.filter((t) => {
    const sym = t.instId;
    if (!sym.endsWith('-USDT')) return false;
    const base = sym.replace('-USDT', '');
    const usdtSym = `${base}USDT`;
    if (STABLE_PAIRS.has(usdtSym)) return false;
    if (LEVERAGED_RE.test(usdtSym)) return false;
    const quoteVol = parseFloat(t.volCcy24h || '0');
    const price = parseFloat(t.last);
    return quoteVol >= 1000000 && price > 0;
  });

  const scored = rows.map((t) => {
    const sym = t.instId;
    const base = sym.replace('-USDT', '');
    const price = parseFloat(t.last);
    const change24h = parseFloat(t.last) - parseFloat(t.open24h || price);
    const change24hPct = price > 0 ? (change24h / price) * 100 : 0;
    const quoteVol = parseFloat(t.volCcy24h || '0');
    const high = parseFloat(t.high24h || price);
    const low = parseFloat(t.low24h || price);

    const rangeSpan = high - low;
    const rangePosition = rangeSpan > 0 ? (price - low) / rangeSpan : 0.5;
    const momentumScore = change24hPct * Math.log10(quoteVol);

    return {
      symbol: `${base}USDT`,
      base,
      quote: 'USDT',
      name: base,
      price,
      change24h: Number(change24hPct.toFixed(2)),
      high24h: high,
      low24h: low,
      volume: parseFloat(t.vol24h || '0'),
      quoteVolume: quoteVol,
      volume24h: quoteVol >= 1e9 ? `${(quoteVol / 1e9).toFixed(2)}B` : `${(quoteVol / 1e6).toFixed(1)}M`,
      tradesCount: undefined,
      bidPrice: parseFloat(t.bidPx || price),
      askPrice: parseFloat(t.askPx || price),
      weightedAvgPrice: price,
      rangePosition: Number((rangePosition * 100).toFixed(1)),
      momentumScore,
      precision: getPrecision(price),
      tickSize: price >= 1000 ? 0.1 : price >= 10 ? 0.01 : 0.0001,
    };
  });

  scored.sort((a, b) => b.change24h - a.change24h);

  return scored.slice(0, 100).map((coin, index) => ({ ...coin, momentumRank: index + 1 }));
}

/**
 * Fetch live historical candles (klines) from OKX v5.
 * Returns the same shape as server/binance.js getLiveKlines:
 *   [{ openTime, open, high, low, close, volume, closeTime, quoteVolume, tradesCount }]
 */
export async function getLiveKlines(symbol = 'BTC-USDT', interval = '1H', limit = 500) {
  const instId = normalizeSymbol(symbol);
  const bar = okxBar(interval);
  const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 10), 100);
  const url = `/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${encodeURIComponent(bar)}&limit=${cleanLimit}`;

  const res = await fetchOkx(url);
  const json = await res.json();

  if (json.code !== '0' || !Array.isArray(json.data)) {
    throw new Error(`OKX candles error: ${json.msg || json.code}`);
  }

  // OKX returns newest-first; reverse to oldest-first to match Binance order.
  const rows = json.data.slice().reverse();

  return rows.map((k) => ({
    openTime: Number(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: Number(k[0]),
    quoteVolume: parseFloat(k[6]),
    tradesCount: undefined,
  }));
}

/**
 * Fetch live order book depth from OKX v5.
 * Returns same shape as server/binance.js getLiveOrderBookDepth.
 */
export async function getLiveOrderBookDepth(symbol = 'BTC-USDT', limit = 15) {
  const instId = normalizeSymbol(symbol);
  const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 5000);
  const res = await fetchOkx(`/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=${cleanLimit}`);
  const json = await res.json();

  if (json.code !== '0' || !Array.isArray(json.data)) {
    throw new Error(`OKX depth error: ${json.msg || json.code}`);
  }

  const book = json.data[0];
  const cumBid = 0;
  const bids = (book.bids || []).map(([priceStr, sizeStr]) => ({
    price: parseFloat(priceStr),
    size: parseFloat(sizeStr),
    total: Number((parseFloat(sizeStr)).toFixed(4)),
  }));
  const asks = (book.asks || []).map(([priceStr, sizeStr]) => ({
    price: parseFloat(priceStr),
    size: parseFloat(sizeStr),
    total: Number((parseFloat(sizeStr)).toFixed(4)),
  }));

  const bestBid = bids[0]?.price || 0;
  const bestAsk = asks[0]?.price || 0;
  const spread = bestAsk > bestBid ? Number((bestAsk - bestBid).toFixed(4)) : 0;

  return {
    symbol: instId,
    lastUpdateId: Number(book.ts || Date.now()),
    bestBid,
    bestAsk,
    spread,
    spreadPercent: bestBid > 0 ? Number(((spread / bestBid) * 100).toFixed(4)) : 0,
    bids,
    asks: asks.slice().reverse(),
    timestamp: Date.now(),
  };
}

/**
 * Fetch live recent trades from OKX v5.
 * Returns same shape as server/binance.js getLiveRecentTrades.
 */
export async function getLiveRecentTrades(symbol = 'BTC-USDT', limit = 20) {
  const instId = normalizeSymbol(symbol);
  const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 100);
  const res = await fetchOkx(`/api/v5/market/trades?instId=${encodeURIComponent(instId)}&limit=${cleanLimit}`);
  const json = await res.json();

  if (json.code !== '0' || !Array.isArray(json.data)) {
    throw new Error(`OKX trades error: ${json.msg || json.code}`);
  }

  return json.data.map((t) => ({
    id: t.tradeId || t.side,
    price: parseFloat(t.px),
    size: parseFloat(t.sz),
    quoteQty: parseFloat(t.px) * parseFloat(t.sz),
    time: Number(t.ts),
    isBuyerMaker: t.side === 'sell',
    side: t.side === 'buy' ? 'BUY' : 'SELL',
  })).reverse();
}
