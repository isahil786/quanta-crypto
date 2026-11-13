// Institutional Algorithmic Execution Engine
// Advanced Volatility Grid, TWAP Micro-Slicer, and Momentum Breakout Radar
// Synchronized with live Binance Public API v3 market data

import { getLivePriceIndex, isFeedStale, subscribeSymbol } from './binance.js';
import { feePct as feeFor, executionCost } from './costs.js';
import { orders, trades, gttRules, accounts, positions } from './state.js';
import { BROKERS } from './brokers/index.js';
import { checkMargin, settleOrderFill, baseInventory, releaseOrder } from './positions.js';
import { shouldMirror, mirrorFilledOrder } from './mirror.js';
import { uid, capList } from './util.js';

export const botsState = {
  bots: [],
};

/**
 * Mathematical Helper: Compute optimal institutional grid parameters
 * Balances volatility capture, fee friction, and range coverage
 */
export function calculateOptimalGridParams(price, high24h, low24h, precision = 2) {
  const current = Number(price);
  const high = Number(high24h) || current * 1.05;
  const low = Number(low24h) || current * 0.95;

  // Add 1.5% volatility buffer beyond 24h extremes
  const lowerBound = Number((low * 0.985).toFixed(precision));
  const upperBound = Number((high * 1.015).toFixed(precision));

  // Range span in percentage
  const totalRangePercent = ((upperBound - lowerBound) / lowerBound) * 100;

  // Target net profit per grid after 0.1% taker fees (0.2% round-trip): optimal is ~0.75% to 1.25%
  const targetSpreadPercent = 0.0085; // 0.85% per rung
  const geometricRatio = 1 + targetSpreadPercent;
  
  let suggestedGrids = Math.round(Math.log(upperBound / lowerBound) / Math.log(geometricRatio));
  suggestedGrids = Math.max(4, Math.min(suggestedGrids, 25)); // Clamp between 4 and 25 rungs

  const arithmeticStep = Number(((upperBound - lowerBound) / suggestedGrids).toFixed(precision));
  const avgProfitPercent = Number((((arithmeticStep / current) - 0.002) * 100).toFixed(2));

  return {
    symbolPrice: current,
    lowerBound,
    upperBound,
    suggestedGrids,
    arithmeticStep,
    avgProfitPercent: Math.max(avgProfitPercent, 0.4),
    recommendedMode: totalRangePercent > 12 ? 'GEOMETRIC' : 'ARITHMETIC',
    recommendedSize: current > 1000 ? 0.01 : current > 50 ? 0.5 : 10,
  };
}

// Significant-digit rounding: toFixed(2) collapses rungs for coins priced near 1 (e.g. 1.20-1.24)
const rp = (x) => Number(Number(x).toPrecision(10));

/**
 * Grid ladder: `gridCount` intervals between `gridCount + 1` price lines, ONE resting order per interval
 * (like exchange grid bots). Interval [L, U]:
 *   U <= price  -> BUY at L, sell target U
 *   L >= price  -> SELL at U, buy-back target L   (backed by seeded inventory)
 *   L < price < U (interval holding the market) -> BUY at L, sell target U (no inventory needed)
 * One order per interval means no double exposure at the market price.
 */
export function generateGridRungs({
  lowerPrice,
  upperPrice,
  gridCount,
  currentPrice,
  sizePerGrid,
  gridMode = 'ARITHMETIC',
}) {
  const count = Number(gridCount);
  const lower = Number(lowerPrice);
  const upper = Number(upperPrice);
  const size = Number(sizePerGrid);
  const price = Number(currentPrice);
  const ratio = Math.pow(upper / lower, 1 / count);
  const step = (upper - lower) / count;
  const line = (i) => rp(gridMode === 'GEOMETRIC' ? lower * Math.pow(ratio, i) : lower + i * step);

  const rungs = [];
  for (let i = 0; i < count; i++) {
    const lo = line(i);
    const hi = line(i + 1);
    const isSell = lo >= price && hi > price;
    rungs.push({
      id: `rung-${i}`,
      index: i,
      price: isSell ? hi : lo,
      side: isSell ? 'SELL' : 'BUY',
      targetPrice: isSell ? lo : hi,
      orderSize: size,
      status: 'ACTIVE',
      fillsCount: 0,
      profitCaptured: 0,
    });
  }
  return rungs;
}

/** Reject grids whose spacing cannot cover the round-trip fee (every completed round would lose money). */
export function checkGridSpacing({ lowerPrice, upperPrice, gridCount, gridMode = 'ARITHMETIC', feePercent = 0.1 }) {
  const lower = Number(lowerPrice), upper = Number(upperPrice), n = Number(gridCount);
  const spacingPct = gridMode === 'GEOMETRIC'
    ? (Math.pow(upper / lower, 1 / n) - 1) * 100
    : ((upper - lower) / n / upper) * 100; // tightest spacing is at the top of an arithmetic grid
  const roundTrip = feePercent * 2;
  if (spacingPct <= roundTrip) {
    return `Grid spacing is ${spacingPct.toFixed(3)}% per level, below the ${roundTrip.toFixed(2)}% round-trip fee, so every completed round would lose money. Use fewer grids or a wider range.`;
  }
  return null;
}

//==============================================================
// MRS Quant Square Levels (QSL) — ported from Pine Script v6
// Price levels derived from square numbers: level(n) = square(n) / 10^decimals
// square(n) = n^2, rounded up to next odd if n^2 is even
// baseNumber(n) = round(sqrt(price * 10^decimals))
// Auto-recenters when price reaches the trigger level above/below center
//==============================================================

/** Count significant decimal places (mintick-style). */
export function f_decimalPlaces(price) {
  const str = String(Number(price));
  const dot = str.indexOf('.');
  if (dot < 0) return 0;
  return str.length - dot - 1;
}

