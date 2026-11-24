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
import { loadSeedAccounts, mergeSeedCredentials, DEFAULT_ACCOUNTS_FILE } from './server/security/accounts.js';
import {
  BROKERS,
  DEFAULT_BROKER,
  validateBrokerOrder,
  signCoinSwitchRequest,
  signDeltaRequest,
  signCoinDCXRequest,
} from './server/brokers/index.js';
import type { ExecutionAdapter } from './server/execution/types.js';
import { BinanceAdapter } from './server/execution/binance.js';
import { CoinSwitchAdapter } from './server/execution/coinswitch.js';
import { DeltaAdapter } from './server/execution/delta.js';
import { CoindcxAdapter } from './server/execution/coindcx.js';
import {
  accounts,
  orders,
  trades,
  positions,
  holdings,
  mirrorConfig,
} from './server/state.js';
import { uid, mask, isPositiveNumber } from './server/util.js';
import { checkMargin, settleOrderFill, reserveOrder, releaseOrder, reserveAmounts, findOrderForEvent } from './server/positions.js';
import { feePct as feeFor, feeRates, executionCost, slippageConfig } from './server/costs.js';
import { shouldMirror, mirrorFilledOrder } from './server/mirror.js';
import { halalMarket, isHalalSymbol } from './server/halal.js';
import { startPoller, mirrorMasterOrder } from './server/poller.js';
import {
  isEmergencyStopActive,
  activateEmergencyStop,
  deactivateEmergencyStop,
  getEmergencyStopStatus,
  cancelAllOpenOrders,
  reconcileOrders,
  checkExposureLimits,
  getExposureLimits,
  setExposureLimits,
  accountExposureUSDT,
  accountOpenOrderCount,
  normalizeStatus,
} from './server/safety.js';
import {
  feedStatus,
  getLiveTop100MomentumCoins,
  getLivePriceIndex,
  getCachedTop100,
  applyTickerUpdate,
  startPriceFeed,
  subscribeSymbol,
  unsubscribeSymbol,
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
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 6000;
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// Behind Render/Docker proxies every client shares the proxy's IP unless we trust X-Forwarded-For,
// which would put the whole world into ONE rate-limit bucket. TRUST_PROXY=<hops> overrides the default.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? 1 : 0)));
// CSP is relaxed only in dev (Vite injects inline scripts + HMR websocket); production gets a strict policy.
app.use(helmet({
  contentSecurityPolicy: isDev ? false : {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"], // React inline style attributes
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'", 'ws:', 'wss:'],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
    },
  },
}));
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

// Return stored credentials for runtime use (signing, test-connection).
// Keys are stored plaintext in data/accounts.json (local-only use).
function accountCredentials(account) {
  if (!account) return { apiKey: '', apiSecret: '' };
  return {
    apiKey: account.apiKey || '',
    apiSecret: account.apiSecret || '',
  };
}

