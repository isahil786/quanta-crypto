// Optional state persistence: set STATE_FILE=/path/state.json to survive restarts.
// API keys/secrets are never written to disk.
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
    arr.push(...data[key].map((x) => (key === 'accounts' ? { apiKey: '', apiSecret: '', ...x } : x)));
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
