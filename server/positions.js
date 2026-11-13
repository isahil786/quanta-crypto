// Position, margin and fill accounting for the paper-trading engine.
import { positions, trades, holdings, orders } from './state.js';
import { fundingBoundary } from './funding.js';
import { uid, capList } from './util.js';

const MAX_TRADES = 10000;
const EPS = 1e-9;

export function opensPosition(account, order) {
  return account.segment === 'FUTURES' || Number(order.leverage) > 1;
}

const baseAsset = (symbol) => symbol.replace(/USDT$/, '');

function findHolding(account, asset) {
  return holdings.find((h) => h.accountId === account.id && h.asset === asset);
}

function ensureHolding(account, asset) {
  let h = findHolding(account, asset);
  if (!h) {
    h = { accountId: account.id, broker: account.broker, asset, name: asset, free: 0, locked: 0, total: 0, rateUSDT: 0, valueUSDT: 0, avgCost: 0 };
    holdings.push(h);
  }
  return h;
}

/** Keep the account's USDT wallet row in step with its margin/cash numbers. */
export function syncUsdtHolding(account) {
  const h = ensureHolding(account, 'USDT');
  const futures = account.segment === 'FUTURES';
  h.free = Number(account.availableMarginUSDT.toFixed(6));
  h.total = futures ? Number(account.totalEquityUSDT.toFixed(6)) : Number((h.free + reservedUSDT(account)).toFixed(6));
  h.locked = Number(Math.max(h.total - h.free, 0).toFixed(6));
  h.rateUSDT = 1;
  h.valueUSDT = h.total;
}

// ---- Margin reservation for resting (unfilled) limit orders -------------------------------------
// A resting order locks what it would need on fill so the same funds cannot back several orders:
// USDT (or margin) moves out of availableMarginUSDT onto the order; a spot SELL locks base coins.

/** USDT currently reserved by this account's open orders. */
export function reservedUSDT(account) {
  let sum = 0;
  for (const o of orders) if (o.accountId === account.id && o.status === 'OPEN') sum += o.reservedUSDT || 0;
  return sum;
}

/** Base coins locked by this account's open spot SELL orders. */
export function lockedBase(account, asset) {
  let sum = 0;
  for (const o of orders) if (o.accountId === account.id && o.status === 'OPEN' && o.reservedBase && baseAsset(o.symbol) === asset) sum += o.reservedBase;
  return sum;
}

function syncBaseHolding(account, asset) {
  const h = findHolding(account, asset);
  if (!h) return;
  h.locked = Number(lockedBase(account, asset).toFixed(10));
  h.free = Number(Math.max(h.total - h.locked, 0).toFixed(10));
}

/** What an order must lock while it rests: { usdt, base }. */
export function reservationFor(account, order, price, feePercent) {
  const fee = (price * order.size * feePercent) / 100;
  if (!opensPosition(account, order)) {
    return order.side === 'BUY' ? { usdt: price * order.size + fee, base: 0 } : { usdt: 0, base: order.size };
  }
  const lev = Math.max(Number(order.leverage) || 1, 1);
  const wantSide = order.side === 'BUY' ? 'LONG' : 'SHORT';
  const pos = positions.find((p) => p.accountId === account.id && p.symbol === order.symbol);
  const reducing = pos && pos.side !== wantSide;
  const newExposure = reducing ? Math.max(order.size - pos.size, 0) : order.size;
  return { usdt: (newExposure * price) / lev + fee, base: 0 };
}

/** Lock explicit amounts on an order (used to restore a reservation after a failed edit). */
export function reserveAmounts(account, order, usdt, base) {
  order.reservedUSDT = Number(usdt.toFixed(6));
  order.reservedBase = Number(base.toFixed(10));
  account.availableMarginUSDT = Number((account.availableMarginUSDT - order.reservedUSDT).toFixed(6));
  syncUsdtHolding(account);
  syncBaseHolding(account, baseAsset(order.symbol));
}

/** Reserve funds for a resting order. Call checkMargin first; this assumes the funds exist. */
export function reserveOrder(account, order, price, feePercent) {
  const r = reservationFor(account, order, price, feePercent);
  reserveAmounts(account, order, r.usdt, r.base);
}