/** Apply a real exchange fill event to local orders/trades/positions state. */
function applyRealFill(account, event) {
  const order = findOrderForEvent(orders, account.id, event);
  if (!order) {
    // Not an order this app placed: if it is on the master (phone/portal), copy it to the replicas.
    void mirrorExternalMasterOrder(account, event);
    return;
  }

  const prevFilled = Number(order.filledSize || 0);
  const newFilled = Number(event.filledSize || 0);
  const incremental = newFilled - prevFilled;
  if (incremental <= 0) return; // already processed

  const fillPrice = Number(event.fillPrice || order.price || 0);
  const feePct = feeFor(account.broker, 'TAKER');
  const value = fillPrice * incremental;
  const fee = Number(((value * feePct) / 100).toFixed(4));

  // Update order
  order.filledSize = newFilled;
  order.fillPrice = fillPrice;
  order.fee = Number((Number(order.fee || 0) + fee).toFixed(4));
  order.status = newFilled >= Number(order.size) ? 'FILLED' : 'PARTIALLY_FILLED';

  // Update account balance (fee + notional)
  account.availableMarginUSDT = Number((account.availableMarginUSDT - fee).toFixed(6));
  account.totalEquityUSDT = Number((account.totalEquityUSDT - fee).toFixed(6));

  const asset = String(order.symbol).replace(/\/USDT$/, '').replace(/USDT$/, '');
  let sellAvgCost = 0;

  if (order.side === 'BUY') {
    account.availableMarginUSDT = Number(Math.max(account.availableMarginUSDT - value, 0).toFixed(6));
    let h = holdings.find((h) => h.accountId === account.id && h.asset === asset);
    if (!h) {
      h = { accountId: account.id, broker: account.broker, asset, name: asset, free: 0, locked: 0, total: 0, rateUSDT: 0, valueUSDT: 0, avgCost: 0 };
      holdings.push(h);
    }
    h.avgCost = (h.avgCost * h.total + value) / (h.total + incremental);
    h.total = Number((h.total + incremental).toFixed(10));
    h.free = Number((h.free + incremental).toFixed(10));
    h.rateUSDT = fillPrice;
    h.valueUSDT = Number((h.total * fillPrice).toFixed(2));
  } else {
    // SELL
    let h = holdings.find((h) => h.accountId === account.id && h.asset === asset);
    if (!h || Number(h.total) < incremental) {
      // Selling an asset we don't hold: credit only the fee-adjusted proceeds, no position update
      account.availableMarginUSDT = Number((account.availableMarginUSDT + value).toFixed(6));
      account.totalEquityUSDT = Number((account.totalEquityUSDT).toFixed(6));
    } else {
      sellAvgCost = Number(h.avgCost || 0);
      account.availableMarginUSDT = Number((account.availableMarginUSDT + value).toFixed(6));
      const pnl = (fillPrice - sellAvgCost) * incremental;
      account.totalEquityUSDT = Number((account.totalEquityUSDT + pnl).toFixed(6));
      h.total = Number((h.total - incremental).toFixed(10));
      h.free = Number(Math.max(h.total - h.locked, 0).toFixed(10));
      h.rateUSDT = fillPrice;
      h.valueUSDT = Number((h.total * fillPrice).toFixed(2));
      if (h.total <= 1e-9) {
        const idx = holdings.indexOf(h);
        if (idx >= 0) holdings.splice(idx, 1);
      }
    }
  }

  syncUsdtHolding(account);
  syncBaseHolding(account, asset);

  // Write trade record
  const trade = {
    id: uid('trd'),
    orderId: order.id,
    exchangeOrderId: event.orderId,
    accountId: account.id,
    broker: account.broker,
    symbol: order.symbol,
    side: order.side,
    price: fillPrice,
    size: incremental,
    value,
    fee,
    liquidity: 'TAKER',
    slippagePct: Number(event.slippagePct || 0),
    realizedPnl: order.side === 'SELL' ? Number(((fillPrice - sellAvgCost) * incremental).toFixed(4)) : 0,
    timestamp: event.timestamp || new Date().toISOString(),
  };
  trades.unshift(trade);

  // Mirroring of REAL master orders happens when the order is placed (see mirrorMasterOrder), not here,
  // so replicas get the same order type at the same time instead of a simulated copy after the fill.
}

/** Orders mirrored from fill events, so repeated partial-fill events don't re-trigger. */
const externalMirrored = new Set<string>();

/** A fill arrived for an order this app doesn't know: it was placed on the exchange side (phone/portal).
 *  Look up its real type/size/price and mirror it. MARKET orders and instantly-filled limit orders
 *  never rest in the open-orders list, so this is the only way to see them. */
async function mirrorExternalMasterOrder(account, event) {
  try {
    if (!(account.isMaster && account.mode === 'REAL' && mirrorConfig.enabled)) return;
    if (!(Number(event.filledSize) > 0) || !event.orderId || event.orderId === 'undefined') return;
    const key = `${account.id}:${event.orderId}`;
    if (externalMirrored.has(key)) return;
    externalMirrored.add(key);
    if (externalMirrored.size > 5000) externalMirrored.delete(externalMirrored.values().next().value as string);

    const adapter = getRealAdapter(account);
    if (!adapter) return;
    let o;
    try {
      o = await adapter.getOrder(account.id, String(event.orderId), event.symbol);
    } catch (err) {
      externalMirrored.delete(key); // let the next fill event retry
      console.warn(`[mirror] could not look up master order ${event.orderId}:`, (err as Error).message);
      return;
    }
    await mirrorMasterOrder(account, {
      orderId: String(o.orderId || event.orderId),
      symbol: o.symbol || event.symbol,
      side: o.side || event.side,
      type: o.type,
      size: o.size,
      price: o.type === 'LIMIT' ? o.price : undefined,
      status: o.status,
    });
  } catch (err) {
    console.warn('[mirror] external master order mirroring failed:', (err as Error).message);
  }
}

// Per-account real execution adapters (created lazily, credentials decrypted in-memory only).
const realAdapters = new Map<string, CoinSwitchAdapter | BinanceAdapter>();

// Balance sync dedup + TTL cache: prevents duplicate getAccountInfo calls within the TTL window.
const balanceInflight = new Map<string, Promise<any>>();
const balanceCache = new Map<string, { data: any; ts: number }>();
const BALANCE_TTL_MS = 30_000;

// Broker → adapter class map. Each adapter receives decrypted credentials and is wired with onFill.
const ADAPTER_CLASSES: Record<string, new (acct: ExecutionAccountLike) => ExecutionAdapter> = {
  coinswitch: CoinSwitchAdapter,
  binance: BinanceAdapter,
  delta: DeltaAdapter,
  coindcx: CoindcxAdapter,
};

type ExecutionAccountLike = {
  id: string;
  broker: string;
  apiKey: string;
  apiSecret: string;
  segment?: string;
  exchange?: string;
};

