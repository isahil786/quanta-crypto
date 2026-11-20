// Delta Exchange India — Spot/Futures execution adapter.
// Uses HMAC-SHA256 signing per https://docs.india.delta.exchange
import crypto from 'node:crypto';
import { io, Socket } from 'socket.io-client';

import type {
  ExecutionAdapter,
  ExecutionAccount,
  PlaceOrderRequest,
  PlaceOrderResult,
  CancelOrderResult,
  OrderQueryResult,
  AccountInfoResult,
  ExecutionFillEvent,
  OrderSide,
  OrderType,
  OrderStatus,
} from './types.js';
import { signDeltaRequest } from '../brokers/delta.js';

const BASE_URL = 'https://api.india.delta.exchange/v2';
const WS_URL = 'wss://socket.india.delta.exchange';
const FETCH_TIMEOUT_MS = 10000;

function mapStatus(s: string): OrderStatus {
  switch (String(s).toUpperCase()) {
    case 'NEW': case 'OPEN': case 'ACTIVE': return 'NEW';
    case 'PARTIALLY_FILLED': case 'PARTIALLY_EXECUTED': return 'PARTIALLY_FILLED';
    case 'FILLED': case 'EXECUTED': return 'FILLED';
    case 'CANCELED': case 'CANCELLED': case 'CANCELLATION_RAISED': return 'CANCELED';
    case 'REJECTED': return 'REJECTED';
    case 'EXPIRED': case 'EXPIRATION_RAISED': return 'EXPIRED';
    default: return 'NEW';
  }
}

function sideToDelta(s: OrderSide): 'buy' | 'sell' {
  return s === 'BUY' ? 'buy' : 'sell';
}

function sideFromDelta(s: string): OrderSide {
  return String(s).toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
}

export class DeltaAdapter implements ExecutionAdapter {
  readonly broker = 'delta';
  readonly supportsMarketOrder = true;
  readonly supportsLimitOrder = true;
  readonly supportsCancelOrder = true;
  readonly supportsWebSocket = true;

  private socket: Socket | null = null;
  private socketConnecting = false;
  private fillListeners: Array<(ev: ExecutionFillEvent) => void> = [];
  private accountId: string | null = null;

  constructor(private account: ExecutionAccount) {}

