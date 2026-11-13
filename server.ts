// @ts-nocheck
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { loadState, startPersistence } from './server/persist.js';
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
import { checkMargin, settleOrderFill, reserveOrder, releaseOrder, reserveAmounts } from './server/positions.js';
import { feePct as feeFor, feeRates, executionCost, slippageConfig } from './server/costs.js';
import { shouldMirror, mirrorFilledOrder } from './server/mirror.js';
import { halalMarket, isHalalSymbol } from './server/halal.js';
import {
  feedStatus,
  getLiveTop100MomentumCoins,
  getLivePriceIndex,
  getCachedTop100,
  applyTickerUpdate,
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
  qslScale,
  checkGridSpacing,
  calculateOptimalGridParams,
} from './server/bots.js';
import {
  simulateGridBot,
  optimizeGridStrategies,
} from './server/backtest.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// Behind Render/Docker proxies every client shares the proxy's IP unless we trust X-Forwarded-For,
// which would put the whole world into ONE rate-limit bucket. TRUST_PROXY=<hops> overrides the default.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? 1 : 0)));
app.use(helmet({ contentSecurityPolicy: false })); // CSP off: Vite dev injects inline scripts
app.use(express.json({ limit: '100kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MIN) || 600, standardHeaders: true, legacyHeaders: false }));

// Optional shared-secret auth. Set API_TOKEN to require `Authorization: Bearer <token>`
// (or `x-api-token`) on every /api request. Strongly recommended whenever HOST is not loopback.
const API_TOKEN = process.env.API_TOKEN || '';
function tokenOk(supplied: string) {
  if (!API_TOKEN) return true;
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(API_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
// Health check for Render/Docker; registered before the auth middleware so probes work without a token
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'quanta-crypto', time: new Date().toISOString() });
});
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next();
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const supplied = bearer || (req.headers['x-api-token'] as string) || '';
  if (tokenOk(supplied)) return next();
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

/** TP/SL sanity: they must be positive numbers on the profit/loss side of the entry. Returns an error string or null. */
function checkTpSl(side: string, entry: number, tp: any, sl: any): string | null {
  const has = (v) => v !== undefined && v !== null && v !== '';
  if (has(tp) && !isPositiveNumber(tp)) return 'tpPrice must be a positive number';
  if (has(sl) && !isPositiveNumber(sl)) return 'slPrice must be a positive number';
  const long = side === 'BUY';
  if (has(tp) && (long ? Number(tp) <= entry : Number(tp) >= entry)) return `For a ${side} order the take-profit must be ${long ? 'above' : 'below'} the entry price ${entry}`;
  if (has(sl) && (long ? Number(sl) >= entry : Number(sl) <= entry)) return `For a ${side} order the stop-loss must be ${long ? 'below' : 'above'} the entry price ${entry}`;
  return null;
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
    if (segment !== 'SPOT') {
      return res.status(400).json({ error: 'Segment must be SPOT (spot trading only)' });
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
  for (const o of orders) if (o.accountId === removed.id && o.status === 'OPEN') { releaseOrder(removed, o); o.status = 'CANCELLED'; o.notes = 'Account removed'; }
  [positions, holdings, gttRules].forEach(drop);
  for (const b of botsState.bots) if (b.accountId === removed.id && (b.status === 'RUNNING' || b.status === 'PAUSED')) { b.status = 'CANCELLED'; releaseBotSymbol(b); }
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

// Halal-screened coins that have a live USDT pair (the whole list, not just the top-100 movers)
app.get('/api/halal/coins', async (_req, res) => {
  try {
    res.json(halalMarket(await getLivePriceIndex()));
  } catch (err) {
    res.status(502).json({ error: process.env.NODE_ENV !== 'production' ? `Live market feed unavailable: ${(err as Error).message}` : 'Live market feed unavailable' });
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
    if (!Number.isFinite(leverage) || leverage !== 1) {
      return res.status(400).json({ error: 'leverage must be 1 (spot trading only)' });
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
    const livePair = (await getLivePriceIndex()).get(symbol);
    if (!livePair) {
      return res.status(400).json({ error: `No live price for ${symbol}; it is not a liquid Binance USDT pair.` });
    }
    const liveMarketPrice = livePair.price;
    const execPrice = orderType === 'MARKET' ? liveMarketPrice : num(req.body.price);
    const tpSlError = checkTpSl(side, execPrice, tpPrice, slPrice);
    if (tpSlError) return res.status(400).json({ error: tpSlError });
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
      // Taker: crosses the book, so the price slips against the order (more for bigger orders) and the taker fee applies
      const ex = executionCost({ broker: brokerId, side, refPrice: liveMarketPrice, size, quoteVolume: livePair.quoteVolume });
      // A marketable limit order never fills worse than its own limit price
      const fillPrice = orderType === 'LIMIT' ? (side === 'BUY' ? Math.min(ex.price, execPrice) : Math.max(ex.price, execPrice)) : ex.price;
      const check = checkMargin(account, newOrder, fillPrice, ex.feePct);
      if (!check.ok) {
        return res.status(400).json({
          error: check.reason,
        });
      }
      settleOrderFill(account, newOrder, fillPrice, ex.feePct, { liquidity: 'TAKER', slippagePct: ex.slippagePct, refPrice: liveMarketPrice });
      newOrder.price = execPrice;
    } else {
      // Resting maker order: it must be fully fundable now, and the funds are locked until it fills or is cancelled
      const makerFee = feeFor(brokerId, 'MAKER');
      const check = checkMargin(account, newOrder, execPrice, makerFee);
      if (!check.ok) return res.status(400).json({ error: check.reason });
      newOrder.liquidity = 'MAKER';
    }

    orders.unshift(newOrder);
    if (orders.length > 10000) orders.length = 10000;
    // Reserve after the order is in the book so the wallet's locked balance counts it
    if (newOrder.status === 'OPEN') reserveOrder(account, newOrder, execPrice, feeFor(brokerId, 'MAKER'));

    // Mirror trading: replicate only master orders that actually filled
    if (shouldMirror(account, newOrder)) mirrorFilledOrder(account, newOrder, liveMarketPrice, { quoteVolume: livePair.quoteVolume });

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

  // Re-validate the edited order the same way as a new one
  if (order.orderType !== 'LIMIT') return res.status(409).json({ error: 'Only resting LIMIT orders can be modified.' });
  const account = accounts.find((a) => a.id === order.accountId);
  if (!account) return res.status(404).json({ error: 'Order account not found' });
  const newPrice = price !== undefined ? num(price) : order.price;
  const newSize = size !== undefined ? num(size) : order.size;
  const tpSlErr = checkTpSl(order.side, newPrice, order.tpPrice, order.slPrice);
  if (tpSlErr) return res.status(400).json({ error: tpSlErr });
  // Free the old reservation so the edit is checked against what the order could use, then lock the new amount
  const makerFee = feeFor(order.broker, 'MAKER');
  const held = releaseOrder(account, order);
  const fundCheck = checkMargin(account, { ...order, price: newPrice, size: newSize }, newPrice, makerFee);
  if (!fundCheck.ok) {
    reserveAmounts(account, order, held.usdt, held.base); // edit refused: put the old reservation back
    return res.status(400).json({ error: fundCheck.reason });
  }

  // CoinSwitch modify order: Cancel + Replace pattern
  if (order.broker === 'coinswitch') {
    order.status = 'CANCELLED';
    const replacedOrder = {
      ...order,
      id: uid('ord-replace'),
      price: newPrice,
      size: newSize,
      status: 'OPEN',
      reservedUSDT: 0,
      reservedBase: 0,
      timestamp: new Date().toISOString(),
      notes: `Replaced from ${order.id} via CoinSwitch cancel-and-replace`,
    };
    orders.unshift(replacedOrder);
    reserveOrder(account, replacedOrder, newPrice, makerFee);
    return res.json({
      action: 'CANCEL_AND_REPLACE',
      message: 'CoinSwitch does not support in-place order modification. Cancelled original order and created new replacement order.',
      originalOrder: order,
      newOrder: replacedOrder,
    });
  }

  order.price = newPrice;
  order.size = newSize;
  reserveOrder(account, order, newPrice, makerFee);
  res.json({ action: 'MODIFIED', message: `Order updated on ${brokerMeta.displayName}`, order });
});

app.delete('/api/orders/:id', (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'OPEN') {
    return res.status(409).json({ error: `Only OPEN orders can be cancelled (this order is ${order.status}).` });
  }
  const acct = accounts.find((a) => a.id === order.accountId);
  if (acct) releaseOrder(acct, order); // give the reserved funds back
  order.status = 'CANCELLED';
  res.json({ success: true, message: `Order ${order.id} cancelled successfully`, order });
});

// -------------------------------------------------------------
// 5. Trades, Positions & Holdings (Updated against Live Rates)
// -------------------------------------------------------------
// Execution-cost model in force (fees per broker, slippage) so the UI can show it
app.get('/api/costs', (_req, res) => {
  res.json({
    fees: Object.fromEntries(Object.keys(BROKERS).map((b) => [b, feeRates(b)])),
    slippage: slippageConfig(),
  });
});

app.get('/api/trades', (req, res) => {
  res.json(trades);
});

app.get('/api/positions', async (req, res) => {
  try {
    const liveCoins = await getLivePriceIndex();

    // Update unrealized PnL dynamically from real Binance prices
    const updated = positions.map((p) => {
      const livePair = liveCoins.get(p.symbol);
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
  let quoteVolume;
  try {
    const live = (await getLivePriceIndex()).get(pos.symbol);
    if (live) { price = live.price; quoteVolume = live.quoteVolume; }
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
  const ex = executionCost({ broker: pos.broker, side: closing.side, refPrice: price, size: pos.size, quoteVolume });
  const trade = settleOrderFill(account, closing, ex.price, ex.feePct, { liquidity: 'TAKER', slippagePct: ex.slippagePct, refPrice: price });
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
    const liveCoins = await getLivePriceIndex();
    const updated = holdings.map((h) => {
      if (h.asset === 'USDT') return h;
      const targetSym = `${h.asset}USDT`;
      const livePair = liveCoins.get(targetSym);
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
  if (condition !== undefined && !['ABOVE', 'BELOW'].includes(condition)) return res.status(400).json({ error: 'condition must be ABOVE or BELOW' });
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
    masterAccount: sanitizeAccount(accounts.find((a) => a.id === mirrorConfig.masterAccountId) || accounts[0]),
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
    const liveCoin = (await getLivePriceIndex()).get(symbol);
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
      // DCA params
      dcaIntervalSeconds,
      dcaAmountPerInterval,
      dcaTotalAmount,
      // Time-based exit
      timeExitHours,
      // Grid params
      lowerPrice,
      upperPrice,
      gridCount = 5,
      sizePerGrid,
      gridMode = 'ARITHMETIC',
      // QSL params
      levelsEachSide,
      triggerLevel,
      halalOnly,
      // Risk limits (grid / QSL): all optional
      maxInventory,
      stopLossPrice,
      takeProfitPrice,
      // Risk management (spot only): drawdown, profit target, trailing stop
      maxDailyDrawdownPercent,
      dailyProfitTargetPercent,
      trailingStopPercent,
    } = req.body;

    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      return res.status(404).json({ error: 'Target account not found' });
    }
    // HALAL_ONLY is always enforced — only halal-screened coins can be traded
    if (!isHalalSymbol(String(symbol || ''))) {
      return res.status(400).json({ error: `${symbol} is not on the halal coin list` });
    }
    if (!['TWAP_SLICER', 'BREAKOUT_CHASER', 'GRID_BOT', 'QSL', 'DCA_ACCUMULATOR'].includes(type)) {
      return res.status(400).json({ error: 'type must be TWAP_SLICER, BREAKOUT_CHASER, GRID_BOT, QSL or DCA_ACCUMULATOR' });
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
    if (type === 'BREAKOUT_CHASER') {
      const e = checkTpSl(String(side).toUpperCase(), Number(triggerPrice), tpPrice, slPrice);
      if (e) return res.status(400).json({ error: e });
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
    if (type === 'DCA_ACCUMULATOR') {
      if (!(isPositiveNumber(dcaTotalAmount) && isPositiveNumber(dcaAmountPerInterval) && Number.isInteger(num(dcaIntervalSeconds)) && num(dcaIntervalSeconds) >= 60)) {
        return res.status(400).json({ error: 'DCA needs positive dcaTotalAmount, dcaAmountPerInterval and integer dcaIntervalSeconds >= 60' });
      }
      if (Number(dcaAmountPerInterval) > Number(dcaTotalAmount)) {
        return res.status(400).json({ error: 'DCA dcaAmountPerInterval cannot exceed dcaTotalAmount' });
      }
    }

    const liveCoin = (await getLivePriceIndex()).get(symbol);
    if (!liveCoin) {
      return res.status(400).json({ error: `No live price for ${symbol}; it is not a liquid Binance USDT pair.` });
    }
    const livePrice = liveCoin.price;
    const precision = liveCoin.precision;
    const botFeePct = BROKERS[account.broker]?.capabilities?.feeEstimatePercent ?? 0.1;

    // A breakout trigger must lie ahead of the market, otherwise the bot fires on its first cycle
    if (type === 'BREAKOUT_CHASER') {
      const sd = String(side).toUpperCase();
      if (sd === 'BUY' && Number(triggerPrice) <= livePrice) return res.status(400).json({ error: `A BUY breakout trigger must be above the current price ${livePrice}` });
      if (sd === 'SELL' && Number(triggerPrice) >= livePrice) return res.status(400).json({ error: `A SELL breakout trigger must be below the current price ${livePrice}` });
    }
    if (type === 'GRID_BOT' || type === 'QSL') {
      const has = (v) => v !== undefined && v !== null && v !== '';
      if (has(maxInventory) && !isPositiveNumber(maxInventory)) return res.status(400).json({ error: 'maxInventory must be a positive number' });
      if (has(stopLossPrice) && !isPositiveNumber(stopLossPrice)) return res.status(400).json({ error: 'stopLossPrice must be a positive number' });
      if (has(takeProfitPrice) && !isPositiveNumber(takeProfitPrice)) return res.status(400).json({ error: 'takeProfitPrice must be a positive number' });
      const floor = type === 'GRID_BOT' ? Number(lowerPrice) : livePrice;
      const ceil = type === 'GRID_BOT' ? Number(upperPrice) : livePrice;
      if (has(stopLossPrice) && Number(stopLossPrice) >= floor) return res.status(400).json({ error: `stopLossPrice must be below ${type === 'GRID_BOT' ? 'the grid lower price' : 'the current price'} ${floor}` });
      if (has(takeProfitPrice) && Number(takeProfitPrice) <= ceil) return res.status(400).json({ error: `takeProfitPrice must be above ${type === 'GRID_BOT' ? 'the grid upper price' : 'the current price'} ${ceil}` });
    }
    if (type === 'GRID_BOT') {
      const spacingErr = checkGridSpacing({ lowerPrice, upperPrice, gridCount, gridMode, feePercent: botFeePct });
      if (spacingErr) return res.status(400).json({ error: spacingErr });
    }

    // Risk limits (grid/QSL). Inventory cap: grids are naturally bounded by their buy rungs; QSL recentres
    // downward, so it defaults to two sides' worth of levels unless the caller picks a cap.
    const riskLimits: any = {};
    if (type === 'GRID_BOT' || type === 'QSL') {
      const natural = type === 'GRID_BOT' ? Number(gridCount) * Number(sizePerGrid) : Number(levelsEachSide) * 2 * Number(sizePerGrid);
      riskLimits.maxInventory = isPositiveNumber(maxInventory) ? Number(maxInventory) : Number(natural.toFixed(8));
      if (isPositiveNumber(stopLossPrice)) riskLimits.stopLossPrice = Number(stopLossPrice);
      if (isPositiveNumber(takeProfitPrice)) riskLimits.takeProfitPrice = Number(takeProfitPrice);
    }
    // Drawdown / profit target / trailing stop apply to all bot types
    if (isPositiveNumber(maxDailyDrawdownPercent)) riskLimits.maxDailyDrawdownPercent = Number(maxDailyDrawdownPercent);
    if (isPositiveNumber(dailyProfitTargetPercent)) riskLimits.dailyProfitTargetPercent = Number(dailyProfitTargetPercent);
    if (isPositiveNumber(trailingStopPercent)) riskLimits.trailingStopPercent = Number(trailingStopPercent);

    // Correlation filter: block concurrent bots on highly correlated pairs
    const CORRELATION_GROUPS = [
      ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT'],
    ];
    const baseSymbol = symbol.replace(/USDT$/, '');
    const correlatedGroup = CORRELATION_GROUPS.find((g) => g.includes(symbol));
    if (correlatedGroup) {
      const conflicting = botsState.bots.some((b) =>
        b.status === 'RUNNING' &&
        b.accountId === accountId &&
        correlatedGroup.includes(b.symbol) &&
        b.id !== botId
      );
      if (conflicting) {
        return res.status(400).json({ error: `Cannot run ${symbol} bot: a ${correlatedGroup.filter((s) => s !== symbol).join(', ')} bot is already running on this account (correlated pairs blocked)` });
      }
    }

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
      ...riskLimits,
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
        leverage: 1,
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
      const scale = qslScale(livePrice, botFeePct);
      const generatedLevels = generateSquareLevels({
        centerNumber: scale.baseNumber,
        levelsEachSide: levelsEachSideNum,
        currentPrice: livePrice,
        multiplier: scale.multiplier,
        sizePerGrid: Number(sizePerGrid),
        precision,
        stride: scale.stride,
      });

      newBot = {
        ...newBot,
        levelsEachSide: levelsEachSideNum,
        triggerLevel: triggerLevelNum,
        sizePerGrid: Number(sizePerGrid),
        initialPrice: livePrice,
        currentPrice: livePrice,
        baseNumber: scale.baseNumber,
        multiplier: scale.multiplier,
        decimalPlaces: scale.decimals,
        stride: scale.stride,
        levelSpacingPercent: scale.spacingPct,
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
    } else if (type === 'DCA_ACCUMULATOR') {
      newBot = {
        ...newBot,
        totalSize: Number(dcaTotalAmount),
        executedSize: 0,
        intervalSeconds: Number(dcaIntervalSeconds),
        amountPerInterval: Number(dcaAmountPerInterval),
        nextExecutionTime: Date.now() + Number(dcaIntervalSeconds) * 1000,
        averageExecPrice: livePrice,
      };
      newBot.logs.unshift({
        time: new Date().toLocaleTimeString(),
        text: `DCA accumulator created: buy $${Number(dcaAmountPerInterval)} ${symbol} every ${Number(dcaIntervalSeconds)}s until $${Number(dcaTotalAmount)} reached @ live mark $${livePrice}.`,
      });
    }

    // Time-based exit: stop bot after N hours
    if (isPositiveNumber(timeExitHours)) {
      newBot.timeExitAt = Date.now() + Number(timeExitHours) * 60 * 60 * 1000;
      newBot.timeExitHours = Number(timeExitHours);
      newBot.logs.unshift({
        time: new Date().toLocaleTimeString(),
        text: `Time-based exit set: bot will stop after ${Number(timeExitHours)} hour(s) (at ${new Date(Date.now() + Number(timeExitHours) * 60 * 60 * 1000).toLocaleTimeString()}).`,
      });
    }

    botsState.bots.unshift(newBot);

    // Track symbol subscription for WS auto-unsubscribe on delete
    trackBotSymbol(newBot);

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
  releaseBotSymbol(removed);

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
      makerFeeRate: feeRates(broker).maker,
      takerFeeRate: feeRates(broker).taker,
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
const MAX_WS_CLIENTS = Number(process.env.MAX_WS_CLIENTS) || 100;
const symbolBotCounts = new Map<string, number>();

/** Count a bot against its symbol's websocket subscription (once per bot). */
function trackBotSymbol(bot) {
  if (bot._wsCounted) return;
  bot._wsCounted = true;
  const sym = String(bot.symbol).toUpperCase();
  symbolBotCounts.set(sym, (symbolBotCounts.get(sym) || 0) + 1);
}
/** Release a bot's subscription count; unsubscribe the stream when no bot needs it. */
function releaseBotSymbol(bot) {
  if (!bot._wsCounted) return;
  bot._wsCounted = false;
  const sym = String(bot.symbol).toUpperCase();
  const left = (symbolBotCounts.get(sym) || 1) - 1;
  if (left > 0) { symbolBotCounts.set(sym, left); return; }
  symbolBotCounts.delete(sym);
  unsubscribeBinanceWs(sym);
}
/** Bots that stopped, completed, errored or lost their account no longer hold a subscription. */
function releaseFinishedBotSymbols() {
  for (const b of botsState.bots) if (b._wsCounted && b.status !== 'RUNNING' && b.status !== 'PAUSED') releaseBotSymbol(b);
}

function broadcast(message: any) {
  const payload = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch { /* ignore send errors */ }
    }
  }
}

const WS_SYMBOL_RE = /^[A-Z0-9]{5,12}$/;
const MAX_WS_SYMBOLS = 50;
function ensureBinanceWs(symbol: string) {
  const sym = String(symbol).toUpperCase();
  if (!WS_SYMBOL_RE.test(sym)) return;
  if (binanceWsBySymbol.has(sym)) return;
  if (binanceWsBySymbol.size >= MAX_WS_SYMBOLS) return;
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

        applyTickerUpdate(data.s, priceUpdate);

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
    // Binance blocked (HTTP 451 / network errors): fall back to OKX in production
    if (process.env.NODE_ENV === 'production' && subscribedSymbols.has(sym)) ensureOkxWs(sym);
  };
}

// -------------------------------------------------------------
// OKX WebSocket fallback (one shared connection) for when Binance streams are blocked (HTTP 451)
// -------------------------------------------------------------
let okxWs: WebSocket | null = null;
let okxConnecting = false;
const okxSubscribedSymbols = new Set<string>();
const okxInstId = (s: string) => (s.endsWith('USDT') ? `${s.slice(0, -4)}-USDT` : s);
const okxSymbol = (instId: string) => instId.replace('-', '');

function sendOkxSubscribe() {
  if (!okxWs || okxWs.readyState !== WebSocket.OPEN || okxSubscribedSymbols.size === 0) return;
  okxWs.send(JSON.stringify({ op: 'subscribe', args: [...okxSubscribedSymbols].map((s) => ({ channel: 'tickers', instId: okxInstId(s) })) }));
}

function ensureOkxWs(symbol: string) {
  okxSubscribedSymbols.add(symbol.toUpperCase());
  if (okxWs && okxWs.readyState === WebSocket.OPEN) return sendOkxSubscribe();
  if (okxConnecting || (okxWs && okxWs.readyState === WebSocket.CONNECTING)) return;
  okxConnecting = true;
  const ows = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
  okxWs = ows;
  ows.onopen = () => { okxConnecting = false; console.log('[WS] OKX ticker connected'); sendOkxSubscribe(); };
  ows.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.arg?.channel !== 'tickers' || !Array.isArray(msg.data)) return;
      for (const t of msg.data) {
        const sym = okxSymbol(t.instId);
        const last = parseFloat(t.last);
        const open24h = parseFloat(t.open24h || '0');
        const update = {
          symbol: sym, price: last,
          change24h: Number((open24h > 0 ? ((last - open24h) / open24h) * 100 : 0).toFixed(2)),
          high24h: parseFloat(t.high24h || last), low24h: parseFloat(t.low24h || last),
          volume: parseFloat(t.vol24h || '0'), quoteVolume: parseFloat(t.volCcy24h || '0'),
          bidPrice: parseFloat(t.bidPx || last), askPrice: parseFloat(t.askPx || last),
          timestamp: parseFloat(t.ts || Date.now()), source: 'ws-okx',
        };
        applyTickerUpdate(sym, update);
        broadcast({ type: 'ticker', data: update });
      }
    } catch { /* ignore malformed messages */ }
  };
  ows.onclose = () => {
    okxConnecting = false;
    if (okxWs === ows) okxWs = null;
    if (okxSubscribedSymbols.size > 0) setTimeout(() => { const syms = [...okxSubscribedSymbols]; okxSubscribedSymbols.clear(); syms.forEach(ensureOkxWs); }, 3000);
  };
  ows.onerror = (err) => console.error('[WS] OKX ticker error:', (err as Error).message);
}

function unsubscribeOkxWs(symbol: string) {
  okxSubscribedSymbols.delete(symbol.toUpperCase());
  if (okxSubscribedSymbols.size === 0 && okxWs) { okxWs.close(); okxWs = null; }
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
  unsubscribeOkxWs(sym);
}

// Unknown /api routes and malformed JSON should return JSON, not the SPA page or an HTML stack trace
app.use('/api', (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 400 ? 'Malformed request body' : process.env.NODE_ENV !== 'production' ? err.message || 'Internal error' : 'Internal error' });
});

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

  if (process.env.STATE_FILE) {
    const restored = loadState(process.env.STATE_FILE);
    for (const b of botsState.bots) if (b.status === 'RUNNING' || b.status === 'PAUSED') { b._wsCounted = false; trackBotSymbol(b); }
    const flush = startPersistence(process.env.STATE_FILE);
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { flush(); process.exit(0); });
    console.log(`[persist] ${restored ? 'restored state from' : 'writing state to'} ${process.env.STATE_FILE}`);
  }
  startBotLoop();
  setInterval(releaseFinishedBotSymbols, 5000).unref();
  // Containers (Render/Docker) must listen on all interfaces; local dev stays on loopback
  const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !API_TOKEN) {
    throw new Error('Refusing to start on a non-loopback address without API_TOKEN set. The trading API would be unauthenticated.');
  }
  const server = app.listen(PORT, HOST, () => {
    console.log(`QuantaCrypto Terminal (paper trading) running at http://${HOST}:${PORT}`);
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 16 * 1024, // subscribe messages are tiny; refuse anything big
    // The /api auth middleware does not cover upgrades, so check the token here (?token=...).
    verifyClient: (info, done) => {
      if (!API_TOKEN) return done(true);
      const token = new URL(info.req.url || '', 'http://x').searchParams.get('token') || '';
      return tokenOk(token) ? done(true) : done(false, 401, 'Unauthorized');
    },
  });

  wss.on('connection', (ws: WebSocket) => {
    if (wsClients.size >= MAX_WS_CLIENTS) { ws.close(1013, 'Server busy'); return; }
    wsClients.add(ws);

    ws.send(JSON.stringify({
      type: 'snapshot',
      data: getCachedTop100(),
      count: getCachedTop100().length,
    }));

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'subscribe' && typeof msg.symbol === 'string' && WS_SYMBOL_RE.test(msg.symbol.toUpperCase())) {
          subscribedSymbols.add(msg.symbol.toUpperCase());
          ensureBinanceWs(msg.symbol.toUpperCase());
          ws.send(JSON.stringify({
            type: 'subscribed',
            symbol: msg.symbol.toUpperCase(),
          }));
        } else if (msg.type === 'subscribe_batch' && Array.isArray(msg.symbols)) {
          for (const sym of msg.symbols.slice(0, MAX_WS_SYMBOLS)) {
            if (typeof sym !== 'string' || !WS_SYMBOL_RE.test(sym.toUpperCase())) continue;
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

if (!process.env.QUANTA_TEST) startServer();
