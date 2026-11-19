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
}

export interface BrokerAdapterRegistry {
  get(brokerId: string): ExecutionAdapter | undefined;
  register(adapter: ExecutionAdapter): void;
  list(): string[];
}