/** Natural number: round(sqrt(price * 10^decimals)). */
export function f_naturalNumber(price) {
  const decimals = f_decimalPlaces(price);
  const multiplier = Math.pow(10, decimals);
  return Math.round(Math.sqrt(price * multiplier));
}

/** Square level: n^2, bumped to next odd when n^2 is even. */
export function f_squareLevel(number) {
  let squared = number * number;
  if (squared % 2 === 0) squared += 1;
  return squared;
}

/** Price level for a given natural number: square(n) / multiplier. */
export function f_priceLevel(number, multiplier) {
  return f_squareLevel(number) / multiplier;
}

/**
 * Pick the QSL scale for a price. Level spacing is about 200/n percent (n = sqrt(price * multiplier)),
 * which depends on how many decimals the price happens to have: 0.07% on BTC (below the fee, every
 * round loses) but 40% on a 2.5 coin. Add decimals until spacing <= 2%, then use a stride (every
 * stride-th square) until spacing is at least 4x the taker fee so a completed round nets a profit.
 */
export function qslScale(price, feePercent = 0.1) {
  const p = Number(price);
  let decimals = f_decimalPlaces(p);
  while (decimals < 8 && 200 / Math.sqrt(p * Math.pow(10, decimals)) > 2) decimals++;
  const multiplier = Math.pow(10, decimals);
  const baseNumber = Math.max(1, Math.round(Math.sqrt(p * multiplier)));
  const spacingPct = 200 / baseNumber;
  const stride = Math.max(1, Math.ceil((4 * feePercent) / spacingPct));
  return { decimals, multiplier, baseNumber, stride, spacingPct: Number((spacingPct * stride).toFixed(3)) };
}

/** Generate square-level rungs around a center number (every `stride`-th square). */
export function generateSquareLevels({
  centerNumber,
  levelsEachSide,
  currentPrice,
  multiplier,
  sizePerGrid = 1,
  precision = 2,
  stride = 1,
}) {
  const rungs = [];
  const count = Math.max(1, Math.min(parseInt(levelsEachSide, 10) || 5, 20));
  const lower = Number(currentPrice);
  const size = Number(sizePerGrid);

  for (let offset = -count; offset <= count; offset++) {
    const currentNumber = Number(centerNumber) + offset * stride;
    if (currentNumber <= 0) continue;
    const price = rp(f_priceLevel(currentNumber, multiplier));
    const side = price < lower ? 'BUY' : price > lower ? 'SELL' : 'BUY';

    rungs.push({
      id: `qsl-${currentNumber}`,
      number: currentNumber,
      offset,
      price,
      side,
      orderSize: size,
      status: 'ACTIVE',
      fillsCount: 0,
      profitCaptured: 0,
      targetPrice: null,
    });
  }

  // Pair levels: buy at n -> sell at n+1; sell at n -> buy at n-1
  const byNumber = new Map(rungs.map((r) => [r.number, r]));
  for (const rung of rungs) {
    if (rung.side === 'BUY') {
      const above = byNumber.get(rung.number + stride);
      rung.targetPrice = above ? above.price : rp(f_priceLevel(rung.number + stride, multiplier));
    } else {
      const below = byNumber.get(rung.number - stride);
      rung.targetPrice = below ? below.price : rp(f_priceLevel(Math.max(rung.number - stride, 1), multiplier));
    }
  }

  return rungs;
}

const MAX_LOGS = 200;
const MAX_HISTORY = 10000;

function log(bot, text) {
  bot.logs.unshift({ time: new Date().toLocaleTimeString(), text });
  capList(bot.logs, MAX_LOGS);
}

/** Track the USDT cost of the bot's inventory so unrealised PnL uses the real average cost. */
function bookBuy(bot, price, size) {
  bot.inventoryCostUSDT = (bot.inventoryCostUSDT ?? (bot.inventoryCostBasis || price) * (bot.totalBaseHoldings || 0)) + price * size;
}
function bookSell(bot, size, holdingsBefore) {
  const cost = bot.inventoryCostUSDT ?? (bot.inventoryCostBasis || 0) * holdingsBefore;
  const avg = holdingsBefore > 0 ? cost / holdingsBefore : 0;
  bot.inventoryCostUSDT = Math.max(cost - avg * size, 0);
}
function markUnrealised(bot, livePrice) {
  const held = bot.totalBaseHoldings || 0;
  const cost = bot.inventoryCostUSDT ?? (bot.inventoryCostBasis || bot.initialPrice || livePrice) * held;
  bot.unrealizedPnlUSDT = Number((held * livePrice - cost).toFixed(2));
}

/** True when buying `size` more would push the bot's inventory past its cap. */
function overInventoryCap(bot, size) {
  return Number.isFinite(bot.maxInventory) && (bot.totalBaseHoldings || 0) + size > bot.maxInventory + 1e-12;
}

/**
 * Range-exit guard for grid/QSL bots. When the price falls to stopLossPrice or rises to takeProfitPrice
 * the bot sells its remaining inventory at market and stops (status STOPPED_OUT). Returns true if it exited.
 */
function checkExit(bot, account, livePrice) {
  const stop = Number(bot.stopLossPrice) > 0 && livePrice <= bot.stopLossPrice;
  const take = Number(bot.takeProfitPrice) > 0 && livePrice >= bot.takeProfitPrice;
  if (!stop && !take) return false;
  const reason = stop ? `stop-loss ${bot.stopLossPrice}` : `take-profit ${bot.takeProfitPrice}`;
  const qty = Number(Math.min(bot.totalBaseHoldings || 0, baseInventory(account, bot.symbol)).toFixed(8));
  if (qty > 0) {
    const res = executeFill({ bot, side: 'SELL', price: livePrice, size: qty, orderType: bot.broker === 'coinswitch' ? 'LIMIT' : 'MARKET', timeInForce: 'IOC', tag: 'grid-exit' });
    if (!res.ok) { logRejection(bot, 'exit', `${reason} reached but the exit order was rejected: ${res.reason}`); return false; }
    bookSell(bot, qty, bot.totalBaseHoldings || 0);
    bot.exitPnlUSDT = Number((res.trade.realizedPnl || 0).toFixed(4));
    bot.totalBaseHoldings = Number(((bot.totalBaseHoldings || 0) - qty).toFixed(8));
  }
  bot.status = 'STOPPED_OUT';
  bot.stopReason = stop ? 'STOP_LOSS' : 'TAKE_PROFIT';
  markUnrealised(bot, livePrice);
  log(bot, `Bot stopped (${reason}): sold ${qty} ${bot.symbol} @ $${livePrice.toLocaleString()}${qty > 0 ? `, exit PnL ${bot.exitPnlUSDT} USDT` : ''}.`);
  return true;
}

