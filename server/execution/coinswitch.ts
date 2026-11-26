// CoinSwitch PRO Spot execution adapter.
// Implements the CoinSwitch API Trading Spot surface per docs at
// https://api-trading.coinswitch.co/
//
// Base URL: https://api-trading.coinswitch.co
// Auth: Ed25519, signed message = METHOD + path_with_query + epoch (body NOT included).
// Headers: X-AUTH-APIKEY, X-AUTH-SIGNATURE, X-AUTH-EPOCH, Content-Type
// Endpoints:
//   POST   /trade/api/v2/order        create order (LIMIT only, spot)
//   DELETE /trade/api/v2/order        cancel order (body: { order_id })
//   GET    /trade/api/v2/order        get single order (?order_id=)
//   GET    /trade/api/v2/orders       list orders (?open=true&...)
//   GET    /trade/api/v2/user/portfolio  wallet balances
// WebSocket: Socket.IO v4, wss://ws.coinswitch.co/orderupdates,
//   path /pro/realtime-rates-socket/spot/order-updates, namespace /orderupdates,
//   event FETCH_ORDER_UPDATES, subscribe { event: "subscribe", apikey }
// Idempotency: client_order_id (echoed in responses and WS updates).
import crypto from 'crypto';
import { io, Socket } from 'socket.io-client';
import type {
  ExecutionAdapter,
  ExecutionAccount,
  PlaceOrderRequest,
  PlaceOrderResult,
  CancelOrderResult,
  OrderQueryResult,
  AccountInfoResult,
  Balance,
  ExecutionFillEvent,
  OrderBookUpdate,
  CandleUpdate,
  TradeUpdate,
  BalanceUpdate,
} from './types.js';

const BASE_URL = 'https://coinswitch.co';
const WS_URL = 'wss://ws.coinswitch.co/orderupdates';
const WS_PATH = '/pro/realtime-rates-socket/spot/order-updates';
const WS_NAMESPACE = '/orderupdates';
const MARKET_WS_URL = 'wss://ws.coinswitch.co/coinswitchx';
const MARKET_WS_PATH = '/pro/realtime-rates-socket/spot';
const BALANCE_WS_URL = 'wss://ws.coinswitch.co/balanceupdates';
const BALANCE_WS_PATH = '/pro/realtime-rates-socket/spot/balance-updates';
const FETCH_TIMEOUT_MS = 10000;
const WS_RECONNECT_BASE_MS = 1000;
const DEFAULT_EXCHANGE = 'c2c1';

const EVENT_ORDER_BOOK = 'FETCH_ORDER_BOOK_CS_PRO';
const EVENT_CANDLESTICK = 'FETCH_CANDLESTICK_CS_PRO';
const EVENT_TRADES = 'FETCH_TRADES_CS_PRO';
const EVENT_BALANCE_UPDATES = 'FETCH_BALANCE_UPDATES';

const QUOTES = ['USDT', 'USDC', 'INR', 'BTC'];
/** App symbol (BTCUSDT, BTC_USDT) -> CoinSwitch pair (BTC/USDT). CoinSwitch rejects a pair without the slash with "valid symbol" 422. */
export function toCoinSwitchSymbol(symbol: string): string {
  const s = String(symbol || '').toUpperCase().replace('_', '/');
  if (s.includes('/')) return s;
  const quote = QUOTES.find((q) => s.endsWith(q) && s.length > q.length);
  return quote ? `${s.slice(0, -quote.length)}/${quote}` : s;
}
/** CoinSwitch pair (BTC/USDT) -> app symbol (BTCUSDT), so local orders, fills and positions line up. */
export function fromCoinSwitchSymbol(symbol: any): string {
  return String(symbol || '').toUpperCase().replace(/[/_]/g, '');
}

function nowIso() {
  return new Date().toISOString();
}

