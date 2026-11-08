// In-memory persistent state for QuantaCrypto Terminal
// All market data is loaded live from Binance Public API v3.
// Orders, trades, positions, and bots populate from live user and bot executions.

export const accounts = [
  {
    id: 'acc-cs-01',
    broker: 'coinswitch',
    accountName: 'CoinSwitch PRO Spot',
    segment: 'SPOT',
    status: 'ACTIVE',
    mode: 'PAPER',
    apiKeyMasked: 'Not configured',
    apiKey: '',
    apiSecret: '',
    createdAt: new Date().toISOString(),
    totalEquityUSDT: 10000.0,
    availableMarginUSDT: 10000.0,
    unrealizedPnlUSDT: 0,
    isMaster: false,
  },
  {
    id: 'acc-delta-01',
    broker: 'delta',
    accountName: 'Delta India Futures VIP',
    segment: 'FUTURES',
    status: 'ACTIVE',
    mode: 'PAPER',
    apiKeyMasked: 'Not configured',
    apiKey: '',
    apiSecret: '',
    createdAt: new Date().toISOString(),
    totalEquityUSDT: 25000.0,
    availableMarginUSDT: 25000.0,
    unrealizedPnlUSDT: 0,
    isMaster: true, // Master account for mirror trading
  },
  {
    id: 'acc-cdcx-01',
    broker: 'coindcx',
    accountName: 'CoinDCX Prime Trading',
    segment: 'FUTURES',
    status: 'ACTIVE',
    mode: 'PAPER',
    apiKeyMasked: 'Not configured',
    apiKey: '',
    apiSecret: '',
    createdAt: new Date().toISOString(),
    totalEquityUSDT: 10000.0,
    availableMarginUSDT: 10000.0,
    unrealizedPnlUSDT: 0,
    isMaster: false,
  },
];

// Clean transactional state — populated dynamically by live orders and executions
export const orders = [];
export const trades = [];
export const positions = [];

export const holdings = [
  {
    accountId: 'acc-cs-01',
    broker: 'coinswitch',
    asset: 'USDT',
    name: 'Tether USD',
    free: 10000.0,
    locked: 0,
    total: 10000.0,
    rateUSDT: 1.0,
    valueUSDT: 10000.0,
  },
  {
    accountId: 'acc-delta-01',
    broker: 'delta',
    asset: 'USDT',
    name: 'Tether Margin Balance',
    free: 25000.0,
    locked: 0,
    total: 25000.0,
    rateUSDT: 1.0,
    valueUSDT: 25000.0,
  },
  {
    accountId: 'acc-cdcx-01',
    broker: 'coindcx',
    asset: 'USDT',
    name: 'Tether Wallet',
    free: 10000.0,
    locked: 0,
    total: 10000.0,
    rateUSDT: 1.0,
    valueUSDT: 10000.0,
  },
];

export const gttRules = [];

export const mirrorConfig = {
  enabled: true,
  masterAccountId: 'acc-delta-01',
  replicas: [
    {
      accountId: 'acc-cs-01',
      multiplier: 0.5,
      active: true,
      maxSlippagePercent: 0.2,
      note: 'Replicate with 50% sizing to CoinSwitch Spot (Limit orders only)',
    },
    {
      accountId: 'acc-cdcx-01',
      multiplier: 1.0,
      active: true,
      maxSlippagePercent: 0.15,
      note: 'Replicate with 100% sizing to CoinDCX',
    },
  ],
  logs: [],
};