// ---------- Risk management: drawdown, profit target, trailing stop ----------

// Track 24h equity high per account for daily drawdown checks
const equityHigh = new Map(); // accountId -> { high: number, resetAt: number }

function accountEquity(account) {
  return Number(account.totalEquityUSDT || account.availableMarginUSDT || 0);
}

/** Returns true if the account should be paused due to max daily drawdown. Resets the high-water mark every 24h. */
export function checkDailyDrawdown(account, maxDrawdownPercent) {
  const now = Date.now();
  const state = equityHigh.get(account.id) || { high: accountEquity(account), resetAt: now + 24 * 60 * 60 * 1000 };
  if (now > state.resetAt) { state.high = accountEquity(account); state.resetAt = now + 24 * 60 * 60 * 1000; }
  const current = accountEquity(account);
  if (current > state.high) state.high = current;
  equityHigh.set(account.id, state);
  const drawdownPct = ((state.high - current) / state.high) * 100;
  return drawdownPct >= maxDrawdownPercent
    ? { paused: true, reason: `Daily drawdown ${drawdownPct.toFixed(2)}% >= limit ${maxDrawdownPercent}%` }
    : { paused: false, drawdownPct };
}

/** Returns true if the bot should stop because realized PnL % hit the daily profit target. */
export function checkDailyProfitTarget(bot, entryPrice) {
  const target = Number(bot.dailyProfitTargetPercent);
  if (!target || target <= 0) return { stopped: false };
  const held = bot.totalBaseHoldings || 0;
  const entry = entryPrice || bot.initialPrice || 0;
  const currentValue = held * (bot.currentPrice || entry);
  const cost = bot.inventoryCostUSDT || (entry * held);
  const realized = bot.realizedProfitUSDT || 0;
  const totalPnL = realized + Math.max(currentValue - cost, 0);
  const pnlPct = cost > 0 ? (totalPnL / cost) * 100 : 0;
  return pnlPct >= target
    ? { stopped: true, reason: `Daily profit target ${pnlPct.toFixed(2)}% >= ${target}%` }
    : { stopped: false, pnlPct };
}

/** Returns true if the bot should exit due to trailing stop (price dropped X% from peak since entry). */
export function checkTrailingStop(bot, account, livePrice) {
  const trail = Number(bot.trailingStopPercent);
  if (!trail || trail <= 0) return { exited: false };
  const held = bot.totalBaseHoldings || 0;
  if (held <= 0) return { exited: false };
  // Track peak price since bot start / last reset
  if (!bot._peakPrice || livePrice > bot._peakPrice) bot._peakPrice = livePrice;
  const peak = bot._peakPrice;
  const dropPct = ((peak - livePrice) / peak) * 100;
  if (dropPct >= trail) {
    const qty = Number(Math.min(held, baseInventory(account, bot.symbol)).toFixed(8));
    if (qty > 0) {
      const res = executeFill({ bot, side: 'SELL', price: livePrice, size: qty, orderType: bot.broker === 'coinswitch' ? 'LIMIT' : 'MARKET', timeInForce: 'IOC', tag: 'trailing-stop' });
      if (!res.ok) { logRejection(bot, 'trailing', `trailing stop reached but the exit order was rejected: ${res.reason}`); return { exited: false }; }
      bookSell(bot, qty, bot.totalBaseHoldings || 0);
      bot.totalBaseHoldings = Number(((bot.totalBaseHoldings || 0) - qty).toFixed(8));
      const realizedPnl = res.trade?.realizedPnl ?? 0;
      bot.exitPnlUSDT = Number(((bot.exitPnlUSDT || 0) + realizedPnl).toFixed(4));
    }
    bot.status = 'STOPPED_OUT';
    bot.stopReason = 'TRAILING_STOP';
    markUnrealised(bot, livePrice);
    log(bot, `Trailing stop triggered: price dropped ${dropPct.toFixed(2)}% from peak $${peak.toLocaleString()}. Sold ${qty} ${bot.symbol} @ $${livePrice.toLocaleString()}.`);
    return { exited: true };
  }
  return { exited: false, dropPct };
}

// Latest price index of the running cycle: gives executeFill the 24h volume that drives slippage
let liveIndex = null;
const volumeOf = (symbol) => liveIndex?.get(symbol)?.quoteVolume;

const feePctFor = (broker) => BROKERS[broker]?.capabilities?.feeEstimatePercent ?? 0.1;

/**
 * Shared fill pipeline: margin check, settle, record order, cap history.
 * Used by executeFill (bots/TWAP/grid/QSL) and runPositionExits (TP/SL exits) so all fill paths behave identically.
 */
function settleAndRecord(account, order, price, feePct, meta) {
  const check = checkMargin(account, order, price, feePct);
  if (!check.ok) return { ok: false, reason: check.reason };
  const trade = settleOrderFill(account, order, price, feePct, meta);
  orders.unshift(order);
  capList(orders, MAX_HISTORY);
  return { ok: true, order, trade };
}

/**
 * Execute a simulated fill through the same accounting as manual orders
 * (margin / balances, positions, fees, trade book). Returns { ok, order, trade } or { ok:false, reason }.
 */
