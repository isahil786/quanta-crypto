// OKX v5 Market Data: candles/klines fallback source
// Used when Binance hostnames are blocked (e.g. HTTP 451 from Render IPs).

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
  const sym = symbol.toUpperCase().replace('/', '-');
  // OKX instId uses BASE-QUOTE (e.g. BTC-USDT)
  return sym;
}

export function okxBar(interval) {
  return INTERVAL_MAP[interval] || interval;
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
