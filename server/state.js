// In-memory state for QuantaCrypto Terminal — real credentials only, loaded from data/accounts.json.
// All market data is loaded live from Binance Public API v3.
// Orders, trades, positions, and bots populate from live user and bot executions.
// Pure spot trading only — no futures, no leverage, no funding.

export const accounts = [];

// Clean transactional state — populated dynamically by live orders and executions
export const orders = [];
export const trades = [];
export const positions = [];

export const holdings = [];

export const gttRules = [];

export const mirrorConfig = {
  enabled: true,
  masterAccountId: null,
  replicas: [],
  logs: [],
};
