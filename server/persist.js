// State persistence: set STATE_FILE=/path/state.json to survive restarts.
// API keys/secrets are stored as-is in this file — fine for local-only use;
// never commit real keys (STATE_FILE should not be committed).
// Pure spot trading — no futures, no leverage, no funding.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import path from 'path';
import { accounts, orders, trades, positions, holdings, gttRules, mirrorConfig } from './state.js';
import { botsState } from './bots.js';

const ARRAYS = { accounts, orders, trades, positions, holdings, gttRules };

function snapshot() {
  return JSON.stringify({
    accounts: accounts.map(({ apiKey, apiSecret, ...rest }) => rest),
    orders, trades, positions, holdings, gttRules,
    mirrorConfig,
    bots: botsState.bots,
  });
}

/** Load a snapshot into the live in-memory arrays (mutating in place). Returns true if loaded. */
export function loadState(file) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
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
