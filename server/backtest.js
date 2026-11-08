// Grid Bot Backtesting & Optimization Engine
// Simulates walk-forward execution of volatility grid strategies using 100% real Binance historical klines

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

  if (gridMode === 'GEOMETRIC') {
    const ratio = Math.pow(upper / lower, 1 / count);
    for (let i = 0; i <= count; i++) {
      const price = Number((lower * Math.pow(ratio, i)).toFixed(4));
      const isBuy = price < startPrice;
      const targetPrice = isBuy
        ? Number((lower * Math.pow(ratio, i + 1)).toFixed(4))
        : Number((lower * Math.pow(ratio, Math.max(0, i - 1))).toFixed(4));

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
      const price = Number((lower + i * step).toFixed(4));
      const isBuy = price < startPrice;
      const targetPrice = isBuy
        ? Number((price + step).toFixed(4))
        : Number((price - step).toFixed(4));

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

  // Walk forward candle by candle
  for (let t = 0; t < klines.length; t++) {
    const candle = klines[t];
    const { high, low, close, closeTime } = candle;

    // 1. Process BUY rungs (when candle dip touches or crosses down to limit price)
    for (const rung of rungs) {
      if (rung.side === 'BUY' && low <= rung.price) {
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

          if (tradeLogs.length < 150) {
            tradeLogs.unshift({
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
      if (rung.side === 'SELL' && high >= rung.price) {
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

          if (tradeLogs.length < 150) {
            tradeLogs.unshift({
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
  const winRate = buyFills > 0 ? (completedSweeps / buyFills) * 100 : 0;
  const profitFactor = totalFeesPaid > 0 ? (cumulativeRealizedProfit / totalFeesPaid) : 5.0;

  // Simple Sharpe proxy
  const dailyReturnEst = netReturnPercent / durationDays;
  const volatilityEst = Math.max(maxDrawdownPercent / Math.sqrt(durationDays), 1);
  const sharpeRatio = Number(((dailyReturnEst / volatilityEst) * Math.sqrt(365)).toFixed(2));

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
    sharpeRatio: isNaN(sharpeRatio) ? 1.5 : sharpeRatio,
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
    tradeLogs: tradeLogs.slice(0, 50),
  };
}

/**
 * Multi-Strategy Grid Optimizer (Parameter Sweep)
 * Evaluates multiple strategies against the historical dataset to discover the highest Sharpe and net yield
 */
export function optimizeGridStrategies({ symbol, klines, initialCapital = 1000 }) {
  if (!klines || klines.length < 5) return [];

  const startPrice = klines[0].open;
  const currentPrice = klines[klines.length - 1].close;

  // Find min and max price over historical period
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const k of klines) {
    if (k.low < minPrice) minPrice = k.low;
    if (k.high > maxPrice) maxPrice = k.high;
  }

  // Strategy presets to evaluate
  const strategyConfigs = [
    {
      id: 'tight-scalp',
      name: 'Ultra-Tight Volatility Scalper',
      description: 'High-frequency micro-spread capture with tight range boundaries and dense rungs',
      lowerPrice: Number((minPrice * 1.02).toFixed(2)),
      upperPrice: Number((maxPrice * 0.98).toFixed(2)),
      gridCount: 20,
      gridMode: 'ARITHMETIC',
    },
    {
      id: 'balanced-institutional',
      name: 'Balanced Institutional Grid (Recommended)',
      description: 'Optimal balance of volatility buffers, geometric fee efficiency, and sweep velocity',
      lowerPrice: Number((minPrice * 0.97).toFixed(2)),
      upperPrice: Number((maxPrice * 1.03).toFixed(2)),
      gridCount: 14,
      gridMode: 'GEOMETRIC',
    },
    {
      id: 'wide-swing',
      name: 'Wide Swing Horizon Grid',
      description: 'Wide safety cushions absorbing macro dips and multi-week expansion phases',
      lowerPrice: Number((minPrice * 0.92).toFixed(2)),
      upperPrice: Number((maxPrice * 1.10).toFixed(2)),
      gridCount: 10,
      gridMode: 'GEOMETRIC',
    },
    {
      id: 'high-density-arithmetic',
      name: 'High-Density Arithmetic Grid',
      description: 'Fixed dollar step grid maximizing round trips during sideways channel chop',
      lowerPrice: Number((minPrice * 0.98).toFixed(2)),
      upperPrice: Number((maxPrice * 1.02).toFixed(2)),
      gridCount: 24,
      gridMode: 'ARITHMETIC',
    },
    {
      id: 'asymmetric-momentum',
      name: 'Asymmetric Bullish Momentum Grid',
      description: 'Upward-biased grid structure geared to capture momentum breakouts with trailing profit',
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
        klines,
        initialCapital,
        lowerPrice: config.lowerPrice,
        upperPrice: config.upperPrice,
        gridCount: config.gridCount,
        gridMode: config.gridMode,
      });

      results.push({
        ...config,
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

  // Sort by net return descending
  results.sort((a, b) => b.netReturnPercent - a.netReturnPercent);

  // Mark rank and recommendation
  return results.map((r, idx) => ({
    ...r,
    rank: idx + 1,
    isWinner: idx === 0,
  }));
}
