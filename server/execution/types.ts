// Common execution adapter interface.
// Every broker adapter must implement this so the rest of the engine
// (orders, bots, OMS, risk) stays broker-agnostic.

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';

export interface ExecutionAccount {
  id: string;
  broker: string;
  apiKey: string;      // decrypted at runtime
  apiSecret: string;   // decrypted at runtime
  segment?: string;
}

export interface PlaceOrderRequest {
  accountId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  size: number;          // base asset quantity
  price?: number;        // required for LIMIT
  clientOrderId?: string;// idempotency key (if omitted one is generated)
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface PlaceOrderResult {
  orderId: string;          // exchange order id
  clientOrderId: string;    // idempotency key echoed back
  symbol: string;
  side: OrderSide;
  type: OrderType;
  size: number;
  price?: number;
  status: OrderStatus;
  filledSize: number;
  fillPrice?: number;
  fee?: number;
  feeAsset?: string;
  timestamp: string;
  raw: any;
}

export interface CancelOrderResult {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  status: OrderStatus;
  raw: any;
}

export interface OrderQueryResult {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  size: number;
  price?: number;
  status: OrderStatus;
  filledSize: number;
  fillPrice?: number;
  fee?: number;
  feeAsset?: string;
  timestamp: string;
  raw: any;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export interface AccountInfoResult {
  accountId: string;
  balances: Balance[];
  raw: any;
}

export interface ExecutionFillEvent {
  type: 'ORDER_UPDATE' | 'TRADE';
  accountId: string;
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  status: OrderStatus;
  filledSize: number;
  lastFilledSize: number;
  fillPrice?: number;
  fee?: number;
  feeAsset?: string;
  timestamp: string;
  raw: any;
}

export interface OrderBookUpdate {
  s: string;           // BASE,QUOTE
  timestamp: number;   // Unix ms
  bids: [string, string][]; // [price, quantity], sorted descending
  asks: [string, string][]; // [price, quantity], sorted ascending
}

export interface CandleUpdate {
  o: string;   // open
  h: string;   // high
  l: string;   // low
  c: string;   // close
  volume: string;
  end_time: string; // Unix ms
  symbol: string;   // BASE,QUOTE
  interval: string; // minutes
}

export interface TradeUpdate {
  E: number;  // event time (Unix ms)
  p: string;  // price
  q: string;  // quantity (base)
  s: string;  // symbol BASE,QUOTE
  t: number;  // trade id
  e: string;  // exchange
}

export interface BalanceUpdate {
  [coin: string]: {
    free_balance: number;
    locked_balance: number;
  };
}

export interface ExecutionAdapter {
  readonly broker: string;
  readonly supportsMarketOrder: boolean;
  readonly supportsLimitOrder: boolean;
  readonly supportsCancelOrder: boolean;
  readonly supportsWebSocket: boolean;

  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>;
  cancelOrder(accountId: string, orderId: string, symbol?: string): Promise<CancelOrderResult>;
  getOrder(accountId: string, orderId: string, symbol?: string): Promise<OrderQueryResult>;
  getOpenOrders(accountId: string, symbol?: string): Promise<OrderQueryResult[]>;
  getAccountInfo(accountId: string): Promise<AccountInfoResult>;

  // WebSocket user-data stream for real-time order/fill updates
  connectUserStream(accountId: string): Promise<void>;
  disconnectUserStream(accountId: string): Promise<void>;
  onFill?(listener: (event: ExecutionFillEvent) => void): () => void;
  isConnected(accountId: string): boolean;

  // Public market-data websockets (shared, unauthenticated)
  connectMarketDataSocket?(symbols: string[]): Promise<void>;
  disconnectMarketDataSocket?(): void;
  onOrderBook?(listener: (data: OrderBookUpdate) => void): () => void;
  onCandle?(listener: (data: CandleUpdate) => void): () => void;
  onTrade?(listener: (data: TradeUpdate) => void): () => void;
  isMarketDataConnected?(): boolean;

  // Authenticated balance-update websocket (per account)
  connectBalanceStream?(accountId: string): Promise<void>;
  disconnectBalanceStream?(accountId: string): void;
  onBalanceUpdate?(listener: (data: BalanceUpdate) => void): () => void;
  isBalanceStreamConnected?(accountId: string): boolean;
}

export interface BrokerAdapterRegistry {
  get(brokerId: string): ExecutionAdapter | undefined;
  register(adapter: ExecutionAdapter): void;
  list(): string[];
}
