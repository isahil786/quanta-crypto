// Grid Bot Backtesting & Optimization Engine
// Simulates walk-forward execution of volatility grid strategies using 100% real Binance historical klines

// Significant-digit rounding: safe for sub-cent coins (toFixed(4) would collapse SHIB-style prices to 0)
const rp = (x) => Number(Number(x).toPrecision(10));

/**
 * Generate grid rungs between lower and upper bounds
 */
export function generateSimulationRungs({
  lowerPrice,
  upperPrice,
  gridCount,
  startPrice,
  gridMode = 'ARITHMETIC',
  sizePerGrid,
}) {
  const rungs = [];
  const count = Math.max(2, Math.min(parseInt(gridCount, 10) || 10, 50));
  const lower = Number(lowerPrice);
  const upper = Number(upperPrice);
  if (!(lower > 0) || !(upper > lower)) {
    throw new Error('Grid range invalid: upper price must be greater than lower price (both > 0).');
  }

  if (gridMode === 'GEOMETRIC') {
    const ratio = Math.pow(upper / lower, 1 / count);
    for (let i = 0; i <= count; i++) {
      const price = rp(lower * Math.pow(ratio, i));
      const isBuy = price < startPrice;
      const targetPrice = isBuy
        ? rp(lower * Math.pow(ratio, i + 1))
        : rp(lower * Math.pow(ratio, Math.max(0, i - 1)));

      rungs.push({
        id: `rung-${i}`,
        index: i,
        price,
        targetPrice,
        side: isBuy ? 'BUY' : 'SELL',
        size: sizePerGrid,
        fillsCount: 0,
        profitCaptured: 0,
        totalVolume: 0,
      });
    }
  } else {
    // ARITHMETIC
    const step = (upper - lower) / count;
    for (let i = 0; i <= count; i++) {
      const price = rp(lower + i * step);
      const isBuy = price < startPrice;
      const targetPrice = isBuy
        ? rp(price + step)
        : rp(price - step);

      rungs.push({
        id: `rung-${i}`,
        index: i,
        price,
        targetPrice,
        side: isBuy ? 'BUY' : 'SELL',
        size: sizePerGrid,
        fillsCount: 0,
        profitCaptured: 0,
        totalVolume: 0,
      });
    }
  }

  return rungs;
}

/**
 * Run historical walk-forward simulation of Grid Bot against Binance klines
 */