function executeFill({ bot, side, price, size, orderType = 'LIMIT', timeInForce = 'GTC', tag, liquidity = 'TAKER' }) {
  const account = accounts.find((a) => a.id === bot.accountId);
  if (!account) return { ok: false, reason: 'Account no longer exists' };
  // MAKER (grid/QSL rungs): fills at the rung price, maker fee. TAKER (market-style): slips against us, taker fee.
  const ex = executionCost({ broker: bot.broker, side, refPrice: price, size, quoteVolume: volumeOf(bot.symbol), liquidity });
  const order = {
    id: uid(`ord-${tag}`), accountId: account.id, broker: bot.broker, symbol: bot.symbol, side, orderType,
    price, size, filledSize: 0, status: 'OPEN', timeInForce, timestamp: new Date().toISOString(), fee: 0, source: 'BOT', botId: bot.id,
  };
  return settleAndRecord(account, order, ex.price, ex.feePct, { liquidity, slippagePct: ex.slippagePct, refPrice: price });
}

/** Log a rejection once per distinct reason so a starved bot doesn't spam its log every cycle. */
function logRejection(bot, key, reason) {
  if (bot._lastReject === `${key}:${reason}`) return;
  bot._lastReject = `${key}:${reason}`;
  log(bot, `Fill skipped: ${reason}`);
}

/** A grid needs base inventory for its initial SELL rungs: buy it at market from the account. */
export function seedGridInventory(bot, account, price) {
  const sells = bot.rungs.filter((r) => r.side === 'SELL').length;
  const qty = Number((sells * bot.sizePerGrid).toFixed(8));
  bot.totalBaseHoldings = 0;
  bot.inventoryCostBasis = price;
  bot.inventoryCostUSDT = 0;
  if (qty <= 0) return { ok: true, qty: 0 };
  if (Number.isFinite(bot.maxInventory) && qty > bot.maxInventory + 1e-12) {
    return { ok: false, reason: `starting inventory ${qty} exceeds maxInventory ${bot.maxInventory}; raise the cap or use fewer/smaller sell levels` };
  }
  const res = executeFill({ bot: { ...bot, accountId: account.id }, side: 'BUY', price, size: qty, orderType: 'MARKET', tag: 'grid-seed' });
  if (!res.ok) return res;
  bot.totalBaseHoldings = qty;
  bot.inventoryCostUSDT = qty * (res.trade?.price ?? price); // actual average fill, including slippage
  return { ok: true, qty };
}

function runTwap(bot, livePrice, now) {
  if (now < bot.nextExecutionTime) return;
  const remaining = Number((bot.totalSize - bot.executedSize).toFixed(8));
  if (remaining <= 0) {
    bot.status = 'COMPLETED';
    return;
  }
  const sliceSize = Number((bot.totalSize / bot.slicesCount).toFixed(8));
  // The last slice takes whatever is left so rounding never causes an extra (N+1th) slice
  const finalSliceSize = bot.completedSlices >= bot.slicesCount - 1 ? remaining : Math.min(remaining, sliceSize);

  // Risk management: daily drawdown pauses the bot; profit target or trailing stop exits it
  const account = accounts.find((a) => a.id === bot.accountId);
  if (account) {
    if (bot.maxDailyDrawdownPercent) {
      const dd = checkDailyDrawdown(account, bot.maxDailyDrawdownPercent);
      if (dd.paused) { bot.status = 'PAUSED'; bot.stopReason = dd.reason; log(bot, `Paused: ${dd.reason}`); return; }
    }
    if (bot.dailyProfitTargetPercent) {
      const pt = checkDailyProfitTarget(bot, livePrice);
      if (pt.stopped) { bot.status = 'STOPPED_OUT'; bot.stopReason = pt.reason; log(bot, `Stopped: ${pt.reason}`); return; }
    }
    if (bot.trailingStopPercent) {
      const ts = checkTrailingStop(bot, account, livePrice);
      if (ts.exited) return;
    }
  }

  const res = executeFill({ bot, side: bot.side, price: livePrice, size: finalSliceSize, orderType: bot.broker === 'coinswitch' ? 'LIMIT' : 'MARKET', timeInForce: 'IOC', tag: 'bot' });
  bot.nextExecutionTime = now + bot.intervalSeconds * 1000;
  if (!res.ok) {
    logRejection(bot, 'twap', res.reason);
    // Retry on the next interval, but give up after repeated failures instead of running forever
    bot.failStreak = (bot.failStreak || 0) + 1;
    if (bot.failStreak >= 5) {
      bot.status = 'ERROR';
      log(bot, `TWAP halted after ${bot.failStreak} consecutive rejected slices: ${res.reason}`);
    }
    return;
  }
  bot.failStreak = 0;
  const prevNotional = (bot.averageExecPrice || livePrice) * bot.executedSize;
  bot.executedSize = Number((bot.executedSize + finalSliceSize).toFixed(8));
  bot.completedSlices += 1;
  const fillPx = res.trade?.price ?? livePrice;
  bot.averageExecPrice = Number(((prevNotional + fillPx * finalSliceSize) / bot.executedSize).toFixed(8));
  log(bot, `Slice #${bot.completedSlices}/${bot.slicesCount} filled: ${finalSliceSize} ${bot.symbol} @ $${fillPx.toLocaleString()}`);

  if (bot.completedSlices >= bot.slicesCount || bot.executedSize >= bot.totalSize) {
    bot.status = 'COMPLETED';
    log(bot, `TWAP Slicer completed: ${bot.executedSize} ${bot.symbol} at avg price $${bot.averageExecPrice}.`);
  }
}

