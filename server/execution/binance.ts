// Binance Spot execution adapter.
// Signed REST for order placement/cancel/query/account, plus a dedicated
// User Data Stream WebSocket per account for real-time order/fill updates.
// Idempotency: uses Binance newClientOrderId as the idempotency key.
import crypto from 'crypto';
import { WebSocket } from 'ws';
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
} from './types.js';

const BASE_URLS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];
const WS_BASE = 'wss://stream.binance.com:9443';
const FETCH_TIMEOUT_MS = 10000;
const LISTEN_KEY_KEEPALIVE_MS = 30 * 60 * 1000; // 30 min
const WS_RECONNECT_BASE_MS = 1000;

function nowIso() {
  return new Date().toISOString();
}

/** Generate a client order id to use as idempotency key. */
function makeClientOrderId(prefix = 'qc') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Map Binance order status to our common status. */
function avgFillPrice(raw: any): number | undefined {
  const executed = Number(raw.executedQty || 0);
  const quote = Number(raw.cummulativeQuoteQty || 0);
  if (executed > 0 && quote > 0) return quote / executed;
  const limit = Number(raw.price || 0);
  return limit > 0 ? limit : undefined;
}

function mapStatus(s: string): OrderStatus {
  switch (s) {
    case 'NEW': return 'NEW';
    case 'PARTIALLY_FILLED': return 'PARTIALLY_FILLED';
    case 'FILLED': return 'FILLED';
    case 'CANCELED': return 'CANCELED';
    case 'REJECTED': return 'REJECTED';
    case 'EXPIRED': return 'EXPIRED';
    default: return 'NEW';
  }
}
type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';

function toFixed8(n: number) {
  return Number(n.toFixed(8));
}

class BinanceAdapter implements ExecutionAdapter {
  readonly broker = 'binance';
  readonly supportsMarketOrder = true;
  readonly supportsLimitOrder = true;
  readonly supportsCancelOrder = true;
  readonly supportsWebSocket = true;

  private fillListeners = new Set<(event: ExecutionFillEvent) => void>();
  private reconnectAttempts = new Map<string, number>();
  // Per-account WS state
  private streams = new Map<string, {
    listenKey: string;
    ws: WebSocket | null;
    keepalive: ReturnType<typeof setTimeout> | null;
    reconnect: ReturnType<typeof setTimeout> | null;
    connecting: boolean;
  }>();

  constructor(private account: ExecutionAccount) {}

