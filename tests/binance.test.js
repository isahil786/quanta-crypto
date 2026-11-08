import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLiveTop100MomentumCoins } from '../server/binance.js';

const t = (symbol, pct = '1') => ({ symbol, lastPrice: '2', priceChangePercent: pct, quoteVolume: '5000000', highPrice: '3', lowPrice: '1', volume: '1', count: 1, bidPrice: '1', askPrice: '1', weightedAvgPrice: '1' });

test('keeps JUPUSDT, drops stablecoins and legacy leveraged tokens, dedupes concurrent fetches', async () => {
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => [t('JUPUSDT'), t('BTCUPUSDT'), t('USDCUSDT'), t('ETHUSDT')] }; };
  const [a, b] = await Promise.all([getLiveTop100MomentumCoins(), getLiveTop100MomentumCoins()]);
  globalThis.fetch = orig;
  const syms = a.map((c) => c.symbol);
  assert.ok(syms.includes('JUPUSDT'));
  assert.ok(syms.includes('ETHUSDT'));
  assert.ok(!syms.includes('BTCUPUSDT'));
  assert.ok(!syms.includes('USDCUSDT'));
  assert.equal(calls, 1);
  assert.equal(a, b);
});
