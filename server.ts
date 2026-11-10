// @ts-nocheck
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
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
import { uid, mask, isPositiveNumber } from './server/util.js';
import { checkMargin, settleOrderFill } from './server/positions.js';
import {
  feedStatus,
  getLiveTop100MomentumCoins,
  getLiveOrderBookDepth,
  getLiveRecentTrades,
  getLiveKlines,
} from './server/binance.js';
import {
  botsState,
  startBotLoop,
  seedGridInventory,
  generateGridRungs,
  generateSquareLevels,
  f_decimalPlaces,
  f_naturalNumber,
  calculateOptimalGridParams,
} from './server/bots.js';
import {
  simulateGridBot,
  optimizeGridStrategies,
} from './server/backtest.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

app.use(express.json({ limit: '100kb' }));

// Optional shared-secret auth. Set API_TOKEN to require `Authorization: Bearer <token>`
// (or `x-api-token`) on every /api request. Strongly recommended whenever HOST is not loopback.
const API_TOKEN = process.env.API_TOKEN || '';
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next();
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const supplied = bearer || (req.headers['x-api-token'] as string) || '';
  if (supplied === API_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// Helper: never return credentials to the UI (only the masked key)
function sanitizeAccount(acc) {
  const { apiSecret, apiKey, ...safe } = acc;
  return { ...safe, hasCredentials: Boolean(apiKey && apiSecret) };
}

const num = (v) => Number(v);
const VALID_SIDES = new Set(['BUY', 'SELL']);
const VALID_ORDER_TYPES = new Set(['MARKET', 'LIMIT']);

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
      feedStale: feedStatus.stale,
      feedLastError: feedStatus.lastError,
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
    const { broker, accountName, apiKey = '', apiSecret = '', segment = 'SPOT' } = req.body;
    if (!broker || !accountName) {
      return res.status(400).json({ error: 'Broker and Account Name are required' });
    }
    if (!BROKERS[broker]) {
      return res.status(400).json({ error: `Unknown broker ${broker}` });
    }
    if (!['SPOT', 'FUTURES'].includes(segment)) {
      return res.status(400).json({ error: 'Segment must be SPOT or FUTURES' });
    }

    const newAccount = {
      id: uid(`acc-${broker}`),
      broker,
      accountName: String(accountName).slice(0, 60),
      segment,
      status: 'ACTIVE',
      mode: 'PAPER', // orders are simulated; nothing is sent to the exchange
      apiKeyMasked: apiKey ? mask(apiKey) : 'Not configured',
      apiKey,
      apiSecret,
      createdAt: new Date().toISOString(),
      totalEquityUSDT: 10000.0,
      availableMarginUSDT: 10000.0,
      unrealizedPnlUSDT: 0,
      isMaster: false,
    };

    accounts.push(newAccount);
    holdings.push({
      accountId: newAccount.id,
      broker: newAccount.broker,
      asset: 'USDT',
      name: 'Paper USDT balance',
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
  const { accountId, segment: bodySegment } = req.body;
  const stored = accountId ? accounts.find((a) => a.id === accountId) : null;
  const broker = stored?.broker || req.body.broker;
  const apiKey = stored?.apiKey ?? req.body.apiKey ?? '';
  const apiSecret = stored?.apiSecret ?? req.body.apiSecret ?? '';
  const segment = stored?.segment || bodySegment || 'SPOT';

  if (!broker) {
    return res.status(400).json({ error: 'Broker selection required' });
  }
  const brokerMeta = BROKERS[broker];
  if (!brokerMeta) {
    return res.status(404).json({ error: `Unknown broker ${broker}` });
  }

  // 1) Network reachability of the exchange (public endpoint)
  let pingTarget = 'https://coinswitch.co';
  if (broker === 'delta') pingTarget = 'https://api.india.delta.exchange/v2/products';
  if (broker === 'coindcx') pingTarget = 'https://public.coindcx.com/exchange/v1/ping';

  const startPing = Date.now();
  let reachable = true;
  try {
    await fetch(pingTarget, { method: 'GET', signal: AbortSignal.timeout(3000) });
  } catch {
    reachable = false;
  }
  const latencyMs = Date.now() - startPing;

  // 2) Check that a request can be signed with the stored credentials (does NOT call the exchange)
  const credentialsPresent = Boolean(apiKey && apiSecret);
  let headers = {};
  let signingOk = false;
  if (credentialsPresent) {
    try {
      if (broker === 'coinswitch') headers = signCoinSwitchRequest('GET', '/trade/api/v2/user/profile', null, apiSecret);
      else if (broker === 'delta') headers = signDeltaRequest('GET', '/v2/profile', '', '', apiSecret, apiKey);
      else if (broker === 'coindcx') headers = signCoinDCXRequest({ timestamp: Date.now() }, apiSecret, apiKey);
      signingOk = true;
    } catch {
      signingOk = false;
    }
  }
  // Never echo real signatures back to the browser
  const redactedHeaders = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, /sig/i.test(k) || /key/i.test(k) ? '[redacted]' : v])
  );

  const status = !reachable ? 'NETWORK_OFFLINE' : !credentialsPresent ? 'NO_CREDENTIALS' : signingOk ? 'REACHABLE_KEYS_UNVERIFIED' : 'SIGNING_FAILED';
  res.json({
    success: reachable && credentialsPresent && signingOk,
    broker: brokerMeta.displayName,
    status,
    latencyMs,
    segment,
    capabilities: brokerMeta.capabilities,
    generatedHeaders: redactedHeaders,
    verified: false,
    message: !reachable
      ? `${brokerMeta.displayName} is not reachable from this server.`
      : !credentialsPresent
      ? 'Exchange reachable, but no API key/secret is configured for this account.'
      : 'Exchange reachable and a request can be signed with the stored keys. Keys are NOT verified: this app does not make authenticated exchange calls (paper trading only).',
  });
});