function runBreakout(bot, livePrice) {
  // BUY: breakout up through the trigger. SELL: breakdown through the trigger.
  const hit = bot.side === 'SELL' ? livePrice <= bot.triggerPrice : livePrice >= bot.triggerPrice;
  if (!hit) return;

  // Risk management: daily drawdown pauses the bot; profit target or trailing stop exits it
  const account = accounts.find((a) => a.id === bot.accountId);
  if (account) {
    if (bot.maxDailyDrawdownPercent) {
      const dd = checkDailyDrawdown(account, bot.maxDailyDrawdownPercent);
      if (dd.paused) { bot.status = 'PAUSED'; bot.stopReason = dd.reason; log(bot, `Paused: ${dd.reason}`); return; }
    }
    if (bot.trailingStopPercent) {
      const ts = checkTrailingStop(bot, account, livePrice);
      if (ts.exited) return;
    }
  }

  const res = executeFill({
    bot, side: bot.side, price: livePrice, size: bot.size,
    orderType: bot.broker === 'coinswitch' ? 'LIMIT' : 'MARKET', tag: 'breakout',
  });
  if (!res.ok) {
    bot.status = 'ERROR';
    log(bot, `Breakout triggered at $${livePrice} but the order was rejected: ${res.reason}`);
    return;
  }
  bot.status = 'COMPLETED';
  log(bot, `BREAKOUT CONFIRMED: $${livePrice} crossed trigger $${bot.triggerPrice}. Filled #${res.order.id}. Spot trade executed.`);
}

/** DCA Accumulator: buy a fixed USDT amount at fixed intervals until totalSize is reached. */
function runDCA(bot, livePrice, now) {
  if (now < bot.nextExecutionTime) return;
  const remaining = Number((bot.totalSize - bot.executedSize).toFixed(8));
  if (remaining <= 0) {
    bot.status = 'COMPLETED';
    log(bot, `DCA accumulator completed: ${bot.executedSize.toFixed(8)} ${bot.symbol} at avg price $${bot.averageExecPrice}.`);
    return;
  }

  // Risk management: daily drawdown pauses the bot; profit target exits it
  const account = accounts.find((a) => a.id === bot.accountId);
  if (account) {
    if (bot.maxDailyDrawdownPercent) {
      const dd = checkDailyDrawdown(account, bot.maxDailyDrawdownPercent);
      if (dd.paused) { bot.status = 'PAUSED'; bot.stopReason = dd.reason; log(bot, `Paused: ${dd.reason}`); return; }
    }
    if (bot.dailyProfitTargetPercent) {
      const pt = checkDailyProfitTarget(bot, livePrice);
      if (pt.stopped) { bot.status = 'STOPPED_OUT'; bot.stopReason = pt.reason; log(bot, `Stopped: ${pt.reason}`); return; }
    }
  }

  const amountThisInterval = Math.min(Number(bot.amountPerInterval), remaining);
  const size = Number((amountThisInterval / livePrice).toFixed(8));
  if (size <= 0) {
    bot.status = 'ERROR';
    log(bot, `DCA accumulator halted: size rounded to zero at price $${livePrice}.`);
    return;
  }

  const res = executeFill({ bot, side: 'BUY', price: livePrice, size, orderType: 'MARKET', tag: 'dca' });
  bot.nextExecutionTime = now + bot.intervalSeconds * 1000;
  if (!res.ok) {
    logRejection(bot, 'dca', res.reason);
    bot.failStreak = (bot.failStreak || 0) + 1;
    if (bot.failStreak >= 5) {
      bot.status = 'ERROR';
      log(bot, `DCA halted after ${bot.failStreak} consecutive rejected buys: ${res.reason}`);
    }
    return;
  }
  bot.failStreak = 0;
  bot.executedSize = Number((bot.executedSize + size).toFixed(8));
  const prevNotional = (bot.averageExecPrice || livePrice) * (bot.executedSize - size);
  bot.averageExecPrice = Number(((prevNotional + livePrice * size) / bot.executedSize).toFixed(8));
  log(bot, `DCA buy #${Math.round(bot.executedSize / size)}: ${size} ${bot.symbol} @ $${livePrice.toLocaleString()} (spent $${amountThisInterval.toFixed(2)}, remaining $${remaining.toFixed(2)})`);
  if (bot.executedSize >= bot.totalSize) {
    bot.status = 'COMPLETED';
    log(bot, `DCA accumulator completed: ${bot.executedSize.toFixed(8)} ${bot.symbol} at avg price $${bot.averageExecPrice}.`);
  }
}