function createRealAdapter(account: { id: string; broker: string; apiKey: string; apiSecret: string; segment?: string; exchange?: string }, { onDisconnect }: { onDisconnect?: (accountId: string) => void } = {}): ExecutionAdapter | undefined {
  const AdapterClass = ADAPTER_CLASSES[account.broker];
  if (!AdapterClass) return undefined;
  const adapter = new AdapterClass({
    id: account.id,
    broker: account.broker,
    apiKey: account.apiKey,
    apiSecret: account.apiSecret,
    segment: account.segment,
    exchange: account.exchange,
    onDisconnect,
  });
  adapter.onFill((ev) => applyRealFill(account, ev));
  return adapter;
}

/** WS fill resilience: when the CoinSwitch WS disconnects, reconcile local orders
 *  against the exchange to catch any fills that were missed while the socket was down.
 *  Delegates to the shared reconcileOrders() helper instead of reimplementing the
 *  open-order vs local-order comparison and terminal-status marking. */
async function syncFillsAfterDisconnect(account) {
  await reconcileOrders();
}

function getRealAdapter(account): CoinSwitchAdapter | BinanceAdapter | undefined {
  let adapter = realAdapters.get(account.id) as CoinSwitchAdapter | BinanceAdapter | undefined;
  if (!adapter) {
    const creds = accountCredentials(account);
    if (!creds.apiKey || !creds.apiSecret) return undefined;
    adapter = createRealAdapter({ id: account.id, broker: account.broker, apiKey: creds.apiKey, apiSecret: creds.apiSecret, segment: account.segment, exchange: account.exchange }, {
      onDisconnect: (aid) => {
        const acct = accounts.find((a) => a.id === aid);
        if (acct) syncFillsAfterDisconnect(acct);
      },
    });
    if (adapter) realAdapters.set(account.id, adapter);
  }
  return adapter;
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
    const { broker, accountName, apiKey = '', apiSecret = '', segment = 'SPOT', mode = 'PAPER' } = req.body;
    if (!broker || !accountName) {
      return res.status(400).json({ error: 'Broker and Account Name are required' });
    }
    if (!BROKERS[broker]) {
      return res.status(400).json({ error: `Unknown broker ${broker}` });
    }
    if (segment !== 'SPOT') {
      return res.status(400).json({ error: 'Segment must be SPOT (spot trading only)' });
    }
    if (mode === 'REAL' && (!apiKey || !apiSecret)) {
      return res.status(400).json({ error: 'REAL-mode accounts require both apiKey and apiSecret.' });
    }

    const newAccount = {
      id: uid(`acc-${broker}`),
      broker,
      accountName: String(accountName).slice(0, 60),
      segment,
      status: 'ACTIVE',
      mode: 'PAPER',
      apiKeyMasked: apiKey ? mask(apiKey) : 'Not configured',
      apiKey,
      apiSecret,
      createdAt: new Date().toISOString(),
      totalEquityUSDT: 10000.0,
      availableMarginUSDT: 10000.0,
      unrealizedPnlUSDT: 0,
      isMaster: Boolean(req.body.isMaster),
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

app.patch('/api/accounts/:id/mode', async (req, res) => {
  const { mode } = req.body;
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  if (!mode || !['PAPER', 'REAL'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'PAPER' or 'REAL'" });
  }

  if (mode === 'REAL') {
    if (!account.apiKey || !account.apiSecret) {
      return res.status(400).json({ error: 'REAL mode requires both apiKey and apiSecret on the account.' });
    }
    if (account.apiKey.startsWith('REPLACE_WITH') || account.apiSecret.startsWith('REPLACE_WITH')) {
      return res.status(400).json({ error: 'REAL mode requires real API credentials, not placeholders.' });
    }
  }

  if (mode === 'PAPER' && account.mode === 'REAL' &&
      orders.some((o) => o.accountId === account.id && o.mode === 'REAL' && o.status === 'OPEN')) {
    return res.status(409).json({ error: 'This account has open live orders on the exchange. Cancel them before switching to PAPER.' });
  }

  const prevMode = account.mode;
  account.mode = mode;
  // Fill events only flow while the user stream is connected, and it is otherwise connected at startup only.
  const adapter = getRealAdapter(account);
  if (adapter) {
    try {
      if (mode === 'REAL' && !adapter.isConnected(account.id)) await adapter.connectUserStream(account.id);
      if (mode === 'PAPER' && prevMode === 'REAL') await adapter.disconnectUserStream(account.id);
    } catch (err) {
      console.warn(`[stream] mode switch stream change failed for ${account.accountName}:`, (err as Error).message);
    }
  }
  res.json({
    success: true,
    accountId: account.id,
    accountName: account.accountName,
    previousMode: prevMode,
    currentMode: account.mode,
  });
});

app.post('/api/accounts/test-connection', async (req, res) => {
  const { accountId, segment: bodySegment } = req.body;
  const stored = accountId ? accounts.find((a) => a.id === accountId) : null;
  const broker = stored?.broker || req.body.broker;
  const creds = stored ? accountCredentials(stored) : { apiKey: '', apiSecret: '' };
  const apiKey = (creds.apiKey || req.body.apiKey) ?? '';
  const apiSecret = (creds.apiSecret || req.body.apiSecret) ?? '';
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
  [positions, holdings].forEach(drop);
  for (const b of botsState.bots) if (b.accountId === removed.id && (b.status === 'RUNNING' || b.status === 'PAUSED')) { b.status = 'CANCELLED'; releaseBotSymbol(b); }
  mirrorConfig.replicas = mirrorConfig.replicas.filter((r) => r.accountId !== removed.id);
  res.json({ success: true, removedId: removed.id });
});

app.post('/api/accounts/:id/sync-balance', async (req, res) => {
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (account.broker !== 'coinswitch') {
    return res.status(400).json({ error: 'Balance sync is only supported for CoinSwitch accounts.' });
  }
  try {
    await syncAccountBalances(account);
    res.json({ success: true, account: account.id, availableMarginUSDT: account.availableMarginUSDT, totalEquityUSDT: account.totalEquityUSDT });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
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
  const { accountId, broker, status, page, limit } = req.query;
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

  filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const pageNum = Math.max(Number(page || 1), 1);
  const limitNum = Math.min(Math.max(Number(limit || 50), 1), 500);
  const total = filtered.length;
  const totalPages = Math.ceil(total / limitNum) || 1;
  const start = (pageNum - 1) * limitNum;
  const paged = filtered.slice(start, start + limitNum);

  res.json({
    orders: paged,
    page: pageNum,
    limit: limitNum,
    total,
    totalPages,
    hasMore: pageNum < totalPages,
  });
});

app.post('/api/orders', async (req, res) => {
  try {
    // Emergency stop: reject all new order placement
    if (isEmergencyStopActive()) {
      return res.status(409).json({
        error: 'Emergency stop is active. New order placement is blocked.',
        emergencyStop: getEmergencyStopStatus(),
      });
    }

    const { accountId, symbol, tpPrice, slPrice, timeInForce = 'GTC' } = req.body;
    const side = String(req.body.side || '').toUpperCase();
    const orderType = String(req.body.orderType || '').toUpperCase();
    const leverage = req.body.leverage === undefined ? 1 : num(req.body.leverage);
    const size = num(req.body.size);
    const price = num(req.body.price);

    const account = accounts.find((a) => a.id === accountId);
    if (!account) return res.status(404).json({ error: 'Target trading account not found' });
    if (!symbol || typeof symbol !== 'string') return res.status(400).json({ error: 'symbol is required' });
    if (!VALID_SIDES.has(side)) return res.status(400).json({ error: 'side must be BUY or SELL' });
    if (!VALID_ORDER_TYPES.has(orderType)) return res.status(400).json({ error: 'orderType must be MARKET or LIMIT' });
    if (!isPositiveNumber(size)) return res.status(400).json({ error: 'size must be a positive number' });
    if (!Number.isFinite(leverage) || leverage !== 1) {
      return res.status(400).json({ error: 'leverage must be 1 (spot trading only)' });
    }
    if (orderType === 'LIMIT' && !isPositiveNumber(price)) {
      return res.status(400).json({ error: 'A positive limit price is required for LIMIT orders' });
    }

    // Exposure limits check. A MARKET order has no limit price, so value it at the live price;
    // otherwise its notional would count as 0 and slip past the USDT caps.
    let exposurePrice = price;
    if (orderType === 'MARKET') {
      const lp = (await getLivePriceIndex()).get(symbol);
      if (!lp) return res.status(400).json({ error: `No live price for ${symbol}; cannot compute order notional.` });
      exposurePrice = lp.price;
    }
    const expCheck = checkExposureLimits(accountId, symbol, exposurePrice, size, exposurePrice * size);
    if (!expCheck.ok) {
      return res.status(403).json({ error: expCheck.reason, exposureLimits: getExposureLimits() });
    }

    const brokerId = account.broker;
    // CoinSwitch Spot supports MARKET and LIMIT orders.
    try {
      validateBrokerOrder(brokerId, { orderType, price: req.body.price, size }, account);
    } catch (valErr) {
      return res.status(400).json({ error: valErr.message });
    }

    // --- REAL MODE: place order on the exchange --------------------------------
    if (account.mode === 'REAL') {
      const adapter = getRealAdapter(account);
      if (!adapter) {
        return res.status(400).json({ error: 'Real trading not configured for this account (missing Binance credentials or adapter).' });
      }
      // Pre-trade margin guard: reject if available margin cannot cover notional + fee
      const livePair = orderType === 'LIMIT' ? undefined : (await getLivePriceIndex()).get(symbol);
      const refPrice = orderType === 'LIMIT' ? num(req.body.price) : livePair?.price;
      if (!refPrice || !Number.isFinite(refPrice)) {
        return res.status(400).json({ error: `No live price for ${symbol}; cannot compute order notional.` });
      }
      const orderValue = refPrice * size;
      const feePct = feeFor(account.broker, 'TAKER');
      const fee = (orderValue * feePct) / 100;
      if (account.availableMarginUSDT < orderValue + fee) {
        return res.status(400).json({ error: `Insufficient margin: need ${(orderValue + fee).toFixed(2)} USDT, have ${account.availableMarginUSDT.toFixed(2)} USDT.` });
      }

      // Slippage protection: reject MARKET orders if expected slippage exceeds the max allowed.
      if (orderType === 'MARKET') {
        const ex = executionCost({ broker: account.broker, side, refPrice, size, quoteVolume: livePair?.quoteVolume });
        const maxSlippagePct = Number(process.env.SLIPPAGE_MAX_ORDER_PERCENT ?? 2);
        if (ex.slippagePct > maxSlippagePct) {
          return res.status(400).json({
            error: `Expected slippage ${ex.slippagePct}% exceeds max allowed ${maxSlippagePct}% for MARKET order. Use a LIMIT order instead.`,
            slippagePct: ex.slippagePct,
            maxSlippagePct,
          });
        }
      }

      let placed;
      try {
        placed = await adapter.placeOrder({
          accountId: account.id,
          symbol,
          side,
          type: orderType,
          size,
          price: orderType === 'LIMIT' ? num(req.body.price) : undefined,
          timeInForce,
        });
      } catch (err) {
        return res.status(500).json({ error: `Order placement failed: ${(err as Error).message}` });
      }
      const mappedStatus = placed.status === 'NEW' ? 'OPEN' : placed.status === 'CANCELED' ? 'CANCELLED' : placed.status;
      const immediateFill = Number(placed.filledSize || 0);
      const realOrder: any = {
        id: placed.clientOrderId || uid('ord'),
        clientOrderId: placed.clientOrderId,
        exchangeOrderId: placed.orderId,
        accountId: account.id,
        broker: brokerId,
        symbol: placed.symbol,
        side: placed.side,
        orderType: placed.type,
        price: placed.price ?? refPrice,
        size: placed.size,
        // Any immediate fill is booked through applyRealFill below (balances, holdings, trade record),
        // so start at 0 here; otherwise the later WS event would look "already processed".
        filledSize: 0,
        status: immediateFill > 0 ? 'OPEN' : mappedStatus,
        timeInForce,
        leverage,
        tpPrice: tpPrice ? num(tpPrice) : undefined,
        slPrice: slPrice ? num(slPrice) : undefined,
        timestamp: placed.timestamp,
        fee: placed.fee ?? 0,
        mode: 'REAL',
        raw: placed.raw,
      };
      orders.unshift(realOrder);
      if (orders.length > 10000) orders.length = 10000;
      if (immediateFill > 0) {
        applyRealFill(account, {
          orderId: placed.orderId,
          clientOrderId: placed.clientOrderId,
          filledSize: immediateFill,
          fillPrice: placed.fillPrice,
          timestamp: placed.timestamp,
        });
        // An IOC/expired order can fill partly and still be finished; keep the exchange's terminal status
        if (mappedStatus === 'CANCELLED' || mappedStatus === 'EXPIRED' || mappedStatus === 'REJECTED') realOrder.status = mappedStatus;
      }
      // Note: REAL orders bypass the simulated margin reservation; risk/OMS guards apply at the exchange.
      res.status(201).json(realOrder);
      // Master account: copy the exact order (same type, price and side) to the replicas right away.
      if (account.isMaster && mirrorConfig.enabled) {
        externalMirrored.add(`${account.id}:${placed.orderId}`); // the fill event for this order needs no second look-up
        mirrorMasterOrder(account, {
          orderId: String(placed.orderId),
          symbol: placed.symbol,
          side: placed.side,
          type: orderType,
          size: placed.size,
          price: orderType === 'LIMIT' ? num(req.body.price) : undefined,
          status: placed.status,
        }).catch((err) => console.warn(`[mirror] failed to mirror order ${placed.orderId}:`, (err as Error).message));
      }
      return;
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
  if (order.mode === 'REAL') {
    // An edit here would only change our local copy while the exchange order stays as it was.
    return res.status(409).json({ error: 'Live exchange orders cannot be modified from here. Cancel the order and place a new one.' });
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

app.delete('/api/orders/:id', async (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'OPEN') {
    return res.status(409).json({ error: `Only OPEN orders can be cancelled (this order is ${order.status}).` });
  }
  const acct = accounts.find((a) => a.id === order.accountId);
  if (order.mode === 'REAL') {
    // Cancel on the exchange first; only mark it cancelled locally once the exchange confirms.
    const adapter = acct && getRealAdapter(acct);
    if (!adapter) return res.status(400).json({ error: 'No exchange adapter/credentials for this order\'s account; cannot cancel on the exchange.' });
    try {
      await adapter.cancelOrder(acct.id, order.exchangeOrderId || order.id, order.symbol);
    } catch (err) {
      return res.status(502).json({ error: `Exchange cancel failed: ${(err as Error).message}. The order is still OPEN here; check the exchange.` });
    }
  }
  if (acct) releaseOrder(acct, order); // give the reserved funds back
  order.status = 'CANCELLED';
  res.json({ success: true, message: `Order ${order.id} cancelled successfully`, order });
});

// -------------------------------------------------------------
// 4.5. Safety: emergency stop, reconciliation, exposure limits
// -------------------------------------------------------------
app.get('/api/safety/status', (_req, res) => {
  res.json({
    emergencyStop: getEmergencyStopStatus(),
    exposureLimits: getExposureLimits(),
    accounts: accounts.map((a) => ({
      id: a.id,
      accountName: a.accountName,
      broker: a.broker,
      mode: a.mode,
      exposureUSDT: accountExposureUSDT(a.id),
      openOrders: accountOpenOrderCount(a.id),
    })),
  });
});

app.post('/api/safety/emergency-stop', (req, res) => {
  const { reason } = req.body || {};
  if (!reason || typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason is required' });
  }
  activateEmergencyStop(reason, 'api-operator');
  res.json({ success: true, emergencyStop: getEmergencyStopStatus() });
});

app.post('/api/safety/emergency-stop/cancel-all', async (req, res) => {
  if (!isEmergencyStopActive()) {
    return res.status(400).json({ error: 'Emergency stop is not active' });
  }
  const { confirmNonce } = req.body || {};
  const result = await cancelAllOpenOrders(confirmNonce, getRealAdapter);
  if (result.error) {
    return res.status(400).json({ error: result.error, emergencyStop: getEmergencyStopStatus() });
  }
  res.json({ success: true, ...result });
});

app.post('/api/safety/emergency-stop/reset', (_req, res) => {
  deactivateEmergencyStop();
  res.json({ success: true, emergencyStop: getEmergencyStopStatus() });
});

app.post('/api/safety/reconcile', async (_req, res) => {
  const result = await reconcileOrders();
  res.json({ success: true, ...result });
});

app.get('/api/safety/exposure-limits', (_req, res) => {
  res.json(getExposureLimits());
});

app.post('/api/safety/exposure-limits', (req, res) => {
  try {
    const updated = setExposureLimits(req.body);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 10. Trades
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
  const { accountId, broker, page, limit } = req.query;
  let filtered = [...trades];

  if (accountId) {
    filtered = filtered.filter((o) => o.accountId === accountId);
  }
  if (broker) {
    filtered = filtered.filter((o) => o.broker === broker);
  }

  filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const pageNum = Math.max(Number(page || 1), 1);
  const limitNum = Math.min(Math.max(Number(limit || 50), 1), 500);
  const total = filtered.length;
  const totalPages = Math.ceil(total / limitNum) || 1;
  const start = (pageNum - 1) * limitNum;
  const paged = filtered.slice(start, start + limitNum);

  res.json({
    trades: paged,
    page: pageNum,
    limit: limitNum,
    total,
    totalPages,
    hasMore: pageNum < totalPages,
  });
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
  if (account.mode === 'REAL') {
    // Settling this locally would show the position as closed while the coins are still held on the exchange.
    return res.status(409).json({ error: 'This position is on a live account. Close it by placing a SELL order (Orders tab) so it executes on the exchange.' });
  }

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
  const { enabled, masterAccountId } = req.body;
  mirrorConfig.enabled = Boolean(enabled);
  if (masterAccountId) {
    const master = accounts.find((a) => a.id === masterAccountId);
    if (!master) return res.status(404).json({ error: 'Master account not found' });
    if (!master.isMaster) return res.status(400).json({ error: 'Account is not marked as master' });
    mirrorConfig.masterAccountId = masterAccountId;
  }
  res.json({ success: true, enabled: mirrorConfig.enabled, masterAccountId: mirrorConfig.masterAccountId });
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

app.get('/api/mirror/logs/export', (_req, res) => {
  const headers = ['Timestamp', 'Master Order', 'Target Account', 'Status', 'Details'];
  const rows = mirrorConfig.logs.map((l) => [
    l.timestamp,
    l.masterOrder || '',
    l.targetAccount || '',
    l.status || '',
    l.details || '',
  ]);
  const csv = [headers, ...rows]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="mirror-audit-log.csv"');
  res.send(csv);
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
    // HALAL_ONLY is enforced only when the user opts in via the halal toggle
    if (halalOnly === true && !isHalalSymbol(String(symbol || ''))) {
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
    const botId = uid('bot');
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

/** Load seed accounts from a JSON file into the live accounts/holdings arrays.
 *  Returns the number of new accounts added. Safe to call in test mode. */
function seedAccountsFromFile(filePath) {
  const seedAccounts = loadSeedAccounts(filePath);
  for (const seed of seedAccounts) {
    const existing = accounts.find((a) => a.broker === seed.broker && a.accountName === seed.accountName);
    if (existing) {
      // Restored from state.json (which holds no credentials): re-attach the keys from the seed file.
      if (mergeSeedCredentials(existing, seed)) console.log(`[seed] restored credentials for ${existing.accountName}`);
      continue;
    }
    accounts.push(seed);
    holdings.push({
      accountId: seed.id,
      broker: seed.broker,
      asset: 'USDT',
      name: 'Tether USD',
      free: seed.availableMarginUSDT,
      locked: 0,
      total: seed.availableMarginUSDT,
      rateUSDT: 1.0,
      valueUSDT: seed.availableMarginUSDT,
    });
  }
  if (seedAccounts.length) {
    console.log(`[seed] loaded ${seedAccounts.length} account(s) from ${filePath}`);
  }
  return seedAccounts.length;
}

/** Reconciliation loop: every 60s, compare local order state vs exchange open orders
 *  for master accounts and auto-correct drift. */
let reconciliationTimer = null;
export function startReconciliationLoop(intervalMs = 60_000) {
  if (reconciliationTimer) return;
  // Run an initial reconciliation shortly after startup
  setTimeout(() => {
    reconcileOrders().then((r) => {
      if (r.actions.length) console.log(`[reconcile] ${r.actions.length} action(s) taken`);
      if (r.errors.length) console.warn(`[reconcile] ${r.errors.length} error(s):`, r.errors.map((e) => e.reason));
    });
  }, 5000);
  reconciliationTimer = setInterval(() => {
    reconcileOrders().then((r) => {
      if (r.actions.length) console.log(`[reconcile] ${r.actions.length} action(s) taken`);
      if (r.errors.length) console.warn(`[reconcile] ${r.errors.length} error(s):`, r.errors.map((e) => e.reason));
    });
  }, intervalMs);
  reconciliationTimer.unref?.();
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

  // Persist state to disk so a restart doesn't wipe orders, positions,
  // mirror config, bots, emergency-stop, and exposure-limit state. Defaults to
  // data/state.json when STATE_FILE is not set.
  const stateFile = process.env.STATE_FILE || path.resolve(process.cwd(), 'data', 'state.json');
  try {
    const restored = loadState(stateFile);
    for (const b of botsState.bots) if (b.status === 'RUNNING' || b.status === 'PAUSED') { b._wsCounted = false; trackBotSymbol(b); }
    const flush = startPersistence(stateFile);
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { flush(); process.exit(0); });
    console.log(`[persist] ${restored ? 'restored state from' : 'writing state to'} ${stateFile}`);
  } catch (err) {
    console.error(`[persist] failed to initialise: ${err.message}`);
  }

  // Seed accounts from ACCOUNTS_FILE (user-editable JSON). Credentials are
  // stored plaintext in this file — fine for local-only use; never commit real keys.
  try {
    const seedFile = process.env.ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE;
    seedAccountsFromFile(seedFile);

    // Fail-safe: refuse to start if any REAL-mode account lacks real credentials.
    // Prevents accidentally trading with simulated balances when you intended live trading.
    const realAccounts = accounts.filter((a) => a.mode === 'REAL');
    const badRealAccounts = realAccounts.filter(
      (a) =>
        !a.apiKey ||
        !a.apiSecret ||
        a.apiKey === 'YOUR_COINSWITCH_API_KEY' ||
        a.apiSecret === 'YOUR_COINSWITCH_SECRET' ||
        a.apiKey === 'REPLACE_WITH_MASTER_API_KEY' ||
        a.apiSecret === 'REPLACE_WITH_MASTER_API_SECRET' ||
        a.apiKey?.startsWith('REPLACE_WITH') ||
        a.apiSecret?.startsWith('REPLACE_WITH')
    );
    if (badRealAccounts.length > 0) {
      const names = badRealAccounts.map((a) => `${a.accountName} (${a.id})`).join(', ');
      throw new Error(
        `REAL-mode account(s) missing valid credentials: ${names}. ` +
        `Fill in real apiKey/apiSecret in ${process.env.ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE} or set mode to PAPER.`
      );
    }
    if (realAccounts.length) {
      console.log(`[real-mode] ${realAccounts.length} account(s) configured for live trading`);
    }
  } catch (err) {
    console.error(`[startup] ${err.message}`);
    process.exit(1);
  }

  // Auto-fetch real wallet balances from CoinSwitch for REAL-mode accounts.
  async function syncAccountBalances(account) {
    if (account.broker !== 'coinswitch' || account.mode !== 'REAL') return;
    const adapter = getRealAdapter(account);
    if (!adapter) return;

    // In-flight dedup: return existing promise if a sync for this account is already running
    const inflight = balanceInflight.get(account.id);
    if (inflight) return inflight;

    // TTL cache: skip exchange call if we have fresh data
    const cached = balanceCache.get(account.id);
    if (cached && Date.now() - cached.ts < BALANCE_TTL_MS) {
      applyBalanceCache(account, cached.data);
      return cached.data;
    }

    const promise = (async () => {
      try {
        const info = await adapter.getAccountInfo(account.id);
        balanceCache.set(account.id, { data: info, ts: Date.now() });
        applyBalanceData(account, info);
        console.log(`[balance] synced ${account.accountName}`);
      } catch (err) {
        console.warn(`[balance] sync failed for ${account.accountName}:`, (err as Error).message);
      } finally {
        balanceInflight.delete(account.id);
      }
    })();
    balanceInflight.set(account.id, promise);
    return promise;
  }

  function applyBalanceData(account, info) {
    const usdtHolding = holdings.find((h) => h.accountId === account.id && h.asset === 'USDT');
    let freeUSDT = 0, lockedUSDT = 0;
    for (const b of info.balances) {
      const existing = holdings.find((h) => h.accountId === account.id && h.asset === b.asset);
      const rateUSDT = b.asset === 'USDT' ? 1 : undefined;
      if (existing) {
        existing.free = b.free; existing.locked = b.locked; existing.total = b.total;
        existing.rateUSDT = rateUSDT ?? existing.rateUSDT;
        existing.valueUSDT = rateUSDT ? Number((b.total * rateUSDT).toFixed(2)) : existing.valueUSDT;
      } else {
        holdings.push({
          accountId: account.id, broker: account.broker, asset: b.asset, name: b.asset,
          free: b.free, locked: b.locked, total: b.total,
          rateUSDT: rateUSDT ?? 0, valueUSDT: rateUSDT ? Number((b.total * rateUSDT).toFixed(2)) : 0,
        });
      }
      if (b.asset === 'USDT') { freeUSDT = b.free; lockedUSDT = b.locked; }
    }
    if (usdtHolding) {
      account.availableMarginUSDT = freeUSDT;
      account.totalEquityUSDT = freeUSDT + lockedUSDT;
      usdtHolding.free = freeUSDT; usdtHolding.locked = lockedUSDT; usdtHolding.total = freeUSDT + lockedUSDT;
      usdtHolding.valueUSDT = freeUSDT + lockedUSDT;
    }
  }

  function applyBalanceCache(account, info) {
    const usdtHolding = holdings.find((h) => h.accountId === account.id && h.asset === 'USDT');
    let freeUSDT = 0, lockedUSDT = 0;
    for (const b of info.balances) {
      if (b.asset === 'USDT') { freeUSDT = b.free; lockedUSDT = b.locked; }
    }
    if (usdtHolding) {
      account.availableMarginUSDT = freeUSDT;
      account.totalEquityUSDT = freeUSDT + lockedUSDT;
      usdtHolding.free = freeUSDT; usdtHolding.locked = lockedUSDT; usdtHolding.total = freeUSDT + lockedUSDT;
      usdtHolding.valueUSDT = freeUSDT + lockedUSDT;
    }
  }

  // Refresh balances concurrently for all REAL-mode accounts on startup.
  await Promise.all(accounts.filter((a) => a.mode === 'REAL' && ADAPTER_CLASSES[a.broker]).map((a) => syncAccountBalances(a)));

  // Refresh balances every 60 seconds for REAL-mode accounts (concurrent, with TTL cache).
  setInterval(async () => {
    await Promise.all(accounts.filter((a) => a.mode === 'REAL' && ADAPTER_CLASSES[a.broker]).map((a) => syncAccountBalances(a)));
  }, 60_000).unref();

  // Connect real-time order/fill WebSocket streams for REAL-mode accounts.
  for (const a of accounts) {
    if (a.mode === 'REAL') {
      const adapter = getRealAdapter(a);
      if (adapter && !adapter.isConnected(a.id)) {
        try {
          await adapter.connectUserStream(a.id);
          console.log(`[stream] connected user stream for ${a.accountName} (${a.broker})`);
        } catch (err) {
          console.warn(`[stream] failed to connect user stream for ${a.accountName}:`, (err as Error).message);
        }
      }
    }
  }

  startBotLoop();
  startPoller();
  if (process.env.ENABLE_RECONCILIATION_LOOP !== 'false') {
    startReconciliationLoop();
  }
  startPriceFeed();
  setInterval(releaseFinishedBotSymbols, 5000).unref();
  // Containers (Render/Docker) must listen on all interfaces; local dev stays on loopback
  const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !API_TOKEN) {
    throw new Error('Refusing to start on a non-loopback address without API_TOKEN set. The trading API would be unauthenticated.');
  }
  const server = app.listen(PORT, HOST, () => {
    console.log(`QuantaCrypto Terminal running at http://${HOST}:${PORT}`);
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

if (!process.env.QUANTA_TEST) {
  startServer().catch((err) => {
    console.error(`[startup] ${err.message}`);
    process.exit(1);
  });
} else {
  // Test mode: seed accounts so route/bot tests have a working account.
  const seedFile = process.env.ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE;
  let seeded = false;
  try { seeded = seedAccountsFromFile(seedFile) > 0; } catch {}
  if (!seeded) {
    try { seedAccountsFromFile(path.resolve(process.cwd(), 'data', 'accounts.json.example')); } catch {}
  }
}