app.delete('/api/accounts/:id', (req, res) => {
  const index = accounts.findIndex((a) => a.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Account not found' });
  }
  const removed = accounts.splice(index, 1)[0];
  if (removed.isMaster) {
    accounts.splice(index, 0, removed);
    return res.status(409).json({ error: 'The master account cannot be removed while mirror trading references it.' });
  }
  // Remove everything that referenced the account
  const drop = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i].accountId === removed.id) arr.splice(i, 1); };
  [positions, holdings, gttRules].forEach(drop);
  for (const b of botsState.bots) if (b.accountId === removed.id && b.status === 'RUNNING') b.status = 'CANCELLED';
  mirrorConfig.replicas = mirrorConfig.replicas.filter((r) => r.accountId !== removed.id);
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

app.get('/api/market/klines', async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || 'BTCUSDT';
    const interval = (req.query.interval as string) || '1h';
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
    const klines = await getLiveKlines(symbol, interval, limit);
    res.json(klines);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch live Binance klines: ${err.message}` });
  }
});

// -------------------------------------------------------------
// Backtesting & Strategy Optimization Endpoints (100% Real Binance Data)
// -------------------------------------------------------------
app.post('/api/backtest/grid', async (req, res) => {
  try {
    const {
      symbol = 'BTCUSDT',
      interval = '1h',
      limit = 300,
      initialCapital = 1000,
      lowerPrice,
      upperPrice,
      gridCount = 10,
      gridMode = 'ARITHMETIC',
      feeRate = 0.0005,
    } = req.body;

    const klines = await getLiveKlines(symbol, interval, limit);
    if (!klines || klines.length < 5) {
      return res.status(400).json({ error: 'Insufficient live Binance candles returned' });
    }

    const result = simulateGridBot({
      symbol,
      klines,
      initialCapital,
      lowerPrice,
      upperPrice,
      gridCount,
      gridMode,
      feeRate,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backtest/optimize', async (req, res) => {
  try {
    const {
      symbol = 'BTCUSDT',
      interval = '1h',
      limit = 300,
      initialCapital = 1000,
    } = req.body;

    const klines = await getLiveKlines(symbol, interval, limit);
    if (!klines || klines.length < 5) {
      return res.status(400).json({ error: 'Insufficient live Binance candles returned' });
    }

    const strategies = optimizeGridStrategies({
      symbol,
      klines,
      initialCapital,
    });

    res.json({
      symbol,
      interval,
      candlesTested: klines.length,
      startPrice: klines[0].open,
      endPrice: klines[klines.length - 1].close,
      strategies,
      winner: strategies.find((s) => s.isWinner) || strategies[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const { accountId, symbol, tpPrice, slPrice, timeInForce = 'GTC' } = req.body;
    const side = String(req.body.side || '').toUpperCase();
    const orderType = String(req.body.orderType || '').toUpperCase();
    const leverage = req.body.leverage === undefined ? 1 : num(req.body.leverage);
    const size = num(req.body.size);

    const account = accounts.find((a) => a.id === accountId);
    if (!account) return res.status(404).json({ error: 'Target trading account not found' });
    if (!symbol || typeof symbol !== 'string') return res.status(400).json({ error: 'symbol is required' });
    if (!VALID_SIDES.has(side)) return res.status(400).json({ error: 'side must be BUY or SELL' });
    if (!VALID_ORDER_TYPES.has(orderType)) return res.status(400).json({ error: 'orderType must be MARKET or LIMIT' });
    if (!isPositiveNumber(size)) return res.status(400).json({ error: 'size must be a positive number' });
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > 125) {
      return res.status(400).json({ error: 'leverage must be between 1 and 125' });
    }
    if (orderType === 'LIMIT' && !isPositiveNumber(req.body.price)) {
      return res.status(400).json({ error: 'A positive limit price is required for LIMIT orders' });
    }

    const brokerId = account.broker;
    // CoinSwitch Spot is LIMIT only
    try {
      validateBrokerOrder(brokerId, { orderType, price: req.body.price, size }, account);
    } catch (valErr) {
      return res.status(400).json({ error: valErr.message });
    }

    // Live reference price. Unknown symbols are rejected rather than filled at a made-up price.
    const liveCoins = await getLiveTop100MomentumCoins();
    const livePair = liveCoins.find((p) => p.symbol === symbol);
    if (!livePair) {
      return res.status(400).json({ error: `No live price for ${symbol}; it is not in the tracked Binance top-100 USDT list.` });
    }
    const liveMarketPrice = livePair.price;
    const execPrice = orderType === 'MARKET' ? liveMarketPrice : num(req.body.price);
    const feePct = BROKERS[brokerId]?.capabilities?.feeEstimatePercent ?? 0.1;

    const newOrder: any = {
      id: uid('ord'),
      accountId: account.id,
      broker: brokerId,
      symbol,
      side,
      orderType,
      price: execPrice,
      size,
      filledSize: 0,
      status: 'OPEN',
      timeInForce,
      leverage,
      tpPrice: tpPrice ? num(tpPrice) : undefined,
      slPrice: slPrice ? num(slPrice) : undefined,
      timestamp: new Date().toISOString(),
      fee: 0,
    };

    // Marketable now? (MARKET, or a limit that crosses the book). Resting limits are filled
    // later by the background engine when the live price reaches them.
    const shouldFill =
      orderType === 'MARKET' ||
      (side === 'BUY' && execPrice >= liveMarketPrice) ||
      (side === 'SELL' && execPrice <= liveMarketPrice);

    if (shouldFill) {
      const check = checkMargin(account, newOrder, execPrice, feePct);
      if (!check.ok) {
        return res.status(400).json({
          error: check.reason,
        });
      }
      // A marketable limit order fills at the market, not at its (better-for-the-broker) limit
      settleOrderFill(account, newOrder, orderType === 'MARKET' ? execPrice : liveMarketPrice, feePct);
      newOrder.price = execPrice;
    }

    orders.unshift(newOrder);
    if (orders.length > 10000) orders.length = 10000;

    // Mirror trading: replicate only master orders that actually filled
    if (account.isMaster && mirrorConfig.enabled && newOrder.status === 'FILLED') {
      for (const replica of mirrorConfig.replicas) {
        if (!replica.active || replica.accountId === account.id) continue;
        const replicaAcc = accounts.find((a) => a.id === replica.accountId);
        if (!replicaAcc) continue;

        const replicaSize = Number((size * replica.multiplier).toFixed(8));
        const logBase = { id: uid('mlog'), timestamp: new Date().toISOString(), masterOrder: `${newOrder.id} (${symbol} ${side} ${size})`, targetAccount: replicaAcc.accountName };
        if (!isPositiveNumber(replicaSize)) {
          mirrorConfig.logs.unshift({ ...logBase, status: 'SKIPPED', details: 'Replica size rounded to zero.' });
          continue;
        }

        let replicaOrderType = orderType;
        let adaptationNote = '';
        if (replicaAcc.broker === 'coinswitch' && replicaAcc.segment === 'SPOT' && orderType === 'MARKET') {
          replicaOrderType = 'LIMIT';
          adaptationNote = 'Adapted MARKET order to LIMIT for CoinSwitch Spot compliance.';
        }
        const replicaLev = Math.min(leverage, replicaAcc.broker === 'delta' ? 100 : 20);
        const repOrder: any = {
          id: uid('ord-rep'),
          accountId: replicaAcc.id,
          broker: replicaAcc.broker,
          symbol,
          side,
          orderType: replicaOrderType,
          price: liveMarketPrice,
          size: replicaSize,
          filledSize: 0,
          status: 'OPEN',
          timeInForce: 'GTC',
          leverage: replicaLev,
          timestamp: new Date().toISOString(),
          fee: 0,
          notes: `Mirror of ${newOrder.id}`,
        };

        // Note: replicas fill at the same simulated reference price as the master, so there is no
        // slippage to enforce; maxSlippagePercent is kept in the config for a future live mode.
        const check = checkMargin(replicaAcc, repOrder, liveMarketPrice, BROKERS[replicaAcc.broker]?.capabilities?.feeEstimatePercent ?? 0.1);
        if (!check.ok) {
          mirrorConfig.logs.unshift({ ...logBase, status: 'REJECTED', details: check.reason });
          continue;
        }
        settleOrderFill(replicaAcc, repOrder, liveMarketPrice, BROKERS[replicaAcc.broker]?.capabilities?.feeEstimatePercent ?? 0.1);
        orders.unshift(repOrder);
        mirrorConfig.logs.unshift({
          ...logBase,
          status: adaptationNote ? 'ADAPTED' : 'EXECUTED',
          details: `${adaptationNote} Mirrored ${replicaSize} ${symbol} @ ${liveMarketPrice} (${replica.multiplier}x).`.trim(),
        });
      }
      if (mirrorConfig.logs.length > 500) mirrorConfig.logs.length = 500;
    }

    res.status(201).json(newOrder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id', (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'OPEN') {
    return res.status(409).json({ error: `Only OPEN orders can be modified (this order is ${order.status}).` });
  }

  const { price, size } = req.body;
  if (price !== undefined && !isPositiveNumber(price)) return res.status(400).json({ error: 'price must be a positive number' });
  if (size !== undefined && !isPositiveNumber(size)) return res.status(400).json({ error: 'size must be a positive number' });
  const brokerMeta = BROKERS[order.broker];

  // CoinSwitch modify order: Cancel + Replace pattern
  if (order.broker === 'coinswitch') {
    order.status = 'CANCELLED';
    const replacedOrder = {
      ...order,
      id: uid('ord-replace'),
      price: price !== undefined ? num(price) : order.price,
      size: size !== undefined ? num(size) : order.size,
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

  if (price !== undefined) order.price = num(price);
  if (size !== undefined) order.size = num(size);
  res.json({ action: 'MODIFIED', message: `Order updated on ${brokerMeta.displayName}`, order });
});

app.delete('/api/orders/:id', (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'OPEN') {
    return res.status(409).json({ error: `Only OPEN orders can be cancelled (this order is ${order.status}).` });
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

app.post('/api/positions/:id/close', async (req, res) => {
  const pos = positions.find((p) => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: 'Position not found' });
  const account = accounts.find((a) => a.id === pos.accountId);
  if (!account) return res.status(404).json({ error: 'Position account not found' });

  let price = pos.markPrice;
  try {
    const live = (await getLiveTop100MomentumCoins()).find((c) => c.symbol === pos.symbol);
    if (live) price = live.price;
  } catch {
    /* fall back to last stored mark price */
  }

  const closing: any = {
    id: uid('ord-close'),
    accountId: pos.accountId,
    broker: pos.broker,
    symbol: pos.symbol,
    side: pos.side === 'LONG' ? 'SELL' : 'BUY',
    orderType: 'MARKET',
    price,
    size: pos.size,
    leverage: pos.leverage,
    timeInForce: 'IOC',
    timestamp: new Date().toISOString(),
  };
  const closedSnapshot = { ...pos };
  const trade = settleOrderFill(account, closing, price, BROKERS[pos.broker]?.capabilities?.feeEstimatePercent ?? 0.1);
  orders.unshift(closing);

  res.json({
    success: true,
    message: `Position on ${pos.symbol} closed at ${price}. Realised PnL: ${trade.realizedPnl} USDT`,
    closedPosition: closedSnapshot,
    realizedPnl: trade.realizedPnl,
  });
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

  if (!symbol || !VALID_SIDES.has(String(side || 'SELL').toUpperCase())) {
    return res.status(400).json({ error: 'symbol and a valid side (BUY/SELL) are required' });
  }
  if (!isPositiveNumber(size)) return res.status(400).json({ error: 'size must be a positive number' });
  if (!isPositiveNumber(triggerPrice) && !isPositiveNumber(targetPrice) && !isPositiveNumber(stopLossPrice)) {
    return res.status(400).json({ error: 'Provide a triggerPrice, targetPrice or stopLossPrice' });
  }

  const newRule = {
    id: uid('gtt'),
    accountId: account.id,
    broker: account.broker,
    symbol,
    type: type || 'BRACKET_OCO',
    triggerPrice: isPositiveNumber(triggerPrice) ? Number(triggerPrice) : undefined,
    condition: condition || 'ABOVE',
    side: String(side || 'SELL').toUpperCase(),
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
  if (gttRules[index].status !== 'ACTIVE') {
    return res.status(409).json({ error: `Rule is already ${gttRules[index].status}` });
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
  if (!accounts.some((a) => a.id === accountId)) return res.status(404).json({ error: 'Account not found' });
  if (accountId === mirrorConfig.masterAccountId) return res.status(400).json({ error: 'The master account cannot be a replica' });
  if (multiplier !== undefined && !(Number(multiplier) > 0 && Number(multiplier) <= 100)) {
    return res.status(400).json({ error: 'multiplier must be between 0 and 100' });
  }
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
    .filter((b) => b.type === 'GRID_BOT' || b.type === 'QSL')
    .reduce((sum, b) => sum + (b.realizedProfitUSDT || 0), 0);
  const totalVolume = botsState.bots.reduce((sum, b) => {
    if (b.type === 'TWAP_SLICER') return sum + (b.executedSize * (b.averageExecPrice || 100));
    if (b.type === 'GRID_BOT' || b.type === 'QSL') return sum + (b.volumeUSDT || 0);
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
      // QSL params
      levelsEachSide,
      triggerLevel,
    } = req.body;

    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      return res.status(404).json({ error: 'Target account not found' });
    }
    if (!['TWAP_SLICER', 'BREAKOUT_CHASER', 'GRID_BOT', 'QSL'].includes(type)) {
      return res.status(400).json({ error: 'type must be TWAP_SLICER, BREAKOUT_CHASER, GRID_BOT or QSL' });
    }
    if (!VALID_SIDES.has(String(side).toUpperCase())) {
      return res.status(400).json({ error: 'side must be BUY or SELL' });
    }
    if (type === 'TWAP_SLICER' && !(isPositiveNumber(totalSize) && Number.isInteger(num(slicesCount)) && num(slicesCount) >= 1 && isPositiveNumber(intervalSeconds))) {
      return res.status(400).json({ error: 'TWAP needs positive totalSize, intervalSeconds and an integer slicesCount >= 1' });
    }
    if (type === 'BREAKOUT_CHASER' && !(isPositiveNumber(triggerPrice) && isPositiveNumber(size))) {
      return res.status(400).json({ error: 'Breakout needs positive triggerPrice and size' });
    }
    if (type === 'GRID_BOT') {
      if (!(isPositiveNumber(lowerPrice) && num(upperPrice) > num(lowerPrice))) {
        return res.status(400).json({ error: 'Grid needs 0 < lowerPrice < upperPrice' });
      }
      if (!(Number.isInteger(num(gridCount)) && num(gridCount) >= 2 && num(gridCount) <= 200) || !isPositiveNumber(sizePerGrid)) {
        return res.status(400).json({ error: 'Grid needs an integer gridCount between 2 and 200 and a positive sizePerGrid' });
      }
    }
    if (type === 'QSL') {
      if (!(Number.isInteger(num(levelsEachSide)) && num(levelsEachSide) >= 1 && num(levelsEachSide) <= 20)) {
        return res.status(400).json({ error: 'QSL needs an integer levelsEachSide between 1 and 20' });
      }
      if (!(Number.isInteger(num(triggerLevel)) && num(triggerLevel) >= 1 && num(triggerLevel) <= 5)) {
        return res.status(400).json({ error: 'QSL needs an integer triggerLevel between 1 and 5' });
      }
      if (!isPositiveNumber(sizePerGrid)) {
        return res.status(400).json({ error: 'QSL needs a positive sizePerGrid' });
      }
    }

    const liveCoins = await getLiveTop100MomentumCoins();
    const liveCoin = liveCoins.find((c) => c.symbol === symbol);
    if (!liveCoin) {
      return res.status(400).json({ error: `No live price for ${symbol}; it is not in the tracked Binance top-100 USDT list.` });
    }
    const livePrice = liveCoin.price;
    const precision = liveCoin.precision;

    const botId = uid('bot');
    let newBot: any = {
      id: botId,
      type,
      name: name || `${symbol} ${type.replace('_', ' ')}`,
      accountId: account.id,
      broker: account.broker,
      symbol,
      side: String(side).toUpperCase(),
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

      const seed = seedGridInventory(newBot, account, livePrice);
      if (!seed.ok) {
        return res.status(400).json({ error: `Cannot fund grid starting inventory: ${seed.reason}` });
      }
      const seeded = seed.qty;
      const buyRungsCount = generatedRungs.filter((r) => r.side === 'BUY').length;
      const sellRungsCount = generatedRungs.filter((r) => r.side === 'SELL').length;
      newBot.logs.unshift({
        time: new Date().toLocaleTimeString(),
        text: `${gridMode} ladder created: ${buyRungsCount} Buy rungs below $${livePrice}, ${sellRungsCount} Sell rungs above (starting inventory of ${seeded} ${symbol} bought at market).`,
      });
    } else if (type === 'QSL') {
      const levelsEachSideNum = Number(levelsEachSide);
      const triggerLevelNum = Number(triggerLevel);
      const generatedLevels = generateSquareLevels({
        centerNumber: f_naturalNumber(livePrice),
        levelsEachSide: levelsEachSideNum,
        currentPrice: livePrice,
        multiplier: Math.pow(10, f_decimalPlaces(livePrice)),
        sizePerGrid: Number(sizePerGrid),
        precision,
      });

      newBot = {
        ...newBot,
        levelsEachSide: levelsEachSideNum,
        triggerLevel: triggerLevelNum,
        sizePerGrid: Number(sizePerGrid),
        initialPrice: livePrice,
        currentPrice: livePrice,
        baseNumber: f_naturalNumber(livePrice),
        multiplier: Math.pow(10, f_decimalPlaces(livePrice)),
        decimalPlaces: f_decimalPlaces(livePrice),
        rungs: generatedLevels,
        levels: generatedLevels,
        realizedProfitUSDT: 0,
        unrealizedPnlUSDT: 0,
        totalBaseHoldings: 0,
        completedRounds: 0,
        volumeUSDT: 0,
      };

      const buyLevelsCount = generatedLevels.filter((r) => r.side === 'BUY').length;
      const sellLevelsCount = generatedLevels.filter((r) => r.side === 'SELL').length;

      const qslSeed = seedGridInventory(newBot, account, livePrice);
      if (!qslSeed.ok) {
        return res.status(400).json({ error: `Cannot fund QSL starting inventory: ${qslSeed.reason}` });
      }
      const qslSeeded = qslSeed.qty;
      newBot.logs.unshift({
        time: new Date().toLocaleTimeString(),
        text: `QSL square ladder created: base #${newBot.baseNumber}, ${buyLevelsCount} Buy levels below $${livePrice}, ${sellLevelsCount} Sell levels above (seeded ${qslSeeded} ${symbol} @ $${livePrice}, size ${sizePerGrid} per level).`,
      });
    }

    botsState.bots.unshift(newBot);

    // Track symbol subscription for WS auto-unsubscribe on delete
    const sym = String(symbol).toUpperCase();
    symbolBotCounts.set(sym, (symbolBotCounts.get(sym) || 0) + 1);

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
  if (bot.status !== 'RUNNING' && bot.status !== 'PAUSED') {
    return res.status(409).json({ error: `A ${bot.status} bot cannot be paused or resumed.` });
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
  if (bot.status === 'CANCELLED' || bot.status === 'COMPLETED') {
    return res.status(409).json({ error: `Bot is already ${bot.status}.` });
  }
  bot.status = 'CANCELLED';
  bot.logs.unshift({
    time: new Date().toLocaleTimeString(),
    text: 'Bot stopped by user. No further simulated fills will occur; fills already made are kept.',
  });
  res.json({ success: true, status: bot.status, bot });
});

