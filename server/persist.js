// State persistence: set STATE_FILE=/path/state.json to survive restarts.
// API keys/secrets are NOT written to this file (see snapshot()); they come from ACCOUNTS_FILE on startup.
// STATE_FILE still holds orders and balances, so don't commit it.
// Pure spot trading — no futures, no leverage, no funding.
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'fs';
import path from 'path';
import { accounts, orders, trades, positions, holdings, mirrorConfig, emergencyStop, exposureLimits } from './state.js';
import { botsState } from './bots.js';

const ARRAYS = { accounts, orders, trades, positions, holdings };

function snapshot() {
  return JSON.stringify({
    accounts: accounts.map(({ apiKey, apiSecret, ...rest }) => rest),
    orders, trades, positions, holdings,
    mirrorConfig,
    emergencyStop,
    exposureLimits,
    bots: botsState.bots,
  });
}

/** Load a snapshot into the live in-memory arrays (mutating in place). Returns true if loaded. */
export function loadState(file) {
  let data;
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return false; } // no state file yet
  try { data = JSON.parse(raw); } catch (e) {
    // Don't let the next snapshot silently overwrite a damaged file: keep a copy for recovery.
    const backup = `${file}.corrupt-${Date.now()}`;
    try { copyFileSync(file, backup); } catch { /* best effort */ }
    console.error(`[persist] ${file} is not valid JSON (${e.message}); starting empty. Copy kept at ${backup}`);
    return false;
  }
  for (const [key, arr] of Object.entries(ARRAYS)) {
    if (!Array.isArray(data[key])) continue;
    arr.length = 0;
    if (key === 'accounts') {
      for (const x of data[key]) {
        arr.push({ apiKey: '', apiSecret: '', ...x });
      }
    } else {
      arr.push(...data[key]);
    }
  }
  if (data.mirrorConfig) Object.assign(mirrorConfig, data.mirrorConfig);
  if (data.emergencyStop) Object.assign(emergencyStop, data.emergencyStop);
  if (data.exposureLimits) Object.assign(exposureLimits, data.exposureLimits);
  if (Array.isArray(data.bots)) { botsState.bots.length = 0; botsState.bots.push(...data.bots); }
  return true;
}

/** Write a snapshot every `intervalMs` when something changed (atomic rename). Returns a flush function. */
export function startPersistence(file, intervalMs = 5000) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  let last = '';
  const flush = () => {
    try {
      const s = snapshot();
      if (s === last) return;
      writeFileSync(`${file}.tmp`, s);
      renameSync(`${file}.tmp`, file);
      last = s;
    } catch (e) { console.error('[persist] save failed:', e.message); }
  };
  const t = setInterval(flush, intervalMs);
  t.unref?.();
  return flush;
}