function makeClientOrderId(prefix = 'qc') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function mapStatus(s: string): OrderStatus {
  switch (String(s).toUpperCase()) {
    case 'OPEN': return 'NEW';
    case 'PARTIALLY_EXECUTED': return 'PARTIALLY_FILLED';
    case 'EXECUTED': return 'FILLED';
    case 'CANCELLED': return 'CANCELED';
    case 'CANCELLATION_RAISED': return 'CANCELED';
    case 'REJECTED': case 'DISCARDED': return 'REJECTED';
    case 'EXPIRED': case 'EXPIRATION_RAISED': return 'EXPIRED';
    default: return 'NEW';
  }
}
type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';

function toFixed8(n: number) {
  return Number(n.toFixed(8));
}

/** Build an Ed25519-signed request per CoinSwitch auth spec. */
export function signCoinSwitchAuth(apiKey: string, apiSecretHex: string, method: 'GET' | 'POST' | 'DELETE', path: string, query?: Record<string, string | number | boolean>) {
  const epoch = Date.now().toString();
  let signedPath = path;
  if (query && Object.keys(query).length > 0) {
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    signedPath = `${path}?${qs}`;
  }
  const decodedPath = signedPath.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const message = `${method}${decodedPath}${epoch}`;

  const secretBytes = Buffer.from(apiSecretHex, 'hex');
  if (secretBytes.length !== 32) {
    throw new Error(`Invalid CoinSwitch secret key: expected 32 bytes (64 hex chars), got ${secretBytes.length}`);
  }

  const rawKey = secretBytes.slice(0, 32);
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([pkcs8Prefix, rawKey]);
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('hex');

  return {
    headers: {
      'X-AUTH-APIKEY': apiKey,
      'X-AUTH-SIGNATURE': signature,
      'X-AUTH-EPOCH': epoch,
      'Content-Type': 'application/json',
    },
    path: signedPath,
  };
}

/** Build an Ed25519-signed request per CoinSwitch auth spec. */
function signRequest(apiKey: string, apiSecretHex: string, method: 'GET' | 'POST' | 'DELETE', path: string, query?: Record<string, string | number | boolean>) {
  return signCoinSwitchAuth(apiKey, apiSecretHex, method, path, query);
}

async function fetchSigned(apiKey: string, apiSecretHex: string, method: 'GET' | 'POST' | 'DELETE', path: string, query?: Record<string, string | number | boolean>, body?: any) {
  const { headers, path: signedPath } = signRequest(apiKey, apiSecretHex, method, path, query);
  let lastErr: any;
  for (let attempt = 0; attempt < 2; attempt++) {
    let timeout: any;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const init: any = { method, headers, signal: controller.signal };
      if ((method === 'POST' || method === 'DELETE') && body !== undefined) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const res = await fetch(`${BASE_URL}${signedPath}`, init);
      clearTimeout(timeout);
      const text = await res.text();
      if (!res.ok) throw new Error(`CoinSwitch ${method} ${path} HTTP ${res.status}: ${text}`);
      return text ? JSON.parse(text) : {};
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
    }
  }
  throw lastErr;
}

class CoinSwitchAdapter implements ExecutionAdapter {
  readonly broker = 'coinswitch';
  readonly supportsMarketOrder = true;
  readonly supportsLimitOrder = true;
  readonly supportsCancelOrder = true;
  readonly supportsWebSocket = true;

  private fillListeners = new Set<(event: ExecutionFillEvent) => void>();
  private socket: Socket | null = null;
  private socketConnecting = false;
  private socketReconnect: ReturnType<typeof setTimeout> | null = null;

  private marketSocket: Socket | null = null;
  private marketSocketConnecting = false;
  private orderBookListeners = new Set<(data: OrderBookUpdate) => void>();
  private candleListeners = new Set<(data: CandleUpdate) => void>();
  private tradeListeners = new Set<(data: TradeUpdate) => void>();

  private balanceSocket: Socket | null = null;
  private balanceSocketConnecting = false;
  private balanceListeners = new Set<(data: BalanceUpdate) => void>();

  constructor(private account: ExecutionAccount & { exchange?: string, onDisconnect?: (accountId: string) => void }) {}

