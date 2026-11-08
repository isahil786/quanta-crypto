// Institutional Algorithmic Execution Engine
// Advanced Volatility Grid, TWAP Micro-Slicer, and Momentum Breakout Radar
// Synchronized with live Binance Public API v3 market data

import { getLiveTop100MomentumCoins } from './binance.js';
import { orders, trades, gttRules, accounts } from './state.js';
import { BROKERS } from './brokers/index.js';
import { checkMargin, settleOrderFill, baseInventory } from './positions.js';
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

/**
 * Generate full price ladder rungs for a grid bot
 */
export function generateGridRungs({
  lowerPrice,
  upperPrice,
  gridCount,
  currentPrice,
  sizePerGrid,
  gridMode = 'ARITHMETIC',
  precision = 2,
}) {
  const rungs = [];
  const count = Number(gridCount);
  const lower = Number(lowerPrice);
  const upper = Number(upperPrice);
  const size = Number(sizePerGrid);

  if (gridMode === 'GEOMETRIC') {
    const ratio = Math.pow(upper / lower, 1 / count);
    for (let i = 0; i <= count; i++) {
      const price = Number((lower * Math.pow(ratio, i)).toFixed(precision));
      const side = price < currentPrice ? 'BUY' : 'SELL';
      const targetPrice = side === 'BUY'
        ? Number((lower * Math.pow(ratio, i + 1)).toFixed(precision))
        : Number((lower * Math.pow(ratio, Math.max(0, i - 1))).toFixed(precision));

      rungs.push({
        id: `rung-${i}`,
        index: i,
        price,
        side,
        targetPrice,
        orderSize: size,
        status: 'ACTIVE',
        fillsCount: 0,
        profitCaptured: 0,
      });
    }
  } else {
    // ARITHMETIC
    const step = (upper - lower) / count;
    for (let i = 0; i <= count; i++) {
      const price = Number((lower + i * step).toFixed(precision));
      const side = price < currentPrice ? 'BUY' : 'SELL';
      const targetPrice = side === 'BUY'
        ? Number((price + step).toFixed(precision))
        : Number((price - step).toFixed(precision));

      rungs.push({
        id: `rung-${i}`,
        index: i,
        price,
        side,
        targetPrice,
        orderSize: size,
        status: 'ACTIVE',
        fillsCount: 0,
        profitCaptured: 0,
      });
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

const feePctFor = (broker) => BROKERS[broker]?.capabilities?.feeEstimatePercent ?? 0.1;

/**
 * Execute a simulated fill through the same accounting as manual orders
 * (margin / balances, positions, fees, trade book). Returns { ok, order, trade } or { ok:false, reason }.
 */
function executeFill({ bot, side, price, size, orderType = 'LIMIT', timeInForce = 'GTC', leverage = 1, tpPrice, slPrice, tag }) {
  const account = accounts.find((a) => a.id === bot.accountId);
  if (!account) return { ok: false, reason: 'Account no longer exists' };
  const feePct = feePctFor(bot.broker);
  const order = {
    id: uid(`ord-${tag}`), accountId: account.id, broker: bot.broker, symbol: bot.symbol, side, orderType,
    price, size, filledSize: 0, status: 'OPEN', timeInForce, leverage, tpPrice, slPrice,
    timestamp: new Date().toISOString(), fee: 0, source: 'BOT', botId: bot.id,
  };
  const check = checkMargin(account, order, price, feePct);
  if (!check.ok) return { ok: false, reason: check.reason };
  const trade = settleOrderFill(account, order, price, feePct);
  orders.unshift(order);
  capList(orders, MAX_HISTORY);
  return { ok: true, order, trade };
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
  if (qty <= 0) return { ok: true, qty: 0 };
  const res = executeFill({ bot: { ...bot, accountId: account.id }, side: 'BUY', price, size: qty, orderType: 'MARKET', tag: 'grid-seed' });
  if (!res.ok) return res;
  bot.totalBaseHoldings = qty;
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
  const finalSliceSize = Math.min(remaining, sliceSize);

  const res = executeFill({ bot, side: bot.side, price: livePrice, size: finalSliceSize, timeInForce: 'IOC', tag: 'bot' });
  bot.nextExecutionTime = now + bot.intervalSeconds * 1000;
  if (!res.ok) {
    logRejection(bot, 'twap', res.reason); // retry on the next interval
    return;
  }
  const prevNotional = (bot.averageExecPrice || livePrice) * bot.executedSize;
  bot.executedSize = Number((bot.executedSize + finalSliceSize).toFixed(8));
  bot.completedSlices += 1;
  bot.averageExecPrice = Number(((prevNotional + livePrice * finalSliceSize) / bot.executedSize).toFixed(8));
  log(bot, `Slice #${bot.completedSlices}/${bot.slicesCount} filled: ${finalSliceSize} ${bot.symbol} @ $${livePrice.toLocaleString()}`);

  if (bot.completedSlices >= bot.slicesCount || bot.executedSize >= bot.totalSize) {
    bot.status = 'COMPLETED';
    log(bot, `TWAP Slicer completed: ${bot.executedSize} ${bot.symbol} at avg price $${bot.averageExecPrice}.`);
  }
}

function runBreakout(bot, livePrice) {
  // BUY: breakout up through the trigger. SELL: breakdown through the trigger.
  const hit = bot.side === 'SELL' ? livePrice <= bot.triggerPrice : livePrice >= bot.triggerPrice;
  if (!hit) return;
  const res = executeFill({
    bot, side: bot.side, price: livePrice, size: bot.size, leverage: bot.leverage || 1,
    orderType: bot.broker === 'coinswitch' ? 'LIMIT' : 'MARKET', tpPrice: bot.tpPrice, slPrice: bot.slPrice, tag: 'breakout',
  });
  if (!res.ok) {
    bot.status = 'ERROR';
    log(bot, `Breakout triggered at $${livePrice} but the order was rejected: ${res.reason}`);
    return;
  }
  bot.status = 'COMPLETED';
  log(bot, `BREAKOUT CONFIRMED: $${livePrice} crossed trigger $${bot.triggerPrice}. Filled #${res.order.id}. TP/SL are recorded on the order only (not auto-executed by this bot).`);
}

function runGrid(bot, livePrice) {
  const account = accounts.find((a) => a.id === bot.accountId);
  if (!account) {
    bot.status = 'ERROR';
    log(bot, 'Account no longer exists; bot halted.');
    return;
  }
  const feeFrac = feePctFor(bot.broker) / 100;
  bot.currentPrice = livePrice;
  bot.unrealizedPnlUSDT = Number(((livePrice - (bot.inventoryCostBasis || bot.initialPrice || livePrice)) * (bot.totalBaseHoldings || 0)).toFixed(2));

  for (const rung of bot.rungs) {
    if (rung.status !== 'ACTIVE') continue;

    if (rung.side === 'BUY' && livePrice <= rung.price) {
      // Limit semantics: the order fills at the rung price, not at the (gapped) market price
      const fillPrice = rung.price;
      const res = executeFill({ bot, side: 'BUY', price: fillPrice, size: rung.orderSize, tag: 'grid-b' });
      if (!res.ok) { logRejection(bot, `b${rung.index}`, res.reason); continue; }
      rung.fillsCount += 1;
      bot.completedRounds += 1;
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
      const res = executeFill({ bot, side: 'SELL', price: fillPrice, size: rung.orderSize, tag: 'grid-s' });
      if (!res.ok) { logRejection(bot, `s${rung.index}`, res.reason); continue; }
      rung.fillsCount += 1;
      bot.completedRounds += 1;
      const gross = (fillPrice - boughtAt) * rung.orderSize;
      const fees = (fillPrice + boughtAt) * rung.orderSize * feeFrac;
      const netProfit = Number((gross - fees).toFixed(4));
      rung.profitCaptured = Number(((rung.profitCaptured || 0) + netProfit).toFixed(4));
      bot.realizedProfitUSDT = Number(((bot.realizedProfitUSDT || 0) + netProfit).toFixed(4));
      bot.totalBaseHoldings = Number(((bot.totalBaseHoldings || 0) - rung.orderSize).toFixed(8));
      bot.volumeUSDT = Number(((bot.volumeUSDT || 0) + fillPrice * rung.orderSize).toFixed(2));
      rung.side = 'BUY';
      [rung.price, rung.targetPrice] = [rung.targetPrice, rung.price];
      log(bot, `[Grid Spread Harvested] Sold @ $${fillPrice.toLocaleString()}. Net ${netProfit >= 0 ? '+' : ''}$${netProfit} USDT. Buy limit placed @ $${rung.price.toLocaleString()}.`);
    }
  }
}

/** Evaluate GTT / conditional rules against live prices. */
function runGtt(liveCoins) {
  for (const rule of gttRules) {
    if (rule.status !== 'ACTIVE') continue;
    const coin = liveCoins.find((c) => c.symbol === rule.symbol);
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
  for (const order of orders) {
    if (order.status !== 'OPEN' || order.orderType !== 'LIMIT') continue;
    const coin = liveCoins.find((c) => c.symbol === order.symbol);
    const account = accounts.find((a) => a.id === order.accountId);
    if (!coin || !account) continue;
    const reached = order.side === 'BUY' ? coin.price <= order.price : coin.price >= order.price;
    if (!reached) continue;
    const feePct = BROKERS[order.broker]?.capabilities?.feeEstimatePercent ?? 0.1;
    const check = checkMargin(account, order, order.price, feePct);
    if (!check.ok) {
      order.status = 'REJECTED';
      order.notes = `Rejected at fill time: ${check.reason}`;
      continue;
    }
    settleOrderFill(account, order, order.price, feePct);
  }
}

/**
 * One background cycle: runs bots and conditional rules against live Binance prices.
 * Skips the network entirely when there is nothing to evaluate.
 */
export async function runBotsBackgroundCycle() {
  const running = botsState.bots.filter((b) => b.status === 'RUNNING');
  const hasGtt = gttRules.some((r) => r.status === 'ACTIVE');
  const hasOpenOrders = orders.some((o) => o.status === 'OPEN');
  if (running.length === 0 && !hasGtt && !hasOpenOrders) return;

  let liveCoins;
  try {
    liveCoins = await getLiveTop100MomentumCoins();
  } catch {
    return;
  }

  const now = Date.now();
  for (const bot of running) {
    const coin = liveCoins.find((c) => c.symbol === bot.symbol);
    if (!coin) continue;
    try {
      if (bot.type === 'TWAP_SLICER') runTwap(bot, coin.price, now);
      else if (bot.type === 'BREAKOUT_CHASER') runBreakout(bot, coin.price);
      else if (bot.type === 'GRID_BOT' && Array.isArray(bot.rungs)) runGrid(bot, coin.price);
    } catch (err) {
      bot.status = 'ERROR';
      log(bot, `Bot halted by internal error: ${err.message}`);
    }
  }
  if (hasGtt) runGtt(liveCoins);
  if (hasOpenOrders) runOpenOrders(liveCoins);
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