app.delete('/api/bots/:id', (req, res) => {
  const index = botsState.bots.findIndex((b) => b.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Bot not found' });
  }
  const removed = botsState.bots.splice(index, 1)[0];

  // Decrement symbol subscription and auto-unsubscribe WS when no bots remain
  const sym = String(removed.symbol).toUpperCase();
  const current = symbolBotCounts.get(sym) || 0;
  if (current > 0) {
    symbolBotCounts.set(sym, current - 1);
    if (current - 1 === 0) {
      symbolBotCounts.delete(sym);
      unsubscribeBinanceWs(sym);
    }
  }

  res.json({ success: true, removedId: removed.id });
});

// -------------------------------------------------------------
// 9. Test API Console / Endpoint Inspector
// -------------------------------------------------------------
app.post('/api/test-endpoints', (req, res) => {
  const { broker, endpoint, method = 'GET', body = {} } = req.body;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
    return res.status(400).json({ error: 'endpoint must be a string starting with /' });
  }
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(String(method).toUpperCase())) {
    return res.status(400).json({ error: 'method must be GET, POST, PUT or DELETE' });
  }
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
    simulated: true, // nothing is sent to the exchange; headers use built-in sample keys
    responseStatus: 200,
    responseData,
  });
});

// -------------------------------------------------------------
// Vite Server Integration (Dev vs Prod)
// -------------------------------------------------------------
// -------------------------------------------------------------
// WebSocket server state (module-level so bot routes can access it)
// -------------------------------------------------------------
const subscribedSymbols = new Set<string>();
const binanceWsBySymbol = new Map<string, WebSocket>();
const wsClients = new Set<WebSocket>();
const symbolBotCounts = new Map<string, number>();

