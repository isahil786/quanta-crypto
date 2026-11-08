// Institutional Algorithmic Execution Engine
// Advanced Volatility Grid, TWAP Micro-Slicer, and Momentum Breakout Radar
// Synchronized with live Binance Public API v3 market data

import { getLiveTop100MomentumCoins } from './binance.js';
import { orders, trades } from './state.js';

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

/**
 * Execute automated background bot cycles using live Binance ticker prices
 */
export async function runBotsBackgroundCycle() {
  const now = Date.now();
  let liveCoins = [];
  try {
    liveCoins = await getLiveTop100MomentumCoins();
  } catch (err) {
    return;
  }

  for (const bot of botsState.bots) {
    if (bot.status !== 'RUNNING') continue;

    const liveCoin = liveCoins.find((c) => c.symbol === bot.symbol);
    if (!liveCoin) continue;
    const livePrice = liveCoin.price;

    // 1. TWAP Slicer Execution
    if (bot.type === 'TWAP_SLICER') {
      if (now >= bot.nextExecutionTime) {
        const remainingSize = Number((bot.totalSize - bot.executedSize).toFixed(4));
        const sliceSize = Number((bot.totalSize / bot.slicesCount).toFixed(4));
        const finalSliceSize = remainingSize < sliceSize ? remainingSize : sliceSize;
        const newExecutedSize = Number((bot.executedSize + finalSliceSize).toFixed(4));
        bot.completedSlices += 1;
        bot.executedSize = newExecutedSize;
        bot.averageExecPrice = livePrice;
        bot.nextExecutionTime = now + bot.intervalSeconds * 1000;

        // Post order in memory
        const orderId = `ord-bot-${Date.now().toString(36)}`;
        orders.unshift({
          id: orderId,
          accountId: bot.accountId,
          broker: bot.broker,
          symbol: bot.symbol,
          side: bot.side,
          orderType: 'LIMIT',
          price: livePrice,
          size: finalSliceSize,
          filledSize: finalSliceSize,
          status: 'FILLED',
          timeInForce: 'IOC',
          leverage: 1,
          timestamp: new Date().toISOString(),
          fee: Number(((livePrice * finalSliceSize * 0.0005)).toFixed(4)),
        });

        trades.unshift({
          id: `trd-bot-${Date.now().toString(36)}`,
          orderId,
          accountId: bot.accountId,
          broker: bot.broker,
          symbol: bot.symbol,
          side: bot.side,
          price: livePrice,
          size: finalSliceSize,
          value: livePrice * finalSliceSize,
          fee: Number(((livePrice * finalSliceSize * 0.0005)).toFixed(4)),
          timestamp: new Date().toISOString(),
        });

        bot.logs.unshift({
          time: new Date().toLocaleTimeString(),
          text: `Slice #${bot.completedSlices}/${bot.slicesCount} filled: ${finalSliceSize} ${bot.symbol} @ $${livePrice.toLocaleString()}`,
        });

        if (bot.completedSlices >= bot.slicesCount || bot.executedSize >= bot.totalSize) {
          bot.status = 'COMPLETED';
          bot.logs.unshift({
            time: new Date().toLocaleTimeString(),
            text: `TWAP Slicer completed: 100% filled (${bot.totalSize} ${bot.symbol}) at avg price $${bot.averageExecPrice}.`,
          });
        }
      }
    }

    // 2. Breakout Chaser Execution
    if (bot.type === 'BREAKOUT_CHASER') {
      if (livePrice >= bot.triggerPrice) {
        bot.status = 'COMPLETED';
        const orderId = `ord-breakout-${Date.now().toString(36)}`;
        orders.unshift({
          id: orderId,
          accountId: bot.accountId,
          broker: bot.broker,
          symbol: bot.symbol,
          side: bot.side,
          orderType: bot.broker === 'coinswitch' ? 'LIMIT' : 'MARKET',
          price: livePrice,
          size: bot.size,
          filledSize: bot.size,
          status: 'FILLED',
          timeInForce: 'GTC',
          leverage: bot.leverage || 1,
          tpPrice: bot.tpPrice,
          slPrice: bot.slPrice,
          timestamp: new Date().toISOString(),
          fee: Number(((livePrice * bot.size * 0.0005)).toFixed(4)),
        });

        trades.unshift({
          id: `trd-breakout-${Date.now().toString(36)}`,
          orderId,
          accountId: bot.accountId,
          broker: bot.broker,
          symbol: bot.symbol,
          side: bot.side,
          price: livePrice,
          size: bot.size,
          value: livePrice * bot.size,
          fee: Number(((livePrice * bot.size * 0.0005)).toFixed(4)),
          timestamp: new Date().toISOString(),
        });

        bot.logs.unshift({
          time: new Date().toLocaleTimeString(),
          text: `BREAKOUT CONFIRMED! Binance mark $${livePrice} crossed trigger $${bot.triggerPrice}. Filled #${orderId} with TP: $${bot.tpPrice || 'None'} and SL: $${bot.slPrice || 'None'}.`,
        });
      }
    }

    // 3. Optimized Volatility Grid Execution
    if (bot.type === 'GRID_BOT' && Array.isArray(bot.rungs)) {
      // Calculate dynamic unrealized PnL
      const baseEntry = bot.initialPrice || (bot.lowerPrice + bot.upperPrice) / 2;
      bot.currentPrice = livePrice;
      bot.unrealizedPnlUSDT = Number(((livePrice - baseEntry) * (bot.totalBaseHoldings || 0)).toFixed(2));

      // Scan rungs for order fills
      for (const rung of bot.rungs) {
        if (rung.status !== 'ACTIVE') continue;

        // Case A: Buy Rung Triggered (Market price touched or crossed down to limit buy)
        if (rung.side === 'BUY' && livePrice <= rung.price) {
          rung.fillsCount += 1;
          bot.completedRounds += 1;
          bot.totalBaseHoldings = Number(((bot.totalBaseHoldings || 0) + rung.orderSize).toFixed(4));

          // Flip rung to Sell at targetPrice
          rung.side = 'SELL';
          const prevPrice = rung.price;
          rung.price = rung.targetPrice;
          rung.targetPrice = prevPrice;

          // Record fill in global orders & trades
          const ordId = `ord-grid-b-${Date.now().toString(36)}`;
          orders.unshift({
            id: ordId,
            accountId: bot.accountId,
            broker: bot.broker,
            symbol: bot.symbol,
            side: 'BUY',
            orderType: 'LIMIT',
            price: livePrice,
            size: rung.orderSize,
            filledSize: rung.orderSize,
            status: 'FILLED',
            timeInForce: 'GTC',
            leverage: 1,
            timestamp: new Date().toISOString(),
            fee: Number(((livePrice * rung.orderSize * 0.0005)).toFixed(4)),
          });

          trades.unshift({
            id: `trd-grid-b-${Date.now().toString(36)}`,
            orderId: ordId,
            accountId: bot.accountId,
            broker: bot.broker,
            symbol: bot.symbol,
            side: 'BUY',
            price: livePrice,
            size: rung.orderSize,
            value: livePrice * rung.orderSize,
            fee: Number(((livePrice * rung.orderSize * 0.0005)).toFixed(4)),
            timestamp: new Date().toISOString(),
          });

          bot.logs.unshift({
            time: new Date().toLocaleTimeString(),
            text: `[Grid Buy Filled] Bought ${rung.orderSize} ${bot.symbol} @ $${livePrice.toLocaleString()}. Placed matching Sell limit @ $${rung.price.toLocaleString()}.`,
          });
        }
        // Case B: Sell Rung Triggered (Market price touched or crossed up to limit sell)
        else if (rung.side === 'SELL' && livePrice >= rung.price) {
          rung.fillsCount += 1;
          bot.completedRounds += 1;

          // Calculate captured profit spread
          const boughtAt = rung.targetPrice;
          const soldAt = rung.price;
          const spreadGain = Math.max((soldAt - boughtAt) * rung.orderSize, 0);
          const feeEst = (soldAt + boughtAt) * rung.orderSize * 0.0005;
          const netProfit = Number((spreadGain - feeEst).toFixed(2));

          rung.profitCaptured = Number(((rung.profitCaptured || 0) + netProfit).toFixed(2));
          bot.realizedProfitUSDT = Number(((bot.realizedProfitUSDT || 0) + netProfit).toFixed(2));
          bot.totalBaseHoldings = Number(Math.max((bot.totalBaseHoldings || 0) - rung.orderSize, 0).toFixed(4));

          // Flip rung back to Buy at targetPrice
          rung.side = 'BUY';
          const prevPrice = rung.price;
          rung.price = rung.targetPrice;
          rung.targetPrice = prevPrice;

          // Record fill in global orders & trades
          const ordId = `ord-grid-s-${Date.now().toString(36)}`;
          orders.unshift({
            id: ordId,
            accountId: bot.accountId,
            broker: bot.broker,
            symbol: bot.symbol,
            side: 'SELL',
            orderType: 'LIMIT',
            price: livePrice,
            size: rung.orderSize,
            filledSize: rung.orderSize,
            status: 'FILLED',
            timeInForce: 'GTC',
            leverage: 1,
            timestamp: new Date().toISOString(),
            fee: Number(((livePrice * rung.orderSize * 0.0005)).toFixed(4)),
          });

          trades.unshift({
            id: `trd-grid-s-${Date.now().toString(36)}`,
            orderId: ordId,
            accountId: bot.accountId,
            broker: bot.broker,
            symbol: bot.symbol,
            side: 'SELL',
            price: livePrice,
            size: rung.orderSize,
            value: livePrice * rung.orderSize,
            fee: Number(((livePrice * rung.orderSize * 0.0005)).toFixed(4)),
            timestamp: new Date().toISOString(),
          });

          bot.logs.unshift({
            time: new Date().toLocaleTimeString(),
            text: `[Grid Spread Harvested] Sold @ $${livePrice.toLocaleString()}. Captured +$${netProfit} USDT net profit! Reset rung to Buy @ $${rung.price.toLocaleString()}.`,
          });
        }
      }
    }
  }
}

// Background runner cycle
setInterval(runBotsBackgroundCycle, 3000);