export function simulateGridBot({
  symbol = 'BTCUSDT',
  klines = [],
  initialCapital = 1000,
  lowerPrice,
  upperPrice,
  gridCount = 10,
  gridMode = 'ARITHMETIC',
  feeRate = 0.0005, // 0.05%
}) {
  if (!klines || klines.length < 5) {
    throw new Error('Insufficient historical kline candles for backtesting');
  }

  const capital = Number(initialCapital) || 1000;
  const startCandle = klines[0];
  const endCandle = klines[klines.length - 1];
  const startPrice = startCandle.open;
  const lower = Number(lowerPrice) || startPrice * 0.93;
  const upper = Number(upperPrice) || startPrice * 1.07;
  const grids = Math.max(3, Math.min(parseInt(gridCount, 10) || 10, 50));

  // Determine capital allocation: 50% for cash bids, 50% for coin inventory asks
  const count = grids + 1;
  const capitalPerRung = capital / count;
  const sizePerGrid = Number((capitalPerRung / startPrice).toFixed(6));

  const rungs = generateSimulationRungs({
    lowerPrice: lower,
    upperPrice: upper,
    gridCount: grids,
    startPrice,
    gridMode,
    sizePerGrid,
  });

  // Initial Portfolio allocation
  const buyRungs = rungs.filter((r) => r.side === 'BUY');
  const sellRungs = rungs.filter((r) => r.side === 'SELL');

  let cashBalance = capital * 0.5; // USDT cash reserve for buy orders
  let coinBalance = (capital * 0.5) / startPrice; // Base coin inventory for sell orders
  let cumulativeRealizedProfit = 0;
  let totalFeesPaid = 0;
  let buyFills = 0;
  let sellFills = 0;
  let completedSweeps = 0;
  let peakEquity = capital;
  let maxDrawdownUSDT = 0;
  let maxDrawdownPercent = 0;

  const equityHistory = [];
  const tradeLogs = [];
  let profitableSells = 0;
  const equitySeries = [];

  // Walk forward candle by candle
  for (let t = 0; t < klines.length; t++) {
    const candle = klines[t];
    const { high, low, close, closeTime } = candle;
    // A rung that flips in this candle must not flip back in the same candle: we cannot know the
    // intra-candle order of high and low, so assuming a free round trip would overstate results.
    const flippedThisCandle = new Set();

    // 1. Process BUY rungs (when candle dip touches or crosses down to limit price)
    for (const rung of rungs) {
      if (rung.side === 'BUY' && low <= rung.price && !flippedThisCandle.has(rung.id)) {
        const orderCost = rung.price * rung.size;
        const fee = orderCost * feeRate;

        if (cashBalance >= orderCost + fee) {
          cashBalance -= (orderCost + fee);
          coinBalance += rung.size;
          totalFeesPaid += fee;
          buyFills += 1;
          rung.fillsCount += 1;
          rung.totalVolume += orderCost;

          // Flip to SELL at targetPrice (higher sell level), target becomes re-entry buy price
          const prevPrice = rung.price;
          const sellLevel = rung.targetPrice;
          rung.side = 'SELL';
          rung.targetPrice = prevPrice;
          rung.price = sellLevel;
          flippedThisCandle.add(rung.id);

          {
            tradeLogs.push({
              id: `bt-trade-${t}-${buyFills}`,
              time: new Date(closeTime).toISOString(),
              timeLabel: new Date(closeTime).toLocaleString(),
              side: 'BUY',
              price: prevPrice,
              size: rung.size,
              cost: Number(orderCost.toFixed(2)),
              fee: Number(fee.toFixed(4)),
              profit: 0,
              cashBalance: Number(cashBalance.toFixed(2)),
              coinBalance: Number(coinBalance.toFixed(6)),
            });
          }
        }
      }
    }

    // 2. Process SELL rungs (when candle rally touches or crosses up to limit price)
    for (const rung of rungs) {
      if (rung.side === 'SELL' && high >= rung.price && !flippedThisCandle.has(rung.id)) {
        if (coinBalance >= rung.size * 0.8) {
          const sellSize = Math.min(coinBalance, rung.size);
          const revenue = rung.price * sellSize;
          const fee = revenue * feeRate;

          coinBalance -= sellSize;
          cashBalance += (revenue - fee);
          totalFeesPaid += fee;
          sellFills += 1;
          completedSweeps += 1;
          rung.fillsCount += 1;
          rung.totalVolume += revenue;

          // Spread profit calculation
          const boughtAt = rung.targetPrice || rung.price * 0.98;
          const spreadGain = Math.max(0, (rung.price - boughtAt) * sellSize - (fee * 2));
          cumulativeRealizedProfit += spreadGain;
          rung.profitCaptured = Number(((rung.profitCaptured || 0) + spreadGain).toFixed(2));

          // Flip to BUY at targetPrice (lower buy level), target becomes re-entry sell price
          const prevPrice = rung.price;
          const buyLevel = rung.targetPrice;
          rung.side = 'BUY';
          rung.targetPrice = prevPrice;
          rung.price = buyLevel;
          flippedThisCandle.add(rung.id);
          if (spreadGain > 0) profitableSells += 1;

          {
            tradeLogs.push({
              id: `bt-trade-${t}-${sellFills}`,
              time: new Date(closeTime).toISOString(),
              timeLabel: new Date(closeTime).toLocaleString(),
              side: 'SELL',
              price: prevPrice,
              size: sellSize,
              cost: Number(revenue.toFixed(2)),
              fee: Number(fee.toFixed(4)),
              profit: Number(spreadGain.toFixed(2)),
              cashBalance: Number(cashBalance.toFixed(2)),
              coinBalance: Number(coinBalance.toFixed(6)),
            });
          }
        }
      }
    }

    // Mark to market portfolio valuation at candle close
    const currentEquity = cashBalance + (coinBalance * close);
    if (currentEquity > peakEquity) {
      peakEquity = currentEquity;
    }
    const currentDd = peakEquity - currentEquity;
    const currentDdPercent = peakEquity > 0 ? (currentDd / peakEquity) * 100 : 0;
    if (currentDdPercent > maxDrawdownPercent) {
      maxDrawdownPercent = currentDdPercent;
      maxDrawdownUSDT = currentDd;
    }

    equitySeries.push(currentEquity);

    // Sample equity curve points
    if (t % Math.max(1, Math.floor(klines.length / 50)) === 0 || t === klines.length - 1) {
      const benchmarkBuyAndHold = capital * (close / startPrice);
      equityHistory.push({
        time: closeTime,
        date: new Date(closeTime).toLocaleDateString(),
        equity: Number(currentEquity.toFixed(2)),
        benchmark: Number(benchmarkBuyAndHold.toFixed(2)),
        price: close,
        cash: Number(cashBalance.toFixed(2)),
        coinValue: Number((coinBalance * close).toFixed(2)),
      });
    }
  }

  // Final calculations
  const finalPrice = endCandle.close;
  const finalEquity = cashBalance + (coinBalance * finalPrice);
  const totalNetProfit = finalEquity - capital;
  const netReturnPercent = (totalNetProfit / capital) * 100;

  const durationMs = endCandle.closeTime - startCandle.openTime;
  const durationDays = Math.max(durationMs / (1000 * 60 * 60 * 24), 0.5);
  const annualizedApr = (netReturnPercent / durationDays) * 365;

  const buyAndHoldReturn = ((finalPrice - startPrice) / startPrice) * 100;
  const outperformance = netReturnPercent - buyAndHoldReturn;

  const totalTrades = buyFills + sellFills;
  // Share of sell fills that realised a positive net spread (cannot exceed 100%)
  const winRate = sellFills > 0 ? (profitableSells / sellFills) * 100 : 0;
  // Realised spread profit per unit of fees paid (0 when nothing traded)
  const profitFactor = totalFeesPaid > 0 ? cumulativeRealizedProfit / totalFeesPaid : 0;

  // Sharpe from the per-candle equity curve, annualised with the real candle length
  let sharpeRatio = 0;
  if (equitySeries.length > 2) {
    const rets = [];
    for (let i = 1; i < equitySeries.length; i++) {
      if (equitySeries[i - 1] > 0) rets.push(equitySeries[i] / equitySeries[i - 1] - 1);
    }
    const mean = rets.reduce((x, y) => x + y, 0) / (rets.length || 1);
    const variance = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length || 1);
    const sd = Math.sqrt(variance);
    const candleMs = Math.max((endCandle.closeTime - startCandle.openTime) / klines.length, 1);
    const periodsPerYear = (365 * 24 * 3600 * 1000) / candleMs;
    sharpeRatio = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;
  }
  sharpeRatio = Number.isFinite(sharpeRatio) ? Number(sharpeRatio.toFixed(2)) : 0;
  // APR extrapolated from a short window is unreliable; flag it for the UI
  const aprReliable = durationDays >= 14;

  return {
    symbol,
    durationDays: Number(durationDays.toFixed(1)),
    candlesCount: klines.length,
    initialCapital: capital,
    finalEquity: Number(finalEquity.toFixed(2)),
    totalNetProfit: Number(totalNetProfit.toFixed(2)),
    netReturnPercent: Number(netReturnPercent.toFixed(2)),
    annualizedApr: Number(annualizedApr.toFixed(1)),
    cumulativeRealizedProfit: Number(cumulativeRealizedProfit.toFixed(2)),
    totalFeesPaid: Number(totalFeesPaid.toFixed(2)),
    buyAndHoldReturn: Number(buyAndHoldReturn.toFixed(2)),
    outperformance: Number(outperformance.toFixed(2)),
    maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(2)),
    maxDrawdownUSDT: Number(maxDrawdownUSDT.toFixed(2)),
    totalTrades,
    buyFills,
    sellFills,
    completedSweeps,
    winRate: Number(winRate.toFixed(1)),
    profitFactor: Number(profitFactor.toFixed(2)),
    sharpeRatio,
    aprReliable,
    gridParams: {
      lowerPrice: lower,
      upperPrice: upper,
      gridCount: grids,
      gridMode,
      sizePerGrid,
      feeRate,
      rangePercent: Number((((upper - lower) / lower) * 100).toFixed(2)),
    },
    rungs: rungs.map((r) => ({
      ...r,
      fillsCount: r.fillsCount || 0,
      profitCaptured: Number((r.profitCaptured || 0).toFixed(2)),
    })),
    equityHistory,
    tradeLogs: tradeLogs.slice(-50).reverse(), // 50 most recent, newest first
  };
}