function broadcast(message: any) {
  const payload = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch { /* ignore send errors */ }
    }
  }
}

function ensureBinanceWs(symbol: string) {
  const sym = symbol.toUpperCase();
  if (binanceWsBySymbol.has(sym)) return;
  const wsUrl = `wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@ticker`;
  const bws = new WebSocket(wsUrl);
  binanceWsBySymbol.set(sym, bws);

  bws.onopen = () => {
    console.log(`[WS] Binance ticker connected: ${sym}`);
  };

  bws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string);
      if (data.e === '24hrTicker') {
        const priceUpdate = {
          symbol: data.s,
          price: parseFloat(data.c),
          change24h: parseFloat(data.P),
          high24h: parseFloat(data.h),
          low24h: parseFloat(data.l),
          volume: parseFloat(data.v),
          quoteVolume: parseFloat(data.q),
          count: parseFloat(data.n),
          weightedAvgPrice: parseFloat(data.w),
          bidPrice: parseFloat(data.b),
          askPrice: parseFloat(data.a),
          timestamp: data.E,
          source: 'ws',
        };

        const idx = cachedTop100.findIndex((c) => c.symbol === data.s);
        if (idx >= 0) {
          cachedTop100[idx] = {
            ...cachedTop100[idx],
            ...priceUpdate,
            lastUpdate: Date.now(),
          };
        }

        broadcast({ type: 'ticker', data: priceUpdate });
      }
    } catch {
      // ignore malformed messages
    }
  };

  bws.onclose = () => {
    binanceWsBySymbol.delete(sym);
    if (subscribedSymbols.has(sym)) {
      setTimeout(() => ensureBinanceWs(sym), 3000);
    }
  };

  bws.onerror = (err) => {
    console.error(`[WS] Binance ticker error for ${sym}:`, (err as Error).message);
  };
}