function runGrid(bot, livePrice) {
  const account = accounts.find((a) => a.id === bot.accountId);
  if (!account) {
    bot.status = 'ERROR';
    log(bot, 'Account no longer exists; bot halted.');
    return;
  }
  const feeFrac = feeFor(bot.broker, 'MAKER') / 100; // rung fills are resting limit orders
  bot.currentPrice = livePrice;
  if (checkExit(bot, account, livePrice)) return;

  // Risk management: daily drawdown pauses the bot; profit target or trailing stop exits it
  if (bot.maxDailyDrawdownPercent) {
    const dd = checkDailyDrawdown(account, bot.maxDailyDrawdownPercent);
    if (dd.paused) { bot.status = 'PAUSED'; bot.stopReason = dd.reason; log(bot, `Paused: ${dd.reason}`); return; }
  }
  if (bot.dailyProfitTargetPercent) {
    const pt = checkDailyProfitTarget(bot, livePrice);
    if (pt.stopped) { bot.status = 'STOPPED_OUT'; bot.stopReason = pt.reason; log(bot, `Stopped: ${pt.reason}`); return; }
  }
  if (bot.trailingStopPercent) {
    const ts = checkTrailingStop(bot, account, livePrice);
    if (ts.exited) return;
  }

  markUnrealised(bot, livePrice);

  for (const rung of bot.rungs) {
    if (rung.status !== 'ACTIVE') continue;

    if (rung.side === 'BUY' && livePrice <= rung.price) {
      // Limit semantics: the order fills at the rung price, not at the (gapped) market price
      if (overInventoryCap(bot, rung.orderSize)) { logRejection(bot, `b${rung.index}`, `max inventory ${bot.maxInventory} reached`); continue; }
      const fillPrice = rung.price;
      const res = executeFill({ bot, side: 'BUY', price: fillPrice, size: rung.orderSize, tag: 'grid-b', liquidity: 'MAKER' });
      if (!res.ok) { logRejection(bot, `b${rung.index}`, res.reason); continue; }
      rung.fillsCount += 1;
      bot.completedRounds += 1;
      bookBuy(bot, fillPrice, rung.orderSize);
      bot.totalBaseHoldings = Number(((bot.totalBaseHoldings || 0) + rung.orderSize).toFixed(8));
      rung.side = 'SELL';
      [rung.price, rung.targetPrice] = [rung.targetPrice, rung.price];
      log(bot, `[Grid Buy Filled] Bought ${rung.orderSize} ${bot.symbol} @ $${fillPrice.toLocaleString()}. Sell limit placed @ $${rung.price.toLocaleString()}.`);
    } else if (rung.side === 'SELL' && livePrice >= rung.price) {
      // Only sell what the bot bought AND what the account still holds (user may have sold/closed it)
      if ((bot.totalBaseHoldings || 0) + 1e-12 < rung.orderSize) continue;
      if (baseInventory(account, bot.symbol) + 1e-12 < rung.orderSize) {
        logRejection(bot, `s${rung.index}`, 'account no longer holds the grid inventory');
        continue;
      }
      const fillPrice = rung.price;
      const boughtAt = rung.targetPrice;
      const res = executeFill({ bot, side: 'SELL', price: fillPrice, size: rung.orderSize, tag: 'grid-s', liquidity: 'MAKER' });
      if (!res.ok) { logRejection(bot, `s${rung.index}`, res.reason); continue; }
      rung.fillsCount += 1;
      bot.completedRounds += 1;
      const gross = (fillPrice - boughtAt) * rung.orderSize;
      const fees = (fillPrice + boughtAt) * rung.orderSize * feeFrac;
      const netProfit = Number((gross - fees).toFixed(4));
      rung.profitCaptured = Number(((rung.profitCaptured || 0) + netProfit).toFixed(4));
      bot.realizedProfitUSDT = Number(((bot.realizedProfitUSDT || 0) + netProfit).toFixed(4));
      bookSell(bot, rung.orderSize, bot.totalBaseHoldings || 0);
      bot.totalBaseHoldings = Number(((bot.totalBaseHoldings || 0) - rung.orderSize).toFixed(8));
      bot.volumeUSDT = Number(((bot.volumeUSDT || 0) + fillPrice * rung.orderSize).toFixed(2));
      rung.side = 'BUY';
      [rung.price, rung.targetPrice] = [rung.targetPrice, rung.price];
      log(bot, `[Grid Spread Harvested] Sold @ $${fillPrice.toLocaleString()}. Net ${netProfit >= 0 ? '+' : ''}$${netProfit} USDT. Buy limit placed @ $${rung.price.toLocaleString()}.`);
    }
  }
  markUnrealised(bot, livePrice); // after fills, so the UI shows current PnL
}

/** Recenter QSL square levels around the current live price. */
function recenterQSL(bot, livePrice) {
  // The tick multiplier is fixed at creation (Pine's mintick). Re-deriving it from the current
  // price string would change the level scale whenever the price gains or loses a decimal digit.
  const decimals = bot.decimalPlaces ?? f_decimalPlaces(livePrice);
  const multiplier = bot.multiplier || Math.pow(10, decimals);
  const newBaseNumber = Math.round(Math.sqrt(livePrice * multiplier));
  if (newBaseNumber === bot.baseNumber) return false;

  const newLevels = generateSquareLevels({
    centerNumber: newBaseNumber,
    levelsEachSide: bot.levelsEachSide,
    currentPrice: livePrice,
    multiplier,
    sizePerGrid: bot.sizePerGrid, // previously omitted -> every recentred level silently used size 1
    precision: decimals,
    stride: bot.stride || 1,
  });
  bot.baseNumber = newBaseNumber;

  bot.levels = newLevels;
  bot.rungs = newLevels; // keep the UI-facing ladder in sync
  bot.initialPrice = livePrice;
  bot.inventoryCostBasis = bot.inventoryCostBasis || livePrice;
  log(bot, `[QSL Recenter] Base #${newBaseNumber}, levels recalculated @ $${livePrice.toLocaleString()}.`);
  return true;
}

