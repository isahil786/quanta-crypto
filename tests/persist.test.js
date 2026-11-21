import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadState } from '../server/persist.js';
import { mergeSeedCredentials } from '../server/security/accounts.js';

test('loadState keeps a copy of a corrupt state file instead of losing it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qc-'));
  const file = path.join(dir, 'state.json');
  writeFileSync(file, '{"accounts": [');
  assert.equal(loadState(file), false);
  assert.ok(readdirSync(dir).some((n) => n.startsWith('state.json.corrupt-')));
});

test('loadState returns false quietly when there is no state file', () => {
  assert.equal(loadState(path.join(tmpdir(), 'qc-missing', 'nope.json')), false);
});

test('mergeSeedCredentials re-attaches keys to a restored account but never overwrites existing ones', () => {
  const seed = { apiKey: 'KEY1234', apiSecret: 'SECRET', apiKeyMasked: '***1234' };
  const restored = { apiKey: '', apiSecret: '' };
  assert.equal(mergeSeedCredentials(restored, seed), true);
  assert.deepEqual([restored.apiKey, restored.apiSecret, restored.apiKeyMasked], ['KEY1234', 'SECRET', '***1234']);
  const live = { apiKey: 'OTHER', apiSecret: 'OTHERSECRET' };
  assert.equal(mergeSeedCredentials(live, seed), false);
  assert.equal(live.apiKey, 'OTHER');
});