function unsubscribeBinanceWs(symbol: string) {
  const sym = symbol.toUpperCase();
  subscribedSymbols.delete(sym);
  const count = symbolBotCounts.get(sym) || 0;
  if (count > 0) return; // still needed by bots
  const bws = binanceWsBySymbol.get(sym);
  if (bws) {
    bws.close();
    binanceWsBySymbol.delete(sym);
    console.log(`[WS] Binance ticker unsubscribed: ${sym}`);
  }
}

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

  startBotLoop();
  const HOST = process.env.HOST || '127.0.0.1';
  const server = app.listen(PORT, HOST, () => {
    console.log(`QuantaCrypto Terminal (paper trading) running at http://${HOST}:${PORT}`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !API_TOKEN) {
      console.warn('WARNING: listening on a non-loopback address without API_TOKEN set. The API is unauthenticated.');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    wsClients.add(ws);

    ws.send(JSON.stringify({
      type: 'snapshot',
      data: cachedTop100,
      count: cachedTop100.length,
    }));

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'subscribe' && msg.symbol) {
          subscribedSymbols.add(msg.symbol.toUpperCase());
          ensureBinanceWs(msg.symbol.toUpperCase());
          ws.send(JSON.stringify({
            type: 'subscribed',
            symbol: msg.symbol.toUpperCase(),
          }));
        } else if (msg.type === 'subscribe_batch' && Array.isArray(msg.symbols)) {
          for (const sym of msg.symbols) {
            subscribedSymbols.add(sym.toUpperCase());
            ensureBinanceWs(sym.toUpperCase());
          }
          ws.send(JSON.stringify({
            type: 'subscribed_batch',
            count: msg.symbols.length,
          }));
        } else if (msg.type === 'unsubscribe' && msg.symbol) {
          subscribedSymbols.delete(msg.symbol.toUpperCase());
        }
      } catch {
        // ignore malformed client messages
      }
    };

    ws.onclose = () => {
      wsClients.delete(ws);
    };
  });
}

startServer();