  private headers(method: string, path: string, body?: any) {
    const bodyStr = body ? JSON.stringify(body) : '';
    return signDeltaRequest(method, path, '', bodyStr, this.account.apiSecret, this.account.apiKey);
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const headers = this.headers(method, path, body);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Delta ${method} ${path}: HTTP ${res.status} ${text}`);
      try { return JSON.parse(text); } catch { return text; }
    } finally {
      clearTimeout(t);
    }
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const body: any = {
      symbol: req.symbol.replace('_', '/'),
      side: sideToDelta(req.side),
      order_type: req.type === 'LIMIT' ? 'limit_order' : 'market_order',
      size: req.size.toString(),
      ...(req.type === 'LIMIT' && req.price !== undefined ? { price: req.price.toString() } : {}),
      ...(req.clientOrderId ? { client_order_id: req.clientOrderId } : {}),
    };
    const data = await this.request('POST', '/orders', body);
    const order = data.data ?? data.result ?? data;
    return {
      orderId: String(order.id ?? order.order_id ?? data.id),
      clientOrderId: req.clientOrderId ?? String(order.client_order_id ?? order.clientOrderId ?? ''),
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      size: req.size,
      price: req.price,
      status: mapStatus(order.status ?? data.status ?? 'NEW'),
      filledSize: Number(order.filled_quantity ?? order.filledSize ?? 0),
      fillPrice: order.avg_price ?? order.fillPrice ?? undefined,
      fee: order.fee ?? order.fee_amount ?? undefined,
      timestamp: order.created_at ?? order.timestamp ?? new Date().toISOString(),
      raw: data,
    };
  }

  async cancelOrder(accountId: string, orderId: string, symbol?: string): Promise<CancelOrderResult> {
    const data = await this.request('DELETE', `/orders/${orderId}`);
    const order = data.data ?? data.result ?? data;
    return {
      orderId: String(order.id ?? order.order_id ?? orderId),
      symbol: symbol ?? order.symbol ?? order.symbol_symbol ?? '',
      status: mapStatus(order.status ?? data.status ?? 'CANCELED'),
      raw: data,
    };
  }

  async getOrder(accountId: string, orderId: string, symbol?: string): Promise<OrderQueryResult> {
    const data = await this.request('GET', `/orders/${orderId}`);
    const order = data.data ?? data.result ?? data;
    return {
      orderId: String(order.id ?? order.order_id),
      clientOrderId: order.client_order_id ?? undefined,
      symbol: order.symbol_symbol ?? symbol ?? order.symbol ?? '',
      side: sideFromDelta(order.side ?? order.side ?? 'buy'),
      type: order.order_type === 'limit_order' ? 'LIMIT' : 'MARKET',
      size: Number(order.size ?? order.quantity ?? 0),
      price: order.price !== undefined ? Number(order.price) : undefined,
      status: mapStatus(order.status ?? 'NEW'),
      filledSize: Number(order.filled_quantity ?? order.filledSize ?? 0),
      fillPrice: order.avg_price ?? order.fillPrice ?? undefined,
      fee: order.fee ?? undefined,
      timestamp: order.created_at ?? order.timestamp ?? new Date().toISOString(),
      raw: data,
    };
  }

  async getOpenOrders(accountId: string, symbol?: string): Promise<OrderQueryResult[]> {
    const query = symbol ? `?symbol=${encodeURIComponent(symbol)}&state=open` : '?state=open';
    const data = await this.request('GET', `/orders${query}`);
    const list: any[] = Array.isArray(data) ? data : (data.data ?? data.result ?? []);
    return list.map((o) => ({
      orderId: String(o.id ?? o.order_id),
      clientOrderId: o.client_order_id ?? undefined,
      symbol: o.symbol_symbol ?? o.symbol ?? '',
      side: sideFromDelta(o.side ?? 'buy'),
      type: o.order_type === 'limit_order' ? 'LIMIT' : 'MARKET',
      size: Number(o.size ?? o.quantity ?? 0),
      price: o.price !== undefined ? Number(o.price) : undefined,
      status: mapStatus(o.status ?? 'NEW'),
      filledSize: Number(o.filled_quantity ?? o.filledSize ?? 0),
      fillPrice: o.avg_price ?? o.fillPrice ?? undefined,
      fee: o.fee ?? undefined,
      timestamp: o.created_at ?? o.timestamp ?? new Date().toISOString(),
      raw: o,
    }));
  }

  async getAccountInfo(accountId: string): Promise<AccountInfoResult> {
    // Delta doesn't expose account_id in the path for balances; use the signed request to /accounts/{id}/balances
    const data = await this.request('GET', `/accounts/${this.account.id}/balances`);
    const list: any[] = Array.isArray(data) ? data : (data.data ?? data.result ?? []);
    const balances: any[] = list.map((b) => ({
      asset: b.symbol ?? b.asset ?? b.currency ?? 'USDT',
      free: Number(b.available_balance ?? b.free ?? 0),
      locked: Number(b.locked_balance ?? b.locked ?? 0),
      total: Number(b.total_balance ?? b.total ?? 0),
    }));
    return { accountId, balances, raw: data };
  }

  async connectUserStream(accountId: string): Promise<void> {
    if (this.accountId && this.accountId !== accountId) throw new Error('Account mismatch');
    if (this.socket && this.socket.connected) return;
    if (this.socketConnecting) return;

    this.accountId = accountId;
    this.socketConnecting = true;

    this.socket = io(WS_URL, {
      transports: ['websocket'],
      auth: { apiKey: this.account.apiKey },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 3000,
      reconnectionDelayMax: 30000,
      timeout: FETCH_TIMEOUT_MS,
    });

    this.socket.on('connect', () => {
      this.socketConnecting = false;
      this.socket?.emit('subscribe', { channels: [{ name: 'orders' }] });
    });

    this.socket.on('orders', (data: any) => {
      this.handleFillMessage(accountId, data);
    });

    this.socket.on('disconnect', () => {
      this.socketConnecting = false;
      console.warn(`[Delta WS] disconnected for ${accountId}`);
    });

    this.socket.on('connect_error', (err: any) => {
      this.socketConnecting = false;
      console.error(`[Delta WS] connect error for ${accountId}:`, err.message);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Delta WS connect timeout')), FETCH_TIMEOUT_MS);
      this.socket!.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket!.once('connect_error', (err: any) => { clearTimeout(timer); reject(err); });
    });
  }

  async disconnectUserStream(accountId: string): Promise<void> {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.accountId = null;
  }

  onFill?(listener: (ev: ExecutionFillEvent) => void): () => void {
    this.fillListeners.push(listener);
    return () => {
      const idx = this.fillListeners.indexOf(listener);
      if (idx >= 0) this.fillListeners.splice(idx, 1);
    };
  }

  isConnected(accountId: string): boolean {
    return this.socket?.connected === true && this.accountId === accountId;
  }

  private handleFillMessage(accountId: string, msg: any) {
    if (!msg || typeof msg !== 'object') return;
    const data = Array.isArray(msg) ? msg : [msg];
    for (const m of data) {
      const ev: ExecutionFillEvent = {
        type: 'ORDER_UPDATE',
        accountId,
        orderId: String(m.id ?? m.order_id ?? m.orderId),
        clientOrderId: m.client_order_id ?? m.clientOrderId ?? undefined,
        symbol: m.symbol ?? m.symbol_symbol ?? '',
        side: sideFromDelta(m.side ?? 'buy'),
        status: mapStatus(m.status ?? 'NEW'),
        filledSize: Number(m.filled_quantity ?? m.filledSize ?? 0),
        lastFilledSize: Number(m.last_filled_quantity ?? m.lastFilledSize ?? 0),
        fillPrice: m.avg_price ?? m.fillPrice ?? undefined,
        fee: m.fee ?? m.fee_amount ?? undefined,
        timestamp: m.created_at ?? m.timestamp ?? new Date().toISOString(),
        raw: m,
      };
      for (const fn of this.fillListeners) fn(ev);
    }
  }
}
