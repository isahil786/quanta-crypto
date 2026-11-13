// Execution costs for the paper engine: maker/taker fees and size-dependent slippage.
import { BROKERS } from './brokers/index.js';

/** Fee rates in percent. Falls back to feeEstimatePercent (taker) and 80% of it (maker). */
export function feeRates(broker) {
  const c = BROKERS[broker]?.capabilities || {};
  const taker = c.takerFeePercent ?? c.feeEstimatePercent ?? 0.1;
  const maker = c.makerFeePercent ?? Number((taker * 0.8).toFixed(4));
  return { maker, taker };
}

/** Fee percent for a fill: resting limit fills are MAKER, everything that takes liquidity is TAKER. */
export const feePct = (broker, liquidity = 'TAKER') => feeRates(broker)[liquidity === 'MAKER' ? 'maker' : 'taker'];

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
export const slippageConfig = () => ({
  enabled: String(process.env.SLIPPAGE || 'on').toLowerCase() !== 'off',
  baseBps: num(process.env.SLIPPAGE_BASE_BPS, 1),     // half the bid/ask spread, in basis points
  impactCoef: num(process.env.SLIPPAGE_IMPACT_COEF, 0.03), // square-root impact: coef * sqrt(order / daily volume)
  maxPercent: num(process.env.SLIPPAGE_MAX_PERCENT, 5),
  unknownVolumePercent: 0.1, // extra slippage when 24h volume is unknown
});

/**
 * Slippage percent for a taker order. Square-root market-impact model:
 *   base spread + coef * sqrt(notional / 24h quote volume)
 * so doubling the order size raises impact by ~41%, and thin coins slip far more than BTC.
 */
export function slippagePercent(notionalUSDT, quoteVolume24h) {
  const cfg = slippageConfig();
  if (!cfg.enabled) return 0;
  let pct = cfg.baseBps / 100;
  if (quoteVolume24h > 0) pct += cfg.impactCoef * Math.sqrt(Math.max(notionalUSDT, 0) / quoteVolume24h) * 100;
  else pct += cfg.unknownVolumePercent;
  return Number(Math.min(pct, cfg.maxPercent).toFixed(4));
}

const sig = (x) => Number(Number(x).toPrecision(10));

/**
 * Price + fee for one fill.
 *  MAKER: resting limit order filled at its own price, maker fee, no slippage.
 *  TAKER: crosses the book, so the price moves against the order by the slippage, taker fee.
 */
export function executionCost({ broker, side, refPrice, size, quoteVolume, liquidity = 'TAKER' }) {
  if (liquidity === 'MAKER') return { price: refPrice, feePct: feePct(broker, 'MAKER'), slippagePct: 0, liquidity, refPrice };
  const slippagePct = slippagePercent(refPrice * size, quoteVolume);
  const move = slippagePct / 100;
  const price = sig(side === 'BUY' ? refPrice * (1 + move) : refPrice * (1 - move));
  return { price, feePct: feePct(broker, 'TAKER'), slippagePct, liquidity, refPrice };
}
