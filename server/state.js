// In-memory persistent state for QuantaCrypto Terminal
// All market data is loaded live from Binance Public API v3.
// Orders, trades, positions, and bots populate from live user and bot executions.
// Pure spot trading only — no futures, no leverage, no funding.

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
    isMaster: true,
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
];

export const gttRules = [];

export const mirrorConfig = {
  enabled: true,
  masterAccountId: 'acc-cs-01',
  replicas: [],
  logs: [],
};
