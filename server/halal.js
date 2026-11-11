// Halal coin screening list (source: server/data/halal_coins.json, scraped from coinranking.com/coins/halal).
// This is a third-party screen, not a religious ruling: verify with a scholar you trust before trading.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'halal_coins.json');

// Tickers that were renamed on Binance after the list was compiled
const RENAMED = { MATIC: 'POL', KLAY: 'KAIA' };
// Pegged assets are listed as halal but are not meaningful grid/breakout targets
const NOT_TRADABLE = new Set(['USDT', 'USDC', 'DAI', 'BUSD']);

function load() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error(`[halal] could not load ${FILE}: ${err.message}`);
    return { meta: { source: null, fetchedAt: null, total: 0 }, coins: [] };
  }
  const seen = new Set();
  const coins = [];
  for (const c of raw.coins || []) {
    const base = String(c.symbol || '').trim().toUpperCase();
    if (!base || seen.has(base) || NOT_TRADABLE.has(base)) continue; // the list repeats e.g. TIME
    seen.add(base);
    const tradeBase = RENAMED[base] || base;
    coins.push({ base, name: c.name, marketCap: c.marketCap, url: c.url, symbol: `${tradeBase}USDT` });
  }
  return { meta: { source: raw.source, fetchedAt: raw.fetchedAt, total: raw.total ?? coins.length }, coins };
}

const { meta, coins: HALAL_COINS } = load();
const HALAL_SYMBOLS = new Set(HALAL_COINS.map((c) => c.symbol));

export const isHalalSymbol = (symbol) => HALAL_SYMBOLS.has(String(symbol || '').toUpperCase());
export const getHalalCoins = () => HALAL_COINS;

/**
 * Join the halal list with the live price index.
 * tradable: halal coins with a live USDT pair (sorted by quote volume); unavailable: listed but no live pair.
 */
export function halalMarket(index) {
  const tradable = [];
  const unavailable = [];
  for (const h of HALAL_COINS) {
    const live = index.get(h.symbol);
    if (live) tradable.push({ ...live, halal: true, name: h.name || live.name, marketCap: h.marketCap });
    else unavailable.push({ symbol: h.symbol, name: h.name });
  }
  tradable.sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0));
  tradable.forEach((c, i) => { c.halalRank = i + 1; });
  return { ...meta, listed: HALAL_COINS.length, tradable, unavailable };
}