/** Run one QSL cycle: process square-level fills and auto-recenter on trigger. */
function runQSL(bot, livePrice) {
  const account = accounts.find((a) => a.id === bot.accountId);
  if (!account) {
    bot.status = 'ERROR';
    log(bot, 'Account no longer exists; bot halted.');
    return;
  }
  const feeFrac = feeFor(bot.broker, 'MAKER') / 100; // rung fills are resting limit orders
  bot.currentPrice = livePrice;
  if (checkExit(bot, account, livePrice)) return;

  // Risk management: daily drawdown pauses the bot; profit target or trailing stop exits it
  if (bot.maxDailyDrawdownPercent) {
    const dd = checkDailyDrawdown(account, bot.maxDailyDrawdownPercent);
    if (dd.paused) { bot.status = 'PAUSED'; bot.stopReason = dd.reason; log(bot, `Paused: ${dd.reason}`); return; }
  }
  if (bot.dailyProfitTargetPercent) {
    const pt = checkDailyProfitTarget(bot, livePrice);
    if (pt.stopped) { bot.status = 'STOPPED_OUT'; bot.stopReason = pt.reason; log(bot, `Stopped: ${pt.reason}`); return; }
  }
  if (bot.trailingStopPercent) {
    const ts = checkTrailingStop(bot, account, livePrice);
    if (ts.exited) return;
  }

  markUnrealised(bot, livePrice);

  // Auto-recenter trigger: price reaches triggerLevel above/below center
  const triggerIndex = Math.max(1, bot.triggerLevel || 2);
  const levels = bot.levels || [];
  // Trigger prices come from the base number, not from rung.price: rung prices swap with their
  // targets on every fill, which would make the trigger drift by one level.
  if (bot.baseNumber) {
    const stride = bot.stride || 1;
    const mult = bot.multiplier || 1;
    const upperPrice = rp(f_priceLevel(bot.baseNumber + triggerIndex * stride, mult));
    const lowerN = bot.baseNumber - triggerIndex * stride;
    const lowerPrice = lowerN > 0 ? rp(f_priceLevel(lowerN, mult)) : null;
    if ((livePrice >= upperPrice || (lowerPrice !== null && livePrice <= lowerPrice)) && recenterQSL(bot, livePrice)) return;
  }

  for (const rung of levels) {
    if (rung.status !== 'ACTIVE') continue;

    if (rung.side === 'BUY' && livePrice <= rung.price) {
      if (overInventoryCap(bot, rung.orderSize)) { logRejection(bot, `qsl-b${rung.number}`, `max inventory ${bot.maxInventory} reached`); continue; }
      const fillPrice = rung.price;
      const res = executeFill({ bot, side: 'BUY', price: fillPrice, size: rung.orderSize, tag: 'qsl-b', liquidity: 'MAKER' });
      if (!res.ok) { logRejection(bot, `qsl-b${rung.number}`, res.reason); continue; }
      rung.fillsCount += 1;
      bot.completedRounds += 1;
      bookBuy(bot, fillPrice, rung.orderSize);
      bot.totalBaseHoldings = Number(((bot.totalBaseHoldings || 0) + rung.orderSize).toFixed(8));
      rung.side = 'SELL';
      [rung.price, rung.targetPrice] = [rung.targetPrice, rung.price];
      log(bot, `[QSL Buy Filled] Bought ${rung.orderSize} ${bot.symbol} @ $${fillPrice.toLocaleString()}. Sell limit placed @ $${rung.price.toLocaleString()}.`);
    } else if (rung.side === 'SELL' && livePrice >= rung.price) {
      if ((bot.totalBaseHoldings || 0) + 1e-12 < rung.orderSize) continue;
      if (baseInventory(account, bot.symbol) + 1e-12 < rung.orderSize) {
        logRejection(bot, `qsl-s${rung.number}`, 'account no longer holds the QSL inventory');
        continue;
      }
      const fillPrice = rung.price;
      const boughtAt = rung.targetPrice;
      const res = executeFill({ bot, side: 'SELL', price: fillPrice, size: rung.orderSize, tag: 'qsl-s', liquidity: 'MAKER' });
      if (!res.ok) { logRejection(bot, `qsl-s${rung.number}`, res.reason); continue; }
      rung.fillsCount += 1;
      bot.completedRounds += 1;
      const gross = (fillPrice - boughtAt) * rung.orderSize;
      const fees = (fillPrice + boughtAt) * rung.orderSize * feeFrac;
      const netProfit = Number((gross - fees).toFixed(4));
      rung.profitCaptured = Number(((rung.profitCaptured || 0) + netProfit).toFixed(4));
      bot.realizedProfitUSDT = Number(((bot.realizedProfitUSDT || 0) + netProfit).toFixed(4));
      bookSell(bot, rung.orderSize, bot.totalBaseHoldings || 0);
      bot.totalBaseHoldings = Number(((bot.totalBaseHoldings || 0) - rung.orderSize).toFixed(8));
      bot.volumeUSDT = Number(((bot.volumeUSDT || 0) + fillPrice * rung.orderSize).toFixed(2));
      rung.side = 'BUY';
      [rung.price, rung.targetPrice] = [rung.targetPrice, rung.price];
      log(bot, `[QSL Spread Harvested] Sold @ $${fillPrice.toLocaleString()}. Net ${netProfit >= 0 ? '+' : ''}$${netProfit} USDT. Buy limit placed @ $${rung.price.toLocaleString()}.`);
    }
  }
  markUnrealised(bot, livePrice); // after fills, so the UI shows current PnL
}

/** Evaluate GTT / conditional rules against live prices. */
function runGtt(liveCoins) {  // liveCoins: Map<symbol, coin>
  for (const rule of gttRules) {
    if (rule.status !== 'ACTIVE') continue;
    const coin = liveCoins.get(rule.symbol);
    if (!coin) continue;
    const p = coin.price;
    let reason = null;
    if (rule.targetPrice || rule.stopLossPrice) {
      const longExit = rule.side !== 'BUY';
      if (rule.targetPrice && (longExit ? p >= rule.targetPrice : p <= rule.targetPrice)) reason = 'TARGET';
      else if (rule.stopLossPrice && (longExit ? p <= rule.stopLossPrice : p >= rule.stopLossPrice)) reason = 'STOP_LOSS';
    }
    if (!reason && rule.triggerPrice) {
      if (rule.condition === 'BELOW' ? p <= rule.triggerPrice : p >= rule.triggerPrice) reason = 'TRIGGER';
    }
    if (!reason) continue;
    const res = executeFill({
      bot: { id: rule.id, accountId: rule.accountId, broker: rule.broker, symbol: rule.symbol, logs: [] },
      side: rule.side, orderType: 'MARKET', price: p, size: rule.size, tag: 'gtt',
    });
    rule.triggeredAt = new Date().toISOString();
    rule.triggerReason = reason;
    rule.triggeredPrice = p;
    if (res.ok) {
      rule.status = 'TRIGGERED';
    } else {
      rule.status = 'REJECTED';
      rule.notes = `Triggered (${reason}) but the order was rejected: ${res.reason}`;
    }
  }
}