/** Give an order's reserved funds back (cancel, edit, reject or just before it fills). */
export function releaseOrder(account, order) {
  const usdt = order.reservedUSDT || 0;
  const base = order.reservedBase || 0;
  order.reservedUSDT = 0;
  order.reservedBase = 0;
  if (usdt) account.availableMarginUSDT = Number((account.availableMarginUSDT + usdt).toFixed(6));
  syncUsdtHolding(account);
  syncBaseHolding(account, baseAsset(order.symbol));
  return { usdt, base };
}

/** Base-asset inventory an account can actually sell: spot balance, or net LONG size on futures. */
export function baseInventory(account, symbol) {
  if (account.segment === 'FUTURES') {
    const pos = positions.find((p) => p.accountId === account.id && p.symbol === symbol);
    return pos && pos.side === 'LONG' ? pos.size : 0;
  }
  return findHolding(account, baseAsset(symbol))?.total || 0;
}

/**
 * Funds check. Futures/leveraged orders need margin for any new exposure;
 * spot BUYs need USDT, spot SELLs need the base asset.
 */
export function checkMargin(account, order, price, feePercent = 0.1) {
  const fee = (price * order.size * feePercent) / 100;
  if (!opensPosition(account, order)) {
    if (order.side === 'BUY') {
      const need = price * order.size + fee;
      return need <= account.availableMarginUSDT + EPS
        ? { ok: true, required: 0 }
        : { ok: false, required: Number(need.toFixed(2)), reason: `Insufficient USDT: need ${need.toFixed(2)}, available ${account.availableMarginUSDT.toFixed(2)}` };
    }
    const asset = baseAsset(order.symbol);
    const have = (findHolding(account, asset)?.total || 0) - lockedBase(account, asset); // coins locked by other resting SELLs are not available
    return have + EPS >= order.size
      ? { ok: true, required: 0 }
      : { ok: false, required: order.size, reason: `Insufficient ${baseAsset(order.symbol)}: need ${order.size}, have ${have}` };
  }
  const lev = Math.max(Number(order.leverage) || 1, 1);
  const wantSide = order.side === 'BUY' ? 'LONG' : 'SHORT';
  const pos = positions.find((p) => p.accountId === account.id && p.symbol === order.symbol);
  const reducing = pos && pos.side !== wantSide;
  const newExposure = reducing ? Math.max(order.size - pos.size, 0) : order.size;
  const required = (newExposure * price) / lev + fee;
  return required <= account.availableMarginUSDT + EPS
    ? { ok: true, required: Number(required.toFixed(2)) }
    : { ok: false, required: Number(required.toFixed(2)), reason: `Insufficient margin: need ${required.toFixed(2)} USDT, available ${account.availableMarginUSDT.toFixed(2)} USDT` };
}

function liquidationPrice(side, entry, leverage) {
  // Simplified isolated-margin estimate; ignores maintenance margin and funding.
  return Number((side === 'LONG' ? entry * (1 - 0.9 / leverage) : entry * (1 + 0.9 / leverage)).toFixed(8));
}

/**
 * Apply a fill to the account's net position for the symbol.
 * Same side -> grows/averages. Opposite side -> reduces, closes, or flips.
 * Returns realised PnL.
 */
