// In-memory state for QuantaCrypto Terminal — real credentials only, loaded from data/accounts.json.
// All market data is loaded live from Binance Public API v3.
// Orders, trades, positions, and bots populate from live user and bot executions.
// Pure spot trading only — no futures, no leverage, no funding.

import { loadSeedAccounts, DEFAULT_ACCOUNTS_FILE } from './security/accounts.js';
import path from 'path';

export const accounts = [];

// Clean transactional state — populated dynamically by live orders and executions
export const orders = [];
export const trades = [];
export const positions = [];

export const holdings = [];

export const mirrorConfig = {
  enabled: true,
  masterAccountId: null,
  replicas: [],
  logs: [],
};

// ---------------------------------------------------------------
// Safety: emergency stop / kill-switch state
// ---------------------------------------------------------------
export const emergencyStop = {
  active: false,
  reason: null,
  activatedAt: null,
  activatedBy: null,
};

// ---------------------------------------------------------------
// Safety: exposure limits
// Per-account and per-symbol max USDT exposure caps.
// Limits are checked before order placement (manual, mirror, bot).
// ---------------------------------------------------------------
export const exposureLimits = {
  enabled: false,
  perAccountMaxUSDT: null,   // null = unlimited
  perSymbolMaxUSDT: null,    // null = unlimited
  perAccountMaxOrders: null, // null = unlimited
};

function pushSeed(seed) {
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

// In test mode, seed accounts so route/bot tests have a working account regardless
// of import order (server.ts may not be imported by every test file).
if (process.env.QUANTA_TEST) {
  const before = accounts.length;
  try {
    const seeds = loadSeedAccounts(process.env.ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE);
    for (const seed of seeds) {
      const exists = accounts.some((a) => a.broker === seed.broker && a.accountName === seed.accountName);
      if (!exists) pushSeed(seed);
    }
  } catch {}
  if (accounts.length === before) {
    try {
      const seeds = loadSeedAccounts(path.resolve(process.cwd(), 'data', 'accounts.json.example'));
      for (const seed of seeds) {
        const exists = accounts.some((a) => a.broker === seed.broker && a.accountName === seed.accountName);
        if (!exists) pushSeed(seed);
      }
    } catch {}
  }
}
