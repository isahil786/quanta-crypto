// Live Binance Market Data Engine
// Pulls live 24hr tickers, live orderbook depth, and live trades for Top 100 Momentum Coins

const STABLE_PAIRS = new Set([
  'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'EURUSDT', 'BUSDUSDT',
  'DAIUSDT', 'AEURUSDT', 'USDPUSDT', 'WBTCUSDT', 'WBETHUSDT',
]);

let cachedTop100 = [];
let lastFetchTime = 0;
const CACHE_TTL_MS = 3000; // 3 seconds refresh

/**
 * Determine decimal precision based on price magnitude
 */
function getPrecision(price) {
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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr', {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`Binance HTTP ${res.status}: ${res.statusText}`);
    }

    const allTickers = await res.json();

    // Filter valid liquid USDT pairs
    const usdtPairs = allTickers.filter((t) => {
      const sym = t.symbol;
      if (!sym.endsWith('USDT')) return false;
      if (STABLE_PAIRS.has(sym)) return false;
      if (sym.includes('UPUSDT') || sym.includes('DOWNUSDT') || sym.includes('BULL') || sym.includes('BEAR')) {
        return false;
      }
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
    scored.sort((a, b) => b.change24h - a.change24h);

    // Take top 100 and assign rank
    const top100 = scored.slice(0, 100).map((coin, index) => ({
      ...coin,
      momentumRank: index + 1,
    }));

    cachedTop100 = top100;
    lastFetchTime = now;
    return top100;
  } catch (err) {
    console.error('Binance Live Data Fetch Error:', err.message);
    if (cachedTop100.length > 0) return cachedTop100;
    throw err;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(formattedSym)}&limit=${cleanLimit}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`https://api.binance.com/api/v3/trades?symbol=${encodeURIComponent(formattedSym)}&limit=${cleanLimit}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(formattedSym)}&interval=${encodeURIComponent(interval)}&limit=${cleanLimit}`,
      { signal: controller.signal },
    );
    clearTimeout(timeout);
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
    throw err;
  }
}