export function applyToPosition(account, { symbol, side, size, price, leverage = 1, tpPrice, slPrice }) {
  const lev = Math.max(Number(leverage) || 1, 1);
  const wantSide = side === 'BUY' ? 'LONG' : 'SHORT';
  let pos = positions.find((p) => p.accountId === account.id && p.symbol === symbol);
  let realized = 0;
  let remaining = size;

  if (pos && pos.side !== wantSide) {
    const closeSize = Math.min(remaining, pos.size);
    const pnl = (pos.side === 'LONG' ? price - pos.entryPrice : pos.entryPrice - price) * closeSize;
    const releasedMargin = pos.margin * (closeSize / pos.size);
    realized += pnl;
    account.availableMarginUSDT += releasedMargin + pnl;
    account.totalEquityUSDT += pnl;
    pos.size = Number((pos.size - closeSize).toFixed(10));
    pos.margin = Number((pos.margin - releasedMargin).toFixed(8));
    remaining = Number((remaining - closeSize).toFixed(10));
    if (pos.size <= EPS) {
      positions.splice(positions.indexOf(pos), 1);
      pos = null;
    }
  }

  if (remaining > EPS) {
    const addMargin = (remaining * price) / lev;
    account.availableMarginUSDT -= addMargin;
    if (pos) {
      const total = pos.size + remaining;
      pos.entryPrice = (pos.entryPrice * pos.size + price * remaining) / total;
      pos.size = Number(total.toFixed(10));
      pos.margin = Number((pos.margin + addMargin).toFixed(8));
      pos.leverage = lev;
      pos.liquidationPrice = liquidationPrice(pos.side, pos.entryPrice, lev);
      if (tpPrice) pos.tpPrice = tpPrice;
      if (slPrice) pos.slPrice = slPrice;
    } else {
      positions.push({
        id: uid('pos'),
        accountId: account.id,
        broker: account.broker,
        symbol,
        side: wantSide,
        size: Number(remaining.toFixed(10)),
        entryPrice: price,
        markPrice: price,
        liquidationPrice: liquidationPrice(wantSide, price, lev),
        margin: Number(addMargin.toFixed(8)),
        leverage: lev,
        unrealizedPnl: 0,
        pnlPercent: 0,
        fundingSettledAt: fundingBoundary(Date.now()), // only positions held through a boundary pay funding
        fundingPaidUSDT: 0,
        tpPrice,
        slPrice,
      });
    }
  }
  return realized;
}

/** Spot fill: moves USDT and the base-asset holding (average-cost accounting). Returns realised PnL. */
function applySpotFill(account, order, price) {
  const asset = baseAsset(order.symbol);
  const value = price * order.size;
  const h = ensureHolding(account, asset);
  let pnl = 0;
  if (order.side === 'BUY') {
    account.availableMarginUSDT -= value;
    h.avgCost = (h.avgCost * h.total + value) / (h.total + order.size);
    h.total = Number((h.total + order.size).toFixed(10));
  } else {
    pnl = (price - h.avgCost) * order.size;
    account.availableMarginUSDT += value;
    account.totalEquityUSDT += pnl;
    h.total = Number((h.total - order.size).toFixed(10));
  }
  h.locked = Number(lockedBase(account, asset).toFixed(10));
  h.free = Number(Math.max(h.total - h.locked, 0).toFixed(10));
  h.rateUSDT = price;
  h.valueUSDT = Number((h.total * price).toFixed(2));
  if (h.total <= EPS) holdings.splice(holdings.indexOf(h), 1);
  return pnl;
}

/**
 * Settle a fill for an order: marks it FILLED, writes the trade, charges the fee and
 * updates position/margin state (futures or leveraged orders only; spot balances are not tracked).
 */
export function settleOrderFill(account, order, fillPrice, feeRatePercent, meta = {}) {
  const value = fillPrice * order.size;
  const fee = Number(((value * feeRatePercent) / 100).toFixed(4));
  order.status = 'FILLED';
  order.filledSize = order.size;
  order.fillPrice = fillPrice;
  order.fee = fee;
  order.liquidity = meta.liquidity || order.liquidity || 'TAKER';
  order.slippagePct = meta.slippagePct ?? 0;
  if (meta.refPrice !== undefined) order.refPrice = meta.refPrice;
  order.filledAt = new Date().toISOString();

  account.availableMarginUSDT -= fee;
  account.totalEquityUSDT -= fee;

  let realizedPnl;
  if (opensPosition(account, order)) {
    realizedPnl = applyToPosition(account, { ...order, price: fillPrice });
  } else {
    realizedPnl = applySpotFill(account, order, fillPrice);
  }
  account.availableMarginUSDT = Number(account.availableMarginUSDT.toFixed(6));
  account.totalEquityUSDT = Number(account.totalEquityUSDT.toFixed(6));
  syncUsdtHolding(account);

  const trade = {
    id: uid('trd'),
    orderId: order.id,
    accountId: account.id,
    broker: account.broker,
    symbol: order.symbol,
    side: order.side,
    price: fillPrice,
    size: order.size,
    value,
    fee,
    liquidity: order.liquidity,
    slippagePct: order.slippagePct,
    refPrice: order.refPrice,
    realizedPnl: Number(realizedPnl.toFixed(4)),
    timestamp: new Date().toISOString(),
  };
  trades.unshift(trade);
  capList(trades, MAX_TRADES);
  return trade;
}