  // ---------------------------------------------------------------- signing
  private signQuery(params: Record<string, string | number | boolean | undefined>) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const signature = crypto.createHmac('sha256', this.account.apiSecret).update(qs).digest('hex');
    return `${qs}&signature=${encodeURIComponent(signature)}`;
  }

  private async fetchSigned(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, string | number | boolean>) {
    const body = { ...params, timestamp: Date.now() };
    const query = this.signQuery(body as Record<string, string | number | boolean | undefined>);
    const url = `${BASE_URLS[0]}${path}?${query}`;
    let lastErr: any;
    for (const base of BASE_URLS) {
      let timeout: any;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(`${base}${path}?${query}`, {
          method,
          headers: { 'X-MBX-APIKEY': this.account.apiKey, 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const text = await res.text();
        if (!res.ok) throw new Error(`Binance ${method} ${path} HTTP ${res.status}: ${text}`);
        return text ? JSON.parse(text) : {};
      } catch (err) {
        clearTimeout(timeout);
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // ---------------------------------------------------------------- order
  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const clientOrderId = req.clientOrderId || makeClientOrderId();
    const params: Record<string, string | number | boolean> = {
      symbol: req.symbol.toUpperCase(),
      side: req.side,
      type: req.type,
      quantity: String(toFixed8(req.size)),
      newClientOrderId: clientOrderId,
    };
    if (req.type === 'LIMIT') {
      if (!req.price) throw new Error('price is required for LIMIT orders');
      params.price = String(req.price);
      params.timeInForce = req.timeInForce || 'GTC';
    }
    const raw = await this.fetchSigned('POST', '/api/v3/order', params);
    return this.normalizeOrder(raw, clientOrderId);
  }

  async cancelOrder(accountId: string, orderId: string, symbol?: string): Promise<CancelOrderResult> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    const params: Record<string, string | number> = { symbol: symbol || '' };
    if (symbol) params.symbol = symbol;
    // Binance cancel needs symbol + orderId OR origClientOrderId
    params.orderId = orderId;
    const raw = await this.fetchSigned('DELETE', '/api/v3/order', params);
    return {
      orderId: String(raw.orderId || orderId),
      clientOrderId: raw.clientOrderId || undefined,
      symbol: raw.symbol || symbol || '',
      status: mapStatus(raw.status || 'CANCELED'),
      raw,
    };
  }

  async getOrder(accountId: string, orderId: string, symbol?: string): Promise<OrderQueryResult> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    const raw = await this.fetchSigned('GET', '/api/v3/order', {
      symbol: symbol || '',
      orderId,
    });
    return this.normalizeOrder(raw);
  }

  async getOpenOrders(accountId: string, symbol?: string): Promise<OrderQueryResult[]> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    const raw: any = await this.fetchSigned('GET', '/api/v3/openOrders', { symbol: symbol || '' });
    const arr = Array.isArray(raw) ? raw : [];
    return arr.map((o: any) => this.normalizeOrder(o));
  }

  async getAccountInfo(accountId: string): Promise<AccountInfoResult> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    const raw = await this.fetchSigned('GET', '/api/v3/account');
    const balances: Balance[] = (raw.balances || []).map((b: any) => ({
      asset: b.asset,
      free: Number(b.free || 0),
      locked: Number(b.locked || 0),
      total: Number(b.free || 0) + Number(b.locked || 0),
    }));
    return { accountId: this.account.id, balances, raw };
  }

  private normalizeOrder(raw: any, clientOrderId?: string): PlaceOrderResult {
    return {
      orderId: String(raw.orderId),
      clientOrderId: clientOrderId || raw.clientOrderId || undefined,
      symbol: raw.symbol,
      side: raw.side,
      type: raw.type,
      size: Number(raw.origQty || raw.quantity || 0),
      price: raw.price ? Number(raw.price) : undefined,
      status: mapStatus(raw.status),
      filledSize: Number(raw.executedQty || 0),
      // Market orders report price "0.00000000"; derive the average fill price from the quote total.
      fillPrice: avgFillPrice(raw),
      fee: undefined,
      feeAsset: undefined,
      timestamp: raw.transactTime ? new Date(raw.transactTime).toISOString() : nowIso(),
      raw,
    };
  }

  // ---------------------------------------------------------------- user data stream WS
  async connectUserStream(accountId: string): Promise<void> {
    if (accountId !== this.account.id) throw new Error('Account mismatch');
    const existing = this.streams.get(accountId);
    if (existing?.ws && existing.ws.readyState === WebSocket.OPEN) return;

    // Create listen key
    let listenKey: string;
    try {
      let lastErr: any;
      for (const base of BASE_URLS) {
        let timeout: any;
        try {
          const controller = new AbortController();
          timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          const res = await fetch(`${base}/api/v3/userDataStream`, {
            method: 'POST',
            headers: { 'X-MBX-APIKEY': this.account.apiKey },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (!res.ok) throw new Error(`Binance userDataStream HTTP ${res.status}`);
          const data = await res.json();
          listenKey = data.listenKey;
          break;
        } catch (err) {
          clearTimeout(timeout);
          lastErr = err;
        }
      }
      if (!listenKey) throw lastErr;
    } catch (err) {
      throw new Error(`Failed to create Binance listen key: ${(err as Error).message}`);
    }

    const state = { listenKey, ws: null, keepalive: null, reconnect: null, connecting: true };
    this.streams.set(accountId, state);

    const wsUrl = `${WS_BASE}/ws/${listenKey}`;
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts.delete(accountId);
      state.connecting = false;
      this.scheduleKeepalive(accountId);
    };

    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf-8');
      try {
        const msg = JSON.parse(data);
        this.handleUserStreamMessage(accountId, msg);
      } catch {
        // ignore malformed
      }
    };

    ws.onerror = (err) => {
      console.error(`[Binance WS] error for ${accountId}:`, (err as any)?.message ?? 'socket error');
    };

    ws.onclose = () => {
      state.ws = null;
      if (state.keepalive) { clearTimeout(state.keepalive); state.keepalive = null; }
      state.connecting = false;
      // Do not reconnect after an intentional disconnect (or if a newer stream replaced this one).
      if (this.streams.get(accountId) !== state) return;
      this.reconnectAttempts.set(accountId, this.reconnectCount(accountId) + 1);
      // reconnect with backoff
      const delay = Math.min(WS_RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectCount(accountId) - 1, 5), 30000);
      state.reconnect = setTimeout(() => this.reconnectUserStream(accountId), delay);
    };
  }

  private reconnectCount(accountId: string): number {
    return this.reconnectAttempts.get(accountId) || 0;
  }

  private async reconnectUserStream(accountId: string) {
    try {
      await this.connectUserStream(accountId);
    } catch (err) {
      console.error(`[Binance WS] reconnect failed for ${accountId}:`, (err as Error).message);
    }
  }

  private scheduleKeepalive(accountId: string) {
    const state = this.streams.get(accountId);
    if (!state) return;
    if (state.keepalive) clearTimeout(state.keepalive);
    state.keepalive = setTimeout(async () => {
      try {
        for (const base of BASE_URLS) {
          let timeout: any;
          try {
            const controller = new AbortController();
            timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const res = await fetch(`${base}/api/v3/userDataStream/${state.listenKey}`, {
              method: 'PUT',
              headers: { 'X-MBX-APIKEY': this.account.apiKey },
              signal: controller.signal,
            });
            clearTimeout(timeout);
            // Expired/invalid key: close the socket so onclose reconnects with a fresh key.
            if (!res.ok && res.status >= 400 && res.status < 500) state.ws?.close();
            break;
          } catch {
            clearTimeout(timeout);
          }
        }
      } catch {
        /* best-effort */
      }
      this.scheduleKeepalive(accountId);
    }, LISTEN_KEY_KEEPALIVE_MS).unref?.();
  }

  private handleUserStreamMessage(accountId: string, msg: any) {
    if (msg.e === 'executionReport') {
      const event: ExecutionFillEvent = {
        type: 'ORDER_UPDATE',
        accountId,
        orderId: String(msg.i),
        clientOrderId: msg.c || undefined,
        symbol: msg.s,
        side: msg.S,
        status: mapStatus(msg.X),
        filledSize: Number(msg.z || 0),
        lastFilledSize: Number(msg.l || 0),
        fillPrice: msg.L ? Number(msg.L) : undefined,
        fee: msg.n ? Number(msg.n) : undefined,
        feeAsset: msg.N || undefined,
        timestamp: new Date(msg.T || Date.now()).toISOString(),
        raw: msg,
      };
      for (const listener of this.fillListeners) {
        try { listener(event); } catch { /* listener error shouldn't kill the stream */ }
      }
    } else if (msg.e === 'outboundAccountPosition') {
      // Balance update - no fill event, but could be used to refresh balances
    }
  }

  async disconnectUserStream(accountId: string): Promise<void> {
    if (accountId !== this.account.id) return;
    const state = this.streams.get(accountId);
    if (!state) return;
    if (state.keepalive) { clearTimeout(state.keepalive); state.keepalive = null; }
    if (state.reconnect) { clearTimeout(state.reconnect); state.reconnect = null; }
    this.streams.delete(accountId); // delete first so onclose sees an intentional disconnect
    this.reconnectAttempts.delete(accountId);
    if (state.ws) { state.ws.close(); state.ws = null; }
    // Delete listen key server-side
    try {
      for (const base of BASE_URLS) {
        let timeout: any;
        try {
          const controller = new AbortController();
          timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          await fetch(`${base}/api/v3/userDataStream/${state.listenKey}`, {
            method: 'DELETE',
            headers: { 'X-MBX-APIKEY': this.account.apiKey },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          break;
        } catch {
          clearTimeout(timeout);
        }
      }
    } catch {
      /* best-effort */
    }
    this.streams.delete(accountId);
  }

  onFill(listener: (event: ExecutionFillEvent) => void): () => void {
    this.fillListeners.add(listener);
    return () => { this.fillListeners.delete(listener); };
  }

  isConnected(accountId: string): boolean {
    if (accountId !== this.account.id) return false;
    const state = this.streams.get(accountId);
    return Boolean(state?.ws && state.ws.readyState === WebSocket.OPEN);
  }
}

export { BinanceAdapter };
