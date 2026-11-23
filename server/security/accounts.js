// Seed-account loader: reads ACCOUNTS_FILE (default ./data/accounts.json) on startup.
// Credentials are stored plaintext in this file — fine for local-only use, but
// never commit real keys (data/accounts.json is gitignored).
import { readFileSync } from 'fs';
import path from 'path';
import { uid } from '../util.js';

export const DEFAULT_ACCOUNTS_FILE = path.resolve(process.cwd(), 'data', 'accounts.json');

const REQUIRED = ['broker', 'accountName', 'apiKey', 'apiSecret'];
const VALID_BROKERS = new Set(['coinswitch', 'delta', 'coindcx', 'binance']);
const VALID_SEGMENTS = new Set(['SPOT']);

function mask(key) {
  if (!key) return 'Not configured';
  const visible = key.slice(-4);
  const hidden = Math.max(key.length - 4, 0);
  const asterisks = '*'.repeat(Math.min(hidden, 8));
  return hidden > 8 ? asterisks + '…' + visible : asterisks + visible;
}

function parseSeedAccount(raw, index) {
  const n = index + 1;
  for (const field of REQUIRED) {
    if (raw[field] === undefined || raw[field] === null || String(raw[field]).trim() === '') {
      throw new Error(`accounts.json entry #${n}: missing required field '${field}'`);
    }
  }
  const broker = String(raw.broker).trim().toLowerCase();
  if (!VALID_BROKERS.has(broker)) {
    throw new Error(`accounts.json entry #${n}: unknown broker '${raw.broker}'`);
  }
  const mode = String(raw.mode || 'PAPER').trim().toUpperCase();
  if (!['PAPER', 'REAL'].includes(mode)) {
    throw new Error(`accounts.json entry #${n}: mode must be PAPER or REAL (got '${raw.mode}')`);
  }
  const segment = String(raw.segment || 'SPOT').trim().toUpperCase();
  if (!VALID_SEGMENTS.has(segment)) {
    throw new Error(`accounts.json entry #${n}: segment must be SPOT`);
  }

  return {
    id: raw.id || uid(`acc-${broker}`),
    broker,
    accountName: String(raw.accountName).trim().slice(0, 60),
    segment,
    exchange: String(raw.exchange || 'c2c1').trim(),
    status: String(raw.status || 'ACTIVE').toUpperCase(),
    mode,
    modeExplicit: raw.mode !== undefined && raw.mode !== null && String(raw.mode).trim() !== '',
    apiKeyMasked: mask(String(raw.apiKey).trim()),
    apiKey: String(raw.apiKey).trim(),
    apiSecret: String(raw.apiSecret).trim(),
    createdAt: new Date().toISOString(),
    totalEquityUSDT: Number(raw.totalEquityUSDT || 10000),
    availableMarginUSDT: Number(raw.availableMarginUSDT || 10000),
    unrealizedPnlUSDT: 0,
    isMaster: Boolean(raw.isMaster),
    source: 'seed',
  };
}

/** State snapshots never contain API credentials, so a restored account comes back with empty keys.
 *  Re-attach them from the seed file; returns true if anything was filled in. Never overwrites existing keys. */
export function mergeSeedCredentials(existing, seed) {
  if (existing.apiKey && existing.apiSecret) return false;
  if (!seed.apiKey || !seed.apiSecret) return false;
  existing.apiKey = seed.apiKey;
  existing.apiSecret = seed.apiSecret;
  existing.apiKeyMasked = seed.apiKeyMasked;
  return true;
}

/** accounts.json is the source of truth for settings you edit by hand. A restored account (from state.json)
 *  must pick up a changed mode / exchange / status, otherwise switching a seed entry to REAL is silently ignored.
 *  Returns true if anything changed. */
export function applySeedSettings(existing, seed) {
  let changed = false;
  if (seed.modeExplicit && existing.mode !== seed.mode) { existing.mode = seed.mode; changed = true; }
  if (seed.exchange && existing.exchange !== seed.exchange) { existing.exchange = seed.exchange; changed = true; }
  return changed;
}

export function loadSeedAccounts(filePath = DEFAULT_ACCOUNTS_FILE) {
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Failed to read accounts file ${filePath}: ${err.message}`, { cause: err });
  }
  const accounts = Array.isArray(data) ? data : data.accounts || [];
  return accounts.map((raw, i) => parseSeedAccount(raw, i));
}