/** Fill resting LIMIT orders when the live price reaches them (BUY at/below, SELL at/above). */
function runOpenOrders(liveCoins) {
  // Iterate a copy: mirroring unshifts replica orders into `orders` while we loop
  for (const order of [...orders]) {
    if (order.status !== 'OPEN' || order.orderType !== 'LIMIT') continue;
    const coin = liveCoins.get(order.symbol);
    const account = accounts.find((a) => a.id === order.accountId);
    if (!coin || !account) continue;
    const reached = order.side === 'BUY' ? coin.price <= order.price : coin.price >= order.price;
    if (!reached) continue;
    const feePct = feeFor(order.broker, 'MAKER'); // a resting limit order that gets hit is a maker fill
    releaseOrder(account, order); // reserved funds go back first, then the normal checks and accounting run
    const check = checkMargin(account, order, order.price, feePct);
    if (!check.ok) {
      order.status = 'REJECTED';
      order.notes = `Rejected at fill time: ${check.reason}`;
      continue;
    }
    settleOrderFill(account, order, order.price, feePct, { liquidity: 'MAKER', slippagePct: 0 });
    // Only mirror manually placed orders, not bot or TP/SL exit fills.
    if (order.source !== 'BOT' && order.source !== 'TP_SL' && shouldMirror(account, order)) mirrorFilledOrder(account, order, coin.price, { quoteVolume: coin.quoteVolume });
  }
}

/** Auto-close positions whose take-profit or stop-loss has been reached (checked every cycle). */
function runPositionExits(liveCoins) {
  // Opt-out kill switch for operators who do not want existing positions auto-closed on rollout.
  if (process.env.AUTO_POSITION_EXITS === 'false') return;
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  for (const pos of [...positions]) {
    const coin = liveCoins.get(pos.symbol);
    const account = accountById.get(pos.accountId);
    if (!coin || !account) continue;
    let p = coin.price;
    const long = pos.side === 'LONG';
    let reason = null;
    if (pos.slPrice && (long ? p <= pos.slPrice : p >= pos.slPrice)) reason = 'STOP_LOSS';
    else if (pos.tpPrice && (long ? p >= pos.tpPrice : p <= pos.tpPrice)) reason = 'TAKE_PROFIT';
    if (!reason) continue;
    const ex = executionCost({ broker: pos.broker, side: long ? 'SELL' : 'BUY', refPrice: p, size: pos.size, quoteVolume: coin.quoteVolume });
    const order = {
      id: uid('ord-exit'), accountId: account.id, broker: pos.broker, symbol: pos.symbol,
      side: long ? 'SELL' : 'BUY', orderType: 'MARKET', price: p, size: pos.size, filledSize: 0,
      status: 'OPEN', timeInForce: 'IOC', source: 'TP_SL', notes: `${reason} @ ${p}`,
      timestamp: new Date().toISOString(), fee: 0,
    };
    const result = settleAndRecord(account, order, ex.price, ex.feePct, { liquidity: 'TAKER', slippagePct: ex.slippagePct, refPrice: p });
    if (!result.ok) continue;
    console.log(`[TP/SL] ${reason} closed ${pos.symbol} ${pos.side} @ ${p} (PnL ${result.trade.realizedPnl})`);
  }
}

/**
 * One background cycle: runs bots and conditional rules against live Binance prices.
 * Skips the network entirely when there is nothing to evaluate.
 */
let cycleRunning = false;
export async function runBotsBackgroundCycle() {
  if (cycleRunning) return; // a slow price fetch must not let cycles overlap and apply stale prices
  cycleRunning = true;
  try { await runCycleInner(); } finally { cycleRunning = false; }
}

async function runCycleInner() {
  const running = botsState.bots.filter((b) => b.status === 'RUNNING');
  const hasGtt = gttRules.some((r) => r.status === 'ACTIVE');
  const hasOpenOrders = orders.some((o) => o.status === 'OPEN');
  const hasExits = positions.length > 0; // TP/SL checks
  if (running.length === 0 && !hasGtt && !hasOpenOrders && !hasExits) return;

  let liveCoins;
  try {
    liveCoins = await getLivePriceIndex();
  } catch {
    return;
  }
  // Never fill against old prices while the market feed is down
  if (isFeedStale()) return;
  liveIndex = liveCoins;

  const now = Date.now();
  for (const bot of running) {
    // Subscribe to individual ticker stream for this bot's symbol (real-time price)
    subscribeSymbol(bot.symbol);

    // Time-based exit: stop bot after the configured hours
    if (bot.timeExitAt && now >= bot.timeExitAt) {
      bot.status = 'STOPPED_OUT';
      bot.stopReason = 'TIME_EXIT';
      log(bot, `Time-based exit: stopping after ${bot.timeExitHours} hour(s).`);
      continue;
    }
    const coin = liveCoins.get(bot.symbol);
    if (!coin) continue;
    try {
      if (bot.type === 'TWAP_SLICER') runTwap(bot, coin.price, now);
      else if (bot.type === 'BREAKOUT_CHASER') runBreakout(bot, coin.price);
      else if (bot.type === 'GRID_BOT' && Array.isArray(bot.rungs)) runGrid(bot, coin.price);
      else if (bot.type === 'QSL' && Array.isArray(bot.levels)) runQSL(bot, coin.price);
      else if (bot.type === 'DCA_ACCUMULATOR') runDCA(bot, coin.price, now);
    } catch (err) {
      bot.status = 'ERROR';
      log(bot, `Bot halted by internal error: ${err.message}`);
    }
  }
  if (hasGtt) runGtt(liveCoins);
  if (hasOpenOrders) runOpenOrders(liveCoins);
  if (hasExits) runPositionExits(liveCoins);
}

let timer = null;
/** Start the background loop (called once from server.ts, not on import). */
export function startBotLoop(intervalMs = 3000) {
  if (timer) return;
  timer = setInterval(() => {
    runBotsBackgroundCycle().catch((e) => console.error('Bot cycle failed:', e.message));
  }, intervalMs);
  timer.unref?.();
}

/** Per-bot runners, exposed so tests can drive them with scripted prices (no network). */
export const __runners = { runTwap, runBreakout, runGrid, runQSL, runDCA, runOpenOrders };