  private get exchange() {
    return this.account.exchange || DEFAULT_EXCHANGE;
  }

  private get apiKey() { return this.account.apiKey; }
  private get apiSecret() { return this.account.apiSecret; }

  // ---------------------------------------------------------------- order
  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    if (req.type === 'LIMIT' && !req.price) throw new Error('price is required for CoinSwitch Limit orders.');
    const clientOrderId = req.clientOrderId || makeClientOrderId();
    const body: any = {
      side: req.side.toLowerCase(),
      symbol: toCoinSwitchSymbol(req.symbol),
      type: req.type === 'LIMIT' ? 'limit' : 'market',
      quantity: toFixed8(req.size),
      exchange: this.exchange,
      client_order_id: clientOrderId,
    };
    if (req.type === 'LIMIT') {
      body.price = req.price;
      body.timeInForce = req.timeInForce || 'GTC';
    }
    const raw: any = await fetchSigned(this.apiKey, this.apiSecret, 'POST', '/trade/api/v2/order', undefined, body);
    const data = raw.data || raw;
    return this.normalizeOrder(data, clientOrderId);
  }

  async cancelOrder(accountId: string, orderId: string, symbol?: string): Promise<CancelOrderResult> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    const raw: any = await fetchSigned(this.apiKey, this.apiSecret, 'DELETE', '/trade/api/v2/order', undefined, { order_id: orderId });
    const data = raw.data || raw;
    return {
      orderId: String(data.order_id || orderId),
      clientOrderId: data.client_order_id || undefined,
      symbol: fromCoinSwitchSymbol(data.symbol || symbol || ''),
      status: mapStatus(data.status),
      raw: data,
    };
  }

  async getOrder(accountId: string, orderId: string, symbol?: string): Promise<OrderQueryResult> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    const raw: any = await fetchSigned(this.apiKey, this.apiSecret, 'GET', '/trade/api/v2/order', { order_id: orderId });
    const data = raw.data || raw;
    return this.normalizeOrder(data);
  }

  async getOpenOrders(accountId: string, symbol?: string): Promise<OrderQueryResult[]> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    const query: Record<string, string | number | boolean> = { open: true };
    if (symbol) query.symbols = toCoinSwitchSymbol(symbol);
    const raw: any = await fetchSigned(this.apiKey, this.apiSecret, 'GET', '/trade/api/v2/orders', query);
    const data = raw.data || raw;
    const arr = Array.isArray(data.orders) ? data.orders : (Array.isArray(data) ? data : []);
    return arr.map((o: any) => this.normalizeOrder(o));
  }

  async getAccountInfo(accountId: string): Promise<AccountInfoResult> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    const raw: any = await fetchSigned(this.apiKey, this.apiSecret, 'GET', '/trade/api/v2/user/portfolio');
    const arr = Array.isArray(raw.data) ? raw.data : [];
    const balances: Balance[] = arr.map((b: any) => ({
      asset: b.currency,
      free: Number(b.main_balance || 0),
      locked: Number(b.blocked_balance_order || 0),
      total: Number(b.main_balance || 0) + Number(b.blocked_balance_order || 0),
    }));
    return { accountId: this.account.id, balances, raw };
  }

  private normalizeOrder(raw: any, clientOrderId?: string): PlaceOrderResult {
    return {
      orderId: String(raw.order_id || raw.id),
      clientOrderId: clientOrderId || raw.client_order_id || undefined,
      symbol: fromCoinSwitchSymbol(raw.symbol),
      side: raw.side,
      type: raw.type === 'limit' ? 'LIMIT' : raw.type === 'market' ? 'MARKET' : 'LIMIT',
      size: Number(raw.orig_qty || raw.quantity || 0),
      price: raw.price ? Number(raw.price) : undefined,
      status: mapStatus(raw.status),
      filledSize: Number(raw.executed_qty || 0),
      fillPrice: raw.average_price ? Number(raw.average_price) : undefined,
      fee: undefined,
      feeAsset: undefined,
      timestamp: raw.created_time ? new Date(raw.created_time).toISOString() : nowIso(),
      raw,
    };
  }

  // ---------------------------------------------------------------- user data stream WS (Socket.IO v4)
  async connectUserStream(accountId: string): Promise<void> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    if (this.socket && this.socket.connected) return;
    if (this.socketConnecting) return;

    this.socketConnecting = true;
    this.socket = io(WS_URL, {
      path: WS_PATH,
      transports: ['websocket'],
      auth: { apikey: this.apiKey },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: WS_RECONNECT_BASE_MS,
      reconnectionDelayMax: 30000,
      timeout: FETCH_TIMEOUT_MS,
    });

    this.socket.on('connect', () => {
      this.socketConnecting = false;
      this.socket?.emit('FETCH_ORDER_UPDATES', { event: 'subscribe', apikey: this.apiKey }, (ack?: any) => {
        if (ack && ack.status === 'error') {
          console.error('[CoinSwitch WS] subscribe rejected:', ack);
        }
      });
    });

    this.socket.on('FETCH_ORDER_UPDATES', (data: any) => {
      this.handleUserStreamMessage(accountId, data);
    });

    this.socket.on('disconnect', (reason: string) => {
      this.socketConnecting = false;
      console.warn(`[CoinSwitch WS] disconnected for ${accountId}:`, reason);
      this.account.onDisconnect?.(accountId);
    });

    this.socket.on('connect_error', (err: any) => {
      this.socketConnecting = false;
      console.error(`[CoinSwitch WS] connect error for ${accountId}:`, err.message);
    });

    // Wait for connect (with timeout)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CoinSwitch WS connect timeout')), FETCH_TIMEOUT_MS);
      this.socket!.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket!.once('connect_error', (err: any) => { clearTimeout(timer); reject(err); });
    });
  }

  private async reconnectUserStream(accountId: string) {
    try { await this.connectUserStream(accountId); } catch (err) {
      console.error(`[CoinSwitch WS] reconnect failed for ${accountId}:`, (err as Error).message);
    }
  }

  private handleUserStreamMessage(accountId: string, msg: any) {
    if (!msg || typeof msg !== 'object') return;
    const event: ExecutionFillEvent = {
      type: 'ORDER_UPDATE',
      accountId,
      orderId: String(msg.i || msg.orderId || msg.id),
      clientOrderId: msg.clientOrderId || msg.client_order_id || undefined,
      symbol: fromCoinSwitchSymbol(msg.s || msg.symbol),
      side: msg.S || msg.side,
      status: mapStatus(msg.X || msg.status || 'NEW'),
      filledSize: Number(msg.z || msg.filledSize || msg.filledQuantity || 0),
      lastFilledSize: Number(msg.l || msg.lastFilledSize || 0),
      fillPrice: msg.v || msg.averagePrice || msg.L ? Number(msg.v || msg.averagePrice || msg.L) : undefined,
      fee: msg.fee || msg.n ? Number(msg.fee || msg.n) : undefined,
      feeAsset: msg.feeAsset || msg.N || undefined,
      timestamp: new Date((msg.E || msg.timestamp || Date.now())).toISOString(),
      raw: msg,
    };
    for (const listener of this.fillListeners) {
      try { listener(event); } catch { /* listener error shouldn't kill the stream */ }
    }
  }

  async disconnectUserStream(accountId: string): Promise<void> {
    if (accountId !== this.account.id) return;
    if (this.socketReconnect) { clearTimeout(this.socketReconnect); this.socketReconnect = null; }
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
    this.socketConnecting = false;
  }

  // ---------------------------------------------------------------- public market-data WS (Order Book, Candlestick, Trades)
  async connectMarketDataSocket(symbols: string[]): Promise<void> {
    if (this.marketSocket && this.marketSocket.connected) {
      this.subscribeMarketSymbols(symbols);
      return;
    }
    if (this.marketSocketConnecting) return;

    this.marketSocketConnecting = true;
    this.marketSocket = io(MARKET_WS_URL, {
      path: MARKET_WS_PATH,
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: WS_RECONNECT_BASE_MS,
      reconnectionDelayMax: 30000,
      timeout: FETCH_TIMEOUT_MS,
    });

    this.marketSocket.on('connect', () => {
      this.marketSocketConnecting = false;
      this.subscribeMarketSymbols(symbols);
    });

    this.marketSocket.on(EVENT_ORDER_BOOK, (data: any) => this.handleOrderBook(data));
    this.marketSocket.on(EVENT_CANDLESTICK, (data: any) => this.handleCandle(data));
    this.marketSocket.on(EVENT_TRADES, (data: any) => this.handleTrade(data));

    this.marketSocket.on('disconnect', () => {
      this.marketSocketConnecting = false;
      console.warn('[CoinSwitch Market WS] disconnected');
    });

    this.marketSocket.on('connect_error', (err: any) => {
      this.marketSocketConnecting = false;
      console.error('[CoinSwitch Market WS] connect error:', err.message);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CoinSwitch Market WS connect timeout')), FETCH_TIMEOUT_MS);
      this.marketSocket!.once('connect', () => { clearTimeout(timer); resolve(); });
      this.marketSocket!.once('connect_error', (err: any) => { clearTimeout(timer); reject(err); });
    });
  }

  private subscribeMarketSymbols(symbols: string[]) {
    for (const symbol of symbols) {
      const pair = symbol.toUpperCase().replace('_', ',').replace('/', ',');
      this.marketSocket?.emit(EVENT_ORDER_BOOK, { event: 'subscribe', pair });
      this.marketSocket?.emit(EVENT_CANDLESTICK, { event: 'subscribe', pair });
      this.marketSocket?.emit(EVENT_TRADES, { event: 'subscribe', pair });
    }
  }

  private handleOrderBook(data: any) {
    if (!data || typeof data !== 'object') return;
    const update: OrderBookUpdate = {
      s: data.s || data.symbol || '',
      timestamp: Number(data.timestamp || data.T || Date.now()),
      bids: Array.isArray(data.bids) ? data.bids.map((b: any) => [String(b[0]), String(b[1])]) : [],
      asks: Array.isArray(data.asks) ? data.asks.map((a: any) => [String(a[0]), String(a[1])]) : [],
    };
    for (const listener of this.orderBookListeners) {
      try { listener(update); } catch { /* listener error shouldn't kill the stream */ }
    }
  }

  private handleCandle(data: any) {
    if (!data || typeof data !== 'object') return;
    const update: CandleUpdate = {
      o: String(data.o || data.open || ''),
      h: String(data.h || data.high || ''),
      l: String(data.l || data.low || ''),
      c: String(data.c || data.close || ''),
      volume: String(data.volume || data.v || ''),
      end_time: String(data.end_time || data.E || ''),
      symbol: data.symbol || data.s || '',
      interval: String(data.interval || data.i || '1'),
    };
    for (const listener of this.candleListeners) {
      try { listener(update); } catch { /* listener error shouldn't kill the stream */ }
    }
  }

  private handleTrade(data: any) {
    if (!data || typeof data !== 'object') return;
    const update: TradeUpdate = {
      E: Number(data.E || data.timestamp || data.T || Date.now()),
      p: String(data.p || data.price || ''),
      q: String(data.q || data.quantity || data.qty || ''),
      s: data.s || data.symbol || '',
      t: Number(data.t || data.tradeId || data.id || 0),
      e: data.e || data.exchange || '',
    };
    for (const listener of this.tradeListeners) {
      try { listener(update); } catch { /* listener error shouldn't kill the stream */ }
    }
  }

  disconnectMarketDataSocket(): void {
    if (this.marketSocket) { this.marketSocket.disconnect(); this.marketSocket = null; }
    this.marketSocketConnecting = false;
  }

  onOrderBook(listener: (data: OrderBookUpdate) => void): () => void {
    this.orderBookListeners.add(listener);
    return () => { this.orderBookListeners.delete(listener); };
  }

  onCandle(listener: (data: CandleUpdate) => void): () => void {
    this.candleListeners.add(listener);
    return () => { this.candleListeners.delete(listener); };
  }

  onTrade(listener: (data: TradeUpdate) => void): () => void {
    this.tradeListeners.add(listener);
    return () => { this.tradeListeners.delete(listener); };
  }

  isMarketDataConnected(): boolean {
    return Boolean(this.marketSocket && this.marketSocket.connected);
  }

  // ---------------------------------------------------------------- balance-update WS (authenticated)
  async connectBalanceStream(accountId: string): Promise<void> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    if (this.balanceSocket && this.balanceSocket.connected) return;
    if (this.balanceSocketConnecting) return;

    this.balanceSocketConnecting = true;
    this.balanceSocket = io(BALANCE_WS_URL, {
      path: BALANCE_WS_PATH,
      transports: ['websocket'],
      auth: { apikey: this.apiKey },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: WS_RECONNECT_BASE_MS,
      reconnectionDelayMax: 30000,
      timeout: FETCH_TIMEOUT_MS,
    });

    this.balanceSocket.on('connect', () => {
      this.balanceSocketConnecting = false;
      this.balanceSocket?.emit(EVENT_BALANCE_UPDATES, { event: 'subscribe', apikey: this.apiKey }, (ack?: any) => {
        if (ack && ack.status === 'error') {
          console.error('[CoinSwitch Balance WS] subscribe rejected:', ack);
        }
      });
    });

    this.balanceSocket.on(EVENT_BALANCE_UPDATES, (data: any) => this.handleBalanceUpdate(data));

    this.balanceSocket.on('disconnect', (reason: string) => {
      this.balanceSocketConnecting = false;
      console.warn(`[CoinSwitch Balance WS] disconnected for ${accountId}:`, reason);
    });

    this.balanceSocket.on('connect_error', (err: any) => {
      this.balanceSocketConnecting = false;
      console.error(`[CoinSwitch Balance WS] connect error for ${accountId}:`, err.message);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CoinSwitch Balance WS connect timeout')), FETCH_TIMEOUT_MS);
      this.balanceSocket!.once('connect', () => { clearTimeout(timer); resolve(); });
      this.balanceSocket!.once('connect_error', (err: any) => { clearTimeout(timer); reject(err); });
    });
  }

  private handleBalanceUpdate(data: any) {
    if (!data || typeof data !== 'object') return;
    const update: BalanceUpdate = {};
    for (const [coin, bal] of Object.entries(data)) {
      const b = bal as Record<string, any>;
      if (b) {
        update[String(coin)] = {
          free_balance: Number(b.free_balance || b.free || 0),
          locked_balance: Number(b.locked_balance || b.locked || 0),
        };
      }
    }
    for (const listener of this.balanceListeners) {
      try { listener(update); } catch { /* listener error shouldn't kill the stream */ }
    }
  }

  disconnectBalanceStream(accountId: string): void {
    if (accountId !== this.account.id) return;
    if (this.balanceSocket) { this.balanceSocket.disconnect(); this.balanceSocket = null; }
    this.balanceSocketConnecting = false;
  }

  onBalanceUpdate(listener: (data: BalanceUpdate) => void): () => void {
    this.balanceListeners.add(listener);
    return () => { this.balanceListeners.delete(listener); };
  }

  isBalanceStreamConnected(accountId: string): boolean {
    if (accountId !== this.account.id) return false;
    return Boolean(this.balanceSocket && this.balanceSocket.connected);
  }

  onFill(listener: (event: ExecutionFillEvent) => void): () => void {
    this.fillListeners.add(listener);
    return () => { this.fillListeners.delete(listener); };
  }

  isConnected(accountId: string): boolean {
    if (accountId !== this.account.id) return false;
    return Boolean(this.socket && this.socket.connected);
  }
}

export { CoinSwitchAdapter };
