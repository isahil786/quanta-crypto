// Pure helpers for turning an exchange wallet listing into the numbers the app shows.
// Kept free of I/O so it can be unit-tested.

const STABLES = ['USDT', 'USDC', 'USD']; // USD: Delta Exchange India reports its wallet in USD

/** Normalise one raw balance row (asset upper-cased, numbers finite, total >= free). */
export function normalizeBalance(b) {
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const asset = String(b.asset ?? '').trim().toUpperCase();
  const free = n(b.free);
  const locked = n(b.locked);
  const total = Math.max(n(b.total), free + locked);
  return { asset, free, locked, total };
}

/**
 * Summarise a wallet. Returns the USDT cash figures plus human-readable notes explaining
 * why USDT may be zero (INR-only wallet, funds held in USD/USDC, nothing deposited, ...).
 */
export function summarizeBalances(rows) {
  const balances = (rows || []).map(normalizeBalance).filter((b) => b.asset);
  const byAsset = new Map(balances.map((b) => [b.asset, b]));
  const notes = [];

  let cash = byAsset.get('USDT');
  let cashAsset = 'USDT';
  if (!cash || cash.total === 0) {
    for (const alt of STABLES.slice(1)) {
      const b = byAsset.get(alt);
      if (b && b.total > 0) {
        cash = b; cashAsset = alt;
        notes.push(`No USDT in this wallet; counting ${alt} balance (${b.total}) as cash (1 ${alt} ≈ 1 USDT).`);
        break;
      }
    }
  }
  const inr = byAsset.get('INR');
  if ((!cash || cash.total === 0) && inr && inr.total > 0) {
    notes.push(`Wallet holds ${inr.total} INR but no USDT. Convert INR to USDT on the exchange to trade USDT pairs.`);
  }
  if (!balances.length) notes.push('The exchange returned an empty wallet.');
  else if (!cash || cash.total === 0) {
    const funded = balances.filter((b) => b.total > 0).map((b) => b.asset);
    if (!funded.length) notes.push('The wallet is empty: nothing is deposited on this exchange account.');
  }

  return {
    balances,
    cashAsset,
    freeUSDT: cash ? cash.free : 0,
    lockedUSDT: cash ? cash.locked : 0,
    notes,
  };
}

// ---- USDT/INR rate (for showing INR wallets in USDT terms; display only, never used to place orders) ----
let inrCache = { rate: 0, ts: 0 };
const INR_TTL_MS = 5 * 60_000;

/** INR per 1 USDT. Env USDT_INR_RATE overrides; otherwise CoinDCX's public ticker. Returns 0 if unknown. */
export async function getUsdtInrRate() {
  const fixed = Number(process.env.USDT_INR_RATE);
  if (Number.isFinite(fixed) && fixed > 0) return fixed;
  if (inrCache.rate && Date.now() - inrCache.ts < INR_TTL_MS) return inrCache.rate;
  try {
    const res = await fetch('https://api.coindcx.com/exchange/ticker', { signal: AbortSignal.timeout(5000) });
    const list = await res.json();
    const row = Array.isArray(list) ? list.find((t) => t.market === 'USDTINR') : null;
    const rate = Number(row?.last_price);
    if (Number.isFinite(rate) && rate > 0) inrCache = { rate, ts: Date.now() };
  } catch { /* keep the previous rate, if any */ }
  return inrCache.rate || 0;
}
