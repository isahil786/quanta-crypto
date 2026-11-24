// CoinDCX — Spot/Futures execution adapter.
// Uses HMAC-SHA256 signing of JSON body per https://developers.coindcx.com
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
import { signCoinDCXRequest } from '../brokers/coindcx.js';

const BASE_URL = 'https://api.coindcx.com';
const WS_URL = 'wss://stream.coindcx.com';
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

function pairToCoindcx(symbol: string): string {
  return symbol.replace('_', '').toUpperCase();
}

function pairFromCoindcx(pair: string): string {
  // CoinDCX pairs like BTCINR, ETHINR -> BTC/INR, ETH/INR
  const quote = pair.endsWith('INR') ? 'INR' : pair.endsWith('USDT') ? 'USDT' : 'INR';
  const base = pair.replace(quote, '');
  return `${base}/${quote}`;
}

function sideFromCoindcx(s: string): OrderSide {
  return String(s).toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
}

export class CoindcxAdapter implements ExecutionAdapter {
  readonly broker = 'coindcx';
  readonly supportsMarketOrder = true;
  readonly supportsLimitOrder = true;
  readonly supportsCancelOrder = true;
  readonly supportsWebSocket = true;

  private socket: Socket | null = null;
  private socketConnecting = false;
  private fillListeners: Array<(ev: ExecutionFillEvent) => void> = [];
  private accountId: string | null = null;

  constructor(private account: ExecutionAccount) {}

  private headers(body?: any): Record<string, string> {
    return signCoinDCXRequest(body ?? {}, this.account.apiSecret, this.account.apiKey);
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const headers = this.headers(body);
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
      if (!res.ok) throw new Error(`CoinDCX ${method} ${path}: HTTP ${res.status} ${text}`);
      try { return JSON.parse(text); } catch { return text; }
    } finally {
      clearTimeout(t);
    }
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const body: any = {
      order_type: req.type === 'LIMIT' ? 'limit_order' : 'market_order',
      side: sideToCoindcx(req.side),
      pair: pairToCoindcx(req.symbol),
      total_quantity: req.size.toString(),
      ...(req.type === 'LIMIT' && req.price !== undefined ? { price: req.price.toString() } : {}),
      ...(req.clientOrderId ? { order_client_id: req.clientOrderId } : {}),
      timestamp: Math.floor(Date.now() / 1000),
    };
    const data = await this.request('POST', '/exchange/v1/orders/create', body);
    return {
      orderId: String(data.id ?? data.order_id ?? data.orderId),
      clientOrderId: req.clientOrderId ?? data.order_client_id ?? data.clientOrderId ?? '',
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      size: req.size,
      price: req.price,
      status: mapStatus(data.status ?? 'NEW'),
      filledSize: Number(data.filled_quantity ?? data.filledSize ?? 0),
      fillPrice: data.avg_price ?? data.fillPrice ?? undefined,
      fee: data.fee ?? data.fee_amount ?? undefined,
      timestamp: data.created_at ?? new Date().toISOString(),
      raw: data,
    };
  }

  async cancelOrder(accountId: string, orderId: string, symbol?: string): Promise<CancelOrderResult> {
    const data = await this.request('POST', '/exchange/v1/orders/cancel', { id: orderId, timestamp: Math.floor(Date.now() / 1000) });
    return {
      orderId: String(data.id ?? orderId),
      clientOrderId: data.order_client_id ?? undefined,
      symbol: symbol ?? pairFromCoindcx(data.pair ?? ''),
      status: mapStatus(data.status ?? 'CANCELED'),
      raw: data,
    };
  }

  async getOrder(accountId: string, orderId: string, symbol?: string): Promise<OrderQueryResult> {
    const data = await this.request('GET', `/exchange/v1/orders/details?id=${orderId}`);
    return {
      orderId: String(data.id ?? data.order_id),
      clientOrderId: data.order_client_id ?? undefined,
      symbol: symbol ?? pairFromCoindcx(data.pair ?? ''),
      side: sideFromCoindcx(data.side ?? 'buy'),
      type: data.order_type === 'limit_order' ? 'LIMIT' : 'MARKET',
      size: Number(data.total_quantity ?? data.quantity ?? 0),
      price: data.price !== undefined ? Number(data.price) : undefined,
      status: mapStatus(data.status ?? 'NEW'),
      filledSize: Number(data.filled_quantity ?? data.filledSize ?? 0),
      fillPrice: data.avg_price ?? data.fillPrice ?? undefined,
      fee: data.fee ?? undefined,
      timestamp: data.created_at ?? new Date().toISOString(),
      raw: data,
    };
  }

  async getOpenOrders(accountId: string, symbol?: string): Promise<OrderQueryResult[]> {
    const data = await this.request('GET', '/exchange/v1/orders/active_orders');
    const list: any[] = Array.isArray(data) ? data : (data.data ?? data.result ?? []);
    return list.map((o) => ({
      orderId: String(o.id ?? o.order_id),
      clientOrderId: o.order_client_id ?? undefined,
      symbol: symbol ?? pairFromCoindcx(o.pair ?? ''),
      side: sideFromCoindcx(o.side ?? 'buy'),
      type: o.order_type === 'limit_order' ? 'LIMIT' : 'MARKET',
      size: Number(o.total_quantity ?? o.quantity ?? 0),
      price: o.price !== undefined ? Number(o.price) : undefined,
      status: mapStatus(o.status ?? 'NEW'),
      filledSize: Number(o.filled_quantity ?? o.filledSize ?? 0),
      fillPrice: o.avg_price ?? o.fillPrice ?? undefined,
      fee: o.fee ?? undefined,
      timestamp: o.created_at ?? new Date().toISOString(),
      raw: o,
    }));
  }

  async getAccountInfo(accountId: string): Promise<AccountInfoResult> {
    const data = await this.request('GET', '/exchange/v1/users/me/balances');
    const list: any[] = Array.isArray(data) ? data : (data.data ?? data.result ?? []);
    const balances = list.map((b) => ({
      asset: b.currency ?? b.asset ?? 'USDT',
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
      this.socket?.emit('join', { channelName: 'order_updates', apiKey: this.account.apiKey });
    });

    this.socket.on('order_updates', (data: any) => {
      this.handleFillMessage(accountId, data);
    });

    this.socket.on('disconnect', () => {
      this.socketConnecting = false;
      console.warn(`[CoinDCX WS] disconnected for ${accountId}`);
    });

    this.socket.on('connect_error', (err: any) => {
      this.socketConnecting = false;
      console.error(`[CoinDCX WS] connect error for ${accountId}:`, err.message);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CoinDCX WS connect timeout')), FETCH_TIMEOUT_MS);
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
        clientOrderId: m.order_client_id ?? m.clientOrderId ?? undefined,
        symbol: m.pair ?? m.symbol ?? '',
        side: sideFromCoindcx(m.side ?? 'buy'),
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

function sideToCoindcx(s: OrderSide): 'buy' | 'sell' {
  return s === 'BUY' ? 'buy' : 'sell';
}