/**
 * Multi-Strategy Grid Optimizer (Parameter Sweep)
 * Evaluates multiple strategies against the historical dataset to discover the highest Sharpe and net yield
 */
export function optimizeGridStrategies({ symbol, klines, initialCapital = 1000, feeRate = 0.0005 }) {
  if (!klines || klines.length < 5) return [];

  // Out-of-sample: choose grid ranges from the first 60% of candles and score them on the last 40%.
  // (Ranges built from the same window that is scored would use perfect hindsight.)
  const canSplit = klines.length >= 20;
  const split = canSplit ? Math.floor(klines.length * 0.6) : klines.length;
  const trainKlines = klines.slice(0, split);
  const testKlines = canSplit ? klines.slice(split) : klines;

  // Find min and max price over the training period
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const k of trainKlines) {
    if (k.low < minPrice) minPrice = k.low;
    if (k.high > maxPrice) maxPrice = k.high;
  }

  // Strategy presets to evaluate
  const strategyConfigs = [
    {
      id: 'tight-scalp',
      name: 'Tight Arithmetic Scalper',
      description: 'Dense arithmetic rungs inside the inner part of the training range (2% inset each side)',
      lowerPrice: Number((minPrice * 1.02).toFixed(2)),
      upperPrice: Number((maxPrice * 0.98).toFixed(2)),
      gridCount: 20,
      gridMode: 'ARITHMETIC',
    },
    {
      id: 'balanced-institutional',
      name: 'Balanced Geometric Grid',
      description: 'Geometric rungs with a 3% buffer beyond the training range',
      lowerPrice: Number((minPrice * 0.97).toFixed(2)),
      upperPrice: Number((maxPrice * 1.03).toFixed(2)),
      gridCount: 14,
      gridMode: 'GEOMETRIC',
    },
    {
      id: 'wide-swing',
      name: 'Wide Swing Horizon Grid',
      description: 'Wide range (8% below / 10% above training range) to tolerate large swings',
      lowerPrice: Number((minPrice * 0.92).toFixed(2)),
      upperPrice: Number((maxPrice * 1.10).toFixed(2)),
      gridCount: 10,
      gridMode: 'GEOMETRIC',
    },
    {
      id: 'high-density-arithmetic',
      name: 'High-Density Arithmetic Grid',
      description: 'Fixed-step arithmetic grid with 24 rungs for sideways markets',
      lowerPrice: Number((minPrice * 0.98).toFixed(2)),
      upperPrice: Number((maxPrice * 1.02).toFixed(2)),
      gridCount: 24,
      gridMode: 'ARITHMETIC',
    },
    {
      id: 'asymmetric-momentum',
      name: 'Asymmetric Bullish Momentum Grid',
      description: 'Wider upside range (+15%) so the grid keeps working if price breaks out upward',
      lowerPrice: Number((minPrice * 0.95).toFixed(2)),
      upperPrice: Number((maxPrice * 1.15).toFixed(2)),
      gridCount: 16,
      gridMode: 'GEOMETRIC',
    },
  ];

  const results = [];
  for (const config of strategyConfigs) {
    try {
      const sim = simulateGridBot({
        symbol,
        klines: testKlines,
        initialCapital,
        feeRate,
        lowerPrice: config.lowerPrice,
        upperPrice: config.upperPrice,
        gridCount: config.gridCount,
        gridMode: config.gridMode,
      });

      results.push({
        ...config,
        outOfSample: canSplit,
        netProfit: sim.totalNetProfit,
        netReturnPercent: sim.netReturnPercent,
        annualizedApr: sim.annualizedApr,
        maxDrawdownPercent: sim.maxDrawdownPercent,
        completedSweeps: sim.completedSweeps,
        totalTrades: sim.totalTrades,
        sharpeRatio: sim.sharpeRatio,
        outperformance: sim.outperformance,
        harvestedSpreadProfit: sim.cumulativeRealizedProfit,
        feesPaid: sim.totalFeesPaid,
        fullSimulation: sim,
      });
    } catch (err) {
      console.error(`Strategy simulation error for ${config.name}:`, err.message);
    }
  }

  // Sort by Sharpe ratio desc, then net return desc, then drawdown asc
  results.sort((a, b) => {
    if (b.sharpeRatio !== a.sharpeRatio) return b.sharpeRatio - a.sharpeRatio;
    if (b.netReturnPercent !== a.netReturnPercent) return b.netReturnPercent - a.netReturnPercent;
    return a.maxDrawdownPercent - b.maxDrawdownPercent;
  });

  // Mark rank and recommendation
  return results.map((r, idx) => ({
    ...r,
    rank: idx + 1,
    isWinner: idx === 0,
  }));
}
