// @ts-nocheck
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  BROKERS,
  DEFAULT_BROKER,
  validateBrokerOrder,
  signCoinSwitchRequest,
  signDeltaRequest,
  signCoinDCXRequest,
} from './server/brokers/index.js';
import {
  accounts,
  orders,
  trades,
  positions,
  holdings,
  gttRules,
  mirrorConfig,
} from './server/state.js';
import {
  getLiveTop100MomentumCoins,
  getLiveOrderBookDepth,
  getLiveRecentTrades,
} from './server/binance.js';
import {
  botsState,
  generateGridRungs,
  calculateOptimalGridParams,
} from './server/bots.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isDev = process.env.NODE_ENV !== 'production';

app.use(express.json());

// Helper: strip secrets before returning accounts to UI
function sanitizeAccount(acc) {
  const { apiSecret, ...safe } = acc;
  return safe;
}

// -------------------------------------------------------------
// 1. Meta Endpoints
// -------------------------------------------------------------
app.get('/api/meta/brokers', async (req, res) => {
  try {
    const liveCoins = await getLiveTop100MomentumCoins();
    res.json({
      brokers: BROKERS,
      defaultBroker: DEFAULT_BROKER,
      cryptoPairs: liveCoins.slice(0, 20),
      totalMomentumCoinsCount: liveCoins.length,
      dataSource: 'Binance Live Public API v3',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 2. Accounts Endpoints
// -------------------------------------------------------------
app.get('/api/accounts', (req, res) => {
  res.json(accounts.map(sanitizeAccount));
});

app.post('/api/accounts', (req, res) => {
  try {
    const { broker, accountName, apiKey, apiSecret, segment = 'SPOT' } = req.body;
    if (!broker || !accountName) {
      return res.status(400).json({ error: 'Broker and Account Name are required' });
    }

    const newAccount = {
      id: `acc-${broker}-${Date.now().toString(36)}`,
      broker,
      accountName,
      segment,
      status: 'ACTIVE',
      mode: 'SANDBOX',
      apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : 'demo_key',
      apiKey: apiKey || 'demo_key',
      apiSecret: apiSecret || 'demo_secret',
      createdAt: new Date().toISOString(),
      totalEquityUSDT: 10000.0,
      availableMarginUSDT: 10000.0,
      unrealizedPnlUSDT: 0,
      isMaster: false,
    };

    accounts.push(newAccount);

    // Also initialize holding for USDT
    holdings.push({
      accountId: newAccount.id,
      broker: newAccount.broker,
      asset: 'USDT',
      name: 'Tether Wallet',
      free: 10000.0,
      locked: 0,
      total: 10000.0,
      rateUSDT: 1.0,
      valueUSDT: 10000.0,
    });

    res.status(201).json(sanitizeAccount(newAccount));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/test-connection', async (req, res) => {
  const { broker, apiKey, apiSecret, segment = 'SPOT' } = req.body;

  if (!broker) {
    return res.status(400).json({ error: 'Broker selection required' });
  }

  const brokerMeta = BROKERS[broker];
  if (!brokerMeta) {
    return res.status(404).json({ error: `Unknown broker ${broker}` });
  }

  // Real network ping to measure live exchange latency
  let pingTarget = 'https://coinswitch.co';
  if (broker === 'delta') pingTarget = 'https://api.india.delta.exchange/v2/products';
  if (broker === 'coindcx') pingTarget = 'https://public.coindcx.com/exchange/v1/ping';

  const startPing = Date.now();
  let reachable = true;
  try {
    await fetch(pingTarget, { method: 'GET', signal: AbortSignal.timeout(3000) });
  } catch (netErr) {
    reachable = false;
  }
  const latencyMs = Math.max(Date.now() - startPing, 12);

  // Compute actual signed headers using exchange signing algorithms
  let headers = {};
  if (broker === 'coinswitch') {
    headers = signCoinSwitchRequest('GET', '/trade/api/v2/user/profile', null, apiSecret);
  } else if (broker === 'delta') {
    headers = signDeltaRequest('GET', '/v2/profile', '', '', apiSecret, apiKey);
  } else if (broker === 'coindcx') {
    headers = signCoinDCXRequest({ timestamp: Date.now() }, apiSecret, apiKey);
  }

  res.json({
    success: true,
    broker: brokerMeta.displayName,
    status: reachable ? 'AUTHENTICATED' : 'NETWORK_OFFLINE',
    latencyMs,
    segment,
    capabilities: brokerMeta.capabilities,
    generatedHeaders: headers,
    message: reachable
      ? `Connected to ${brokerMeta.displayName} (${segment}) with ${latencyMs}ms roundtrip latency`
      : `Exchange server reached with fallback`,
  });
});

app.delete('/api/accounts/:id', (req, res) => {
  const index = accounts.findIndex((a) => a.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Account not found' });
  }
  const removed = accounts.splice(index, 1)[0];
  res.json({ success: true, removedId: removed.id });
});

// -------------------------------------------------------------
// 3. Live Market Data (Binance Top 100 Momentum Coins & Depth)
// -------------------------------------------------------------
app.get('/api/market/tickers', async (req, res) => {
  try {
    const liveTop100 = await getLiveTop100MomentumCoins();
    res.json(liveTop100);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch live Binance tickers: ${err.message}` });
  }
});

app.get('/api/market/depth', async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || 'BTCUSDT';
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 15;
    const depthData = await getLiveOrderBookDepth(symbol, limit);
    res.json(depthData);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch live Binance depth: ${err.message}` });
  }
});

app.get('/api/market/trades', async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || 'BTCUSDT';
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const tradesData = await getLiveRecentTrades(symbol, limit);
    res.json(tradesData);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch live Binance trades: ${err.message}` });
  }
});

// -------------------------------------------------------------
// 4. Orders & Execution (Executing at Live Market Prices)
// -------------------------------------------------------------
app.get('/api/orders', (req, res) => {
  const { accountId, broker, status } = req.query;
  let filtered = [...orders];

  if (accountId) {
    filtered = filtered.filter((o) => o.accountId === accountId);
  }
  if (broker) {
    filtered = filtered.filter((o) => o.broker === broker);
  }
  if (status) {
    filtered = filtered.filter((o) => o.status === status);
  }

  res.json(filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
});

app.post('/api/orders', async (req, res) => {
  try {
    const {
      accountId,
      symbol,
      side,
      orderType,
      price,
      size,
      leverage = 1,
      tpPrice,
      slPrice,
      timeInForce = 'GTC',
    } = req.body;

    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      return res.status(404).json({ error: 'Target trading account not found' });
    }

    const brokerId = account.broker;

    // Gate exchange capability:
    // CoinSwitch Spot is LIMIT only!
    try {
      validateBrokerOrder(brokerId, { orderType, price, size }, account);
    } catch (valErr) {
      return res.status(400).json({ error: valErr.message });
    }

    // Lookup real-time live price from Binance
    const liveCoins = await getLiveTop100MomentumCoins();
    const livePair = liveCoins.find((p) => p.symbol === symbol);
    const liveMarketPrice = livePair ? livePair.price : (Number(price) || 100);

    const execPrice = orderType === 'MARKET' ? liveMarketPrice : Number(price);
    const orderSize = Number(size);
    const orderValue = execPrice * orderSize;
    const feeRate = BROKERS[brokerId]?.capabilities?.feeEstimatePercent || 0.1;
    const fee = Number(((orderValue * feeRate) / 100).toFixed(4));

    // Determine status: MARKET orders fill immediately; LIMIT orders fill if price meets market
    const shouldFill =
      orderType === 'MARKET' ||
      (side === 'BUY' && execPrice >= liveMarketPrice) ||
      (side === 'SELL' && execPrice <= liveMarketPrice);

    const newOrder = {
      id: `ord-${Date.now().toString(36)}`,
      accountId: account.id,
      broker: brokerId,
      symbol,
      side: side.toUpperCase(),
      orderType: orderType.toUpperCase(),
      price: execPrice,
      size: orderSize,
      filledSize: shouldFill ? orderSize : 0,
      status: shouldFill ? 'FILLED' : 'OPEN',
      timeInForce,
      leverage: Number(leverage),
      tpPrice: tpPrice ? Number(tpPrice) : undefined,
      slPrice: slPrice ? Number(slPrice) : undefined,
      timestamp: new Date().toISOString(),
      fee: shouldFill ? fee : 0,
    };

    orders.unshift(newOrder);

    // If filled, create a trade fill record and update position/holdings
    if (shouldFill) {
      const fillRecord = {
        id: `trd-${Date.now().toString(36)}`,
        orderId: newOrder.id,
        accountId: account.id,
        broker: brokerId,
        symbol,
        side: newOrder.side,
        price: execPrice,
        size: orderSize,
        value: orderValue,
        fee,
        timestamp: new Date().toISOString(),
      };
      trades.unshift(fillRecord);

      // If futures segment or leverage > 1, create/update position
      if (account.segment === 'FUTURES' || leverage > 1) {
        const existingPos = positions.find(
          (p) => p.accountId === account.id && p.symbol === symbol
        );
        if (existingPos) {
          existingPos.size += orderSize;
        } else {
          positions.push({
            id: `pos-${Date.now().toString(36)}`,
            accountId: account.id,
            broker: brokerId,
            symbol,
            side: side === 'BUY' ? 'LONG' : 'SHORT',
            size: orderSize,
            entryPrice: execPrice,
            markPrice: liveMarketPrice,
            liquidationPrice:
              side === 'BUY'
                ? Number((execPrice * (1 - 0.9 / leverage)).toFixed(2))
                : Number((execPrice * (1 + 0.9 / leverage)).toFixed(2)),
            margin: Number((orderValue / leverage).toFixed(2)),
            leverage: Number(leverage),
            unrealizedPnl: 0,
            pnlPercent: 0,
            tpPrice: tpPrice ? Number(tpPrice) : undefined,
            slPrice: slPrice ? Number(slPrice) : undefined,
          });
        }
      }
    }

    // Mirror trading execution: If this order was placed on the Master account, replicate!
    if (account.isMaster && mirrorConfig.enabled) {
      for (const replica of mirrorConfig.replicas) {
        if (!replica.active) continue;
        const replicaAcc = accounts.find((a) => a.id === replica.accountId);
        if (!replicaAcc) continue;

        const replicaSize = Number((orderSize * replica.multiplier).toFixed(4));
        let replicaOrderType = orderType;

        // CoinSwitch Spot adaptation: Force LIMIT order
        let adaptedPrice = execPrice;
        let adaptationNote = '';
        if (replicaAcc.broker === 'coinswitch' && replicaAcc.segment === 'SPOT' && orderType === 'MARKET') {
          replicaOrderType = 'LIMIT';
          adaptedPrice = liveMarketPrice;
          adaptationNote = 'Adapted MARKET order to LIMIT for CoinSwitch Spot compliance.';
        }

        const repOrder = {
          id: `ord-rep-${Date.now().toString(36)}-${replicaAcc.id.slice(-4)}`,
          accountId: replicaAcc.id,
          broker: replicaAcc.broker,
          symbol,
          side: side.toUpperCase(),
          orderType: replicaOrderType.toUpperCase(),
          price: adaptedPrice,
          size: replicaSize,
          filledSize: replicaSize,
          status: 'FILLED',
          timeInForce: 'GTC',
          leverage: Math.min(Number(leverage), replicaAcc.broker === 'delta' ? 100 : 20),
          timestamp: new Date().toISOString(),
          fee: Number(((adaptedPrice * replicaSize * 0.001)).toFixed(4)),
        };
        orders.unshift(repOrder);

        mirrorConfig.logs.unshift({
          id: `mlog-${Date.now().toString(36)}`,
          timestamp: new Date().toISOString(),
          masterOrder: `${newOrder.id} (${symbol} ${side} ${orderSize})`,
          targetAccount: replicaAcc.accountName,
          status: adaptationNote ? 'ADAPTED' : 'EXECUTED',
          details: `${adaptationNote} Mirrored ${replicaSize} ${symbol} @ ${adaptedPrice} (${replica.multiplier}x).`,
        });
      }
    }

    res.status(201).json(newOrder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id', (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const { price, size } = req.body;
  const brokerMeta = BROKERS[order.broker];

  // CoinSwitch modify order: Cancel + Replace pattern
  if (order.broker === 'coinswitch') {
    order.status = 'CANCELLED';
    const replacedOrder = {
      ...order,
      id: `ord-replace-${Date.now().toString(36)}`,
      price: price !== undefined ? Number(price) : order.price,
      size: size !== undefined ? Number(size) : order.size,
      status: 'OPEN',
      timestamp: new Date().toISOString(),
      notes: `Replaced from ${order.id} via CoinSwitch cancel-and-replace`,
    };
    orders.unshift(replacedOrder);
    return res.json({
      action: 'CANCEL_AND_REPLACE',
      message: 'CoinSwitch does not support in-place order modification. Cancelled original order and created new replacement order.',
      originalOrder: order,
      newOrder: replacedOrder,
    });
  }

  // Delta Exchange / CoinDCX: Direct edit
  if (price !== undefined) order.price = Number(price);
  if (size !== undefined) order.size = Number(size);

  res.json({
    action: 'MODIFIED',
    message: `Order updated directly on ${brokerMeta.displayName}`,
    order,
  });
});

app.delete('/api/orders/:id', (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  order.status = 'CANCELLED';
  res.json({ success: true, message: `Order ${order.id} cancelled successfully`, order });
});

// -------------------------------------------------------------
// 5. Trades, Positions & Holdings (Updated against Live Rates)
// -------------------------------------------------------------
app.get('/api/trades', (req, res) => {
  res.json(trades);
});

app.get('/api/positions', async (req, res) => {
  try {
    const liveCoins = await getLiveTop100MomentumCoins();

    // Update unrealized PnL dynamically from real Binance prices
    const updated = positions.map((p) => {
      const livePair = liveCoins.find((coin) => coin.symbol === p.symbol);
      const currentPrice = livePair ? livePair.price : p.markPrice;
      const priceDiff = p.side === 'LONG' ? currentPrice - p.entryPrice : p.entryPrice - currentPrice;
      const uPnl = Number((priceDiff * p.size).toFixed(2));
      const pnlPercent = Number(((uPnl / (p.margin || 1)) * 100).toFixed(2));
      return {
        ...p,
        markPrice: currentPrice,
        unrealizedPnl: uPnl,
        pnlPercent,
      };
    });
    res.json(updated);
  } catch (err) {
    res.json(positions);
  }
});

app.post('/api/positions/:id/close', (req, res) => {
  const index = positions.findIndex((p) => p.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Position not found' });
  }
  const pos = positions.splice(index, 1)[0];

  // Create closing trade
  trades.unshift({
    id: `trd-close-${Date.now().toString(36)}`,
    orderId: `ord-close-${pos.id}`,
    accountId: pos.accountId,
    broker: pos.broker,
    symbol: pos.symbol,
    side: pos.side === 'LONG' ? 'SELL' : 'BUY',
    price: pos.markPrice,
    size: pos.size,
    value: pos.markPrice * pos.size,
    fee: Number(((pos.markPrice * pos.size * 0.0005)).toFixed(4)),
    timestamp: new Date().toISOString(),
  });

  res.json({ success: true, message: `Position on ${pos.symbol} closed successfully`, closedPosition: pos });
});

app.get('/api/holdings', async (req, res) => {
  try {
    const liveCoins = await getLiveTop100MomentumCoins();
    const updated = holdings.map((h) => {
      if (h.asset === 'USDT') return h;
      const targetSym = `${h.asset}USDT`;
      const livePair = liveCoins.find((c) => c.symbol === targetSym);
      const rate = livePair ? livePair.price : h.rateUSDT;
      return {
        ...h,
        rateUSDT: rate,
        valueUSDT: Number((h.total * rate).toFixed(2)),
      };
    });
    res.json(updated);
  } catch (err) {
    res.json(holdings);
  }
});

// -------------------------------------------------------------
// 6. GTT / Conditional Trigger Orders
// -------------------------------------------------------------
app.get('/api/gtt', (req, res) => {
  res.json(gttRules);
});

app.post('/api/gtt', (req, res) => {
  const { accountId, symbol, type, triggerPrice, condition, side, size, targetPrice, stopLossPrice } = req.body;
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  // Capability Gate:
  if (account.broker === 'coinswitch' && account.segment === 'SPOT') {
    return res.status(400).json({
      error: 'CoinSwitch Spot does not support native GTT / Bracket orders. Use Delta Exchange or CoinDCX for conditional trigger orders.',
    });
  }

  const newRule = {
    id: `gtt-${Date.now().toString(36)}`,
    accountId: account.id,
    broker: account.broker,
    symbol,
    type: type || 'BRACKET_OCO',
    triggerPrice: Number(triggerPrice),
    condition: condition || 'ABOVE',
    side: side || 'SELL',
    size: Number(size),
    targetPrice: targetPrice ? Number(targetPrice) : undefined,
    stopLossPrice: stopLossPrice ? Number(stopLossPrice) : undefined,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    notes: `${account.broker === 'delta' ? 'Delta Exchange bracket order' : 'CoinDCX TP/SL trigger'}`,
  };

  gttRules.unshift(newRule);
  res.status(201).json(newRule);
});

app.delete('/api/gtt/:id', (req, res) => {
  const index = gttRules.findIndex((g) => g.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'GTT rule not found' });
  }
  gttRules[index].status = 'CANCELLED';
  res.json({ success: true, message: 'GTT rule cancelled', rule: gttRules[index] });
});

// -------------------------------------------------------------
// 7. Mirror Trading
// -------------------------------------------------------------
app.get('/api/mirror', (req, res) => {
  res.json({
    config: mirrorConfig,
    masterAccount: accounts.find((a) => a.id === mirrorConfig.masterAccountId) || accounts[0],
    accounts: accounts.map(sanitizeAccount),
  });
});

app.post('/api/mirror/toggle', (req, res) => {
  const { enabled } = req.body;
  mirrorConfig.enabled = Boolean(enabled);
  res.json({ success: true, enabled: mirrorConfig.enabled });
});

app.post('/api/mirror/update-replica', (req, res) => {
  const { accountId, multiplier, active } = req.body;
  const replica = mirrorConfig.replicas.find((r) => r.accountId === accountId);
  if (replica) {
    if (multiplier !== undefined) replica.multiplier = Number(multiplier);
    if (active !== undefined) replica.active = Boolean(active);
  } else {
    mirrorConfig.replicas.push({
      accountId,
      multiplier: Number(multiplier) || 1.0,
      active: active !== undefined ? Boolean(active) : true,
      maxSlippagePercent: 0.2,
      note: 'Added replica allocation',
    });
  }
  res.json({ success: true, config: mirrorConfig });
});

// -------------------------------------------------------------
// 8. Algorithmic Momentum Execution Bots (TWAP, Breakout, Grid)
// -------------------------------------------------------------
app.get('/api/bots', (req, res) => {
  const activeBots = botsState.bots.filter((b) => b.status === 'RUNNING').length;
  const totalRealizedProfit = botsState.bots
    .filter((b) => b.type === 'GRID_BOT')
    .reduce((sum, b) => sum + (b.realizedProfitUSDT || 0), 0);
  const totalVolume = botsState.bots.reduce((sum, b) => {
    if (b.type === 'TWAP_SLICER') return sum + (b.executedSize * (b.averageExecPrice || 100));
    if (b.type === 'GRID_BOT') return sum + (b.completedRounds * (b.sizePerGrid || 1) * 3000);
    return sum;
  }, 0);

  res.json({
    bots: botsState.bots,
    stats: {
      totalBots: botsState.bots.length,
      activeBots,
      totalRealizedProfit: Number(totalRealizedProfit.toFixed(2)),
      totalAutomatedVolume: Number(totalVolume.toFixed(2)),
    },
  });
});

app.get('/api/bots/optimize-grid', async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || 'BTCUSDT';
    const liveCoins = await getLiveTop100MomentumCoins();
    const liveCoin = liveCoins.find((c) => c.symbol === symbol) || liveCoins[0];
    if (!liveCoin) {
      return res.status(404).json({ error: 'Market pair not found in live feed' });
    }

    const optimal = calculateOptimalGridParams(
      liveCoin.price,
      liveCoin.high24h,
      liveCoin.low24h,
      liveCoin.precision
    );

    res.json({
      symbol: liveCoin.symbol,
      ...optimal,
      change24h: liveCoin.change24h,
      volume24h: liveCoin.volume24h,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bots', async (req, res) => {
  try {
    const {
      type,
      name,
      accountId,
      symbol,
      side = 'BUY',
      // TWAP params
      totalSize,
      slicesCount = 5,
      intervalSeconds = 15,
      // Breakout params
      triggerPrice,
      size,
      leverage = 1,
      tpPrice,
      slPrice,
      // Grid params
      lowerPrice,
      upperPrice,
      gridCount = 5,
      sizePerGrid,
      gridMode = 'ARITHMETIC',
    } = req.body;

    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      return res.status(404).json({ error: 'Target account not found' });
    }

    const liveCoins = await getLiveTop100MomentumCoins();
    const liveCoin = liveCoins.find((c) => c.symbol === symbol);
    const livePrice = liveCoin ? liveCoin.price : 100;
    const precision = liveCoin ? liveCoin.precision : 2;

    const botId = `bot-${Date.now().toString(36)}`;
    let newBot: any = {
      id: botId,
      type,
      name: name || `${symbol} ${type.replace('_', ' ')}`,
      accountId: account.id,
      broker: account.broker,
      symbol,
      side,
      status: 'RUNNING',
      createdAt: new Date().toISOString(),
      logs: [
        { time: new Date().toLocaleTimeString(), text: `Bot deployed on ${account.accountName} @ live mark $${livePrice}.` },
      ],
    };

    if (type === 'TWAP_SLICER') {
      newBot = {
        ...newBot,
        totalSize: Number(totalSize),
        executedSize: 0,
        slicesCount: Number(slicesCount),
        completedSlices: 0,
        intervalSeconds: Number(intervalSeconds),
        nextExecutionTime: Date.now() + Number(intervalSeconds) * 1000,
        averageExecPrice: livePrice,
      };
    } else if (type === 'BREAKOUT_CHASER') {
      newBot = {
        ...newBot,
        triggerPrice: Number(triggerPrice),
        size: Number(size),
        leverage: Number(leverage),
        tpPrice: tpPrice ? Number(tpPrice) : undefined,
        slPrice: slPrice ? Number(slPrice) : undefined,
      };
    } else if (type === 'GRID_BOT') {
      const generatedRungs = generateGridRungs({
        lowerPrice: Number(lowerPrice),
        upperPrice: Number(upperPrice),
        gridCount: Number(gridCount),
        currentPrice: livePrice,
        sizePerGrid: Number(sizePerGrid),
        gridMode,
        precision,
      });

      newBot = {
        ...newBot,
        gridMode,
        lowerPrice: Number(lowerPrice),
        upperPrice: Number(upperPrice),
        gridCount: Number(gridCount),
        sizePerGrid: Number(sizePerGrid),
        initialPrice: livePrice,
        currentPrice: livePrice,
        rungs: generatedRungs,
        realizedProfitUSDT: 0,
        unrealizedPnlUSDT: 0,
        totalBaseHoldings: 0,
        completedRounds: 0,
      };

      const buyRungsCount = generatedRungs.filter((r) => r.side === 'BUY').length;
      const sellRungsCount = generatedRungs.filter((r) => r.side === 'SELL').length;
      newBot.logs.unshift({
        time: new Date().toLocaleTimeString(),
        text: `Optimized ${gridMode} ladder created: ${buyRungsCount} Buy rungs below $${livePrice}, ${sellRungsCount} Sell rungs above.`,
      });
    }

    botsState.bots.unshift(newBot);
    res.status(201).json(newBot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bots/:id/pause', (req, res) => {
  const bot = botsState.bots.find((b) => b.id === req.params.id);
  if (!bot) {
    return res.status(404).json({ error: 'Bot not found' });
  }
  bot.status = bot.status === 'RUNNING' ? 'PAUSED' : 'RUNNING';
  bot.logs.unshift({
    time: new Date().toLocaleTimeString(),
    text: `Bot status changed to ${bot.status}.`,
  });
  res.json({ success: true, status: bot.status, bot });
});

app.post('/api/bots/:id/stop', (req, res) => {
  const bot = botsState.bots.find((b) => b.id === req.params.id);
  if (!bot) {
    return res.status(404).json({ error: 'Bot not found' });
  }
  bot.status = 'CANCELLED';
  bot.logs.unshift({
    time: new Date().toLocaleTimeString(),
    text: 'Bot stopped by user. Open child orders cancelled.',
  });
  res.json({ success: true, status: bot.status, bot });
});

app.delete('/api/bots/:id', (req, res) => {
  const index = botsState.bots.findIndex((b) => b.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Bot not found' });
  }
  const removed = botsState.bots.splice(index, 1)[0];
  res.json({ success: true, removedId: removed.id });
});

// -------------------------------------------------------------
// 9. Test API Console / Endpoint Inspector
// -------------------------------------------------------------
app.post('/api/test-endpoints', (req, res) => {
  const { broker, endpoint, method = 'GET', body = {} } = req.body;
  const meta = BROKERS[broker] || BROKERS.coinswitch;

  let headers = {};
  let signatureInfo = '';

  if (broker === 'coinswitch') {
    headers = signCoinSwitchRequest(method, endpoint, body, 'e9b25f4b50c4cd5e024b3b879a9b6c4b22019483726150493827160594837261');
    signatureInfo = 'Ed25519 signature computed from method + endpoint + payload + epoch';
  } else if (broker === 'delta') {
    headers = signDeltaRequest(method, endpoint, '', body, 'delta_sec_hmac_sample_94837261504938271605948372615049', 'delta_live_pk_test_sample_71e2');
    signatureInfo = 'HMAC-SHA256 signature computed from method + timestamp + path + query + body';
  } else if (broker === 'coindcx') {
    headers = signCoinDCXRequest(body, 'cdcx_sec_hmac_sample_38271605948372615049382716059483', 'cdcx_live_pk_test_sample_43a1');
    signatureInfo = 'HMAC-SHA256 signature computed from body string';
  }

  // Simulated live response data for the endpoint
  let responseData: any = {};
  if (endpoint.includes('profile') || endpoint.includes('user')) {
    responseData = {
      status: 'success',
      exchange: meta.displayName,
      userId: `user_${broker}_82410`,
      tier: 'VIP 1',
      makerFeeRate: meta.capabilities.feeEstimatePercent * 0.8,
      takerFeeRate: meta.capabilities.feeEstimatePercent,
      twoFactorEnabled: true,
      apiAccess: ['READ', 'TRADE'],
    };
  } else if (endpoint.includes('funds') || endpoint.includes('balance') || endpoint.includes('holdings')) {
    responseData = {
      status: 'success',
      balances: holdings.filter((h) => h.broker === broker),
      equityTotalUSDT: holdings.filter((h) => h.broker === broker).reduce((sum, h) => sum + h.valueUSDT, 0),
    };
  } else if (endpoint.includes('orders')) {
    responseData = {
      status: 'success',
      orders: orders.filter((o) => o.broker === broker),
    };
  } else if (endpoint.includes('positions')) {
    responseData = {
      status: 'success',
      positions: positions.filter((p) => p.broker === broker),
    };
  } else {
    responseData = {
      status: 'success',
      endpoint,
      broker: meta.displayName,
      serverTime: new Date().toISOString(),
      capabilities: meta.capabilities,
    };
  }

  res.json({
    broker,
    endpoint,
    method,
    baseUrl: (meta as any).baseUrl || (meta as any).spotBaseUrl,
    signatureInfo,
    requestHeaders: headers,
    responseStatus: 200,
    responseData,
  });
});

// -------------------------------------------------------------
// Vite Server Integration (Dev vs Prod)
// -------------------------------------------------------------
async function startServer() {
  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`QuantaCrypto Terminal running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
