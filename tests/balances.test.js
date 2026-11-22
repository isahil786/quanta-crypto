import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBalances } from '../server/balances.js';
import { applySeedSettings } from '../server/security/accounts.js';

test('USDT balance is read case-insensitively', () => {
  const s = summarizeBalances([{ asset: 'usdt', free: '12.5', locked: '2', total: 0 }]);
  assert.equal(s.freeUSDT, 12.5);
  assert.equal(s.lockedUSDT, 2);
  assert.equal(s.cashAsset, 'USDT');
});

test('INR-only wallet explains the zero USDT', () => {
  const s = summarizeBalances([{ asset: 'INR', free: 5000, locked: 0, total: 5000 }]);
  assert.equal(s.freeUSDT, 0);
  assert.match(s.notes.join(' '), /INR but no USDT/);
});

test('Delta-style USD wallet counts as cash', () => {
  const s = summarizeBalances([{ asset: 'USD', free: 80, locked: 20, total: 100 }]);
  assert.equal(s.cashAsset, 'USD');
  assert.equal(s.freeUSDT, 80);
  assert.equal(s.lockedUSDT, 20);
});

test('empty wallet is reported, NaN is tolerated', () => {
  assert.match(summarizeBalances([]).notes.join(' '), /empty wallet/);
  assert.equal(summarizeBalances([{ asset: 'USDT', free: 'x', locked: null }]).freeUSDT, 0);
});

test('seed mode overrides a restored account only when explicit', () => {
  const acc = { mode: 'PAPER', exchange: 'c2c1' };
  assert.equal(applySeedSettings(acc, { modeExplicit: false, mode: 'PAPER', exchange: 'c2c1' }), false);
  assert.equal(applySeedSettings(acc, { modeExplicit: true, mode: 'REAL', exchange: 'c2c1' }), true);
  assert.equal(acc.mode, 'REAL');
});
