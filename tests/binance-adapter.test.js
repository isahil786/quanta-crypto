import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinanceAdapter } from '../server/execution/binance.ts';

const adapter = () => new BinanceAdapter({ id: 'b1', broker: 'binance', apiKey: 'k', apiSecret: 's' });

test('normalizeOrder keeps executed quantity for a filled market order', () => {
  const o = adapter().normalizeOrder({
    orderId: 1, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', status: 'FILLED',
    origQty: '0.50000000', executedQty: '0.50000000', cummulativeQuoteQty: '25000.00000000', price: '0.00000000',
  });
  assert.equal(o.filledSize, 0.5);
  assert.equal(o.fillPrice, 50000); // derived from quote total, not the "0.0000" market price
});

test('normalizeOrder reports zero fill and the limit price for a fresh limit order', () => {
  const o = adapter().normalizeOrder({
    orderId: 2, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', status: 'NEW',
    origQty: '1.00000000', executedQty: '0.00000000', cummulativeQuoteQty: '0.00000000', price: '49000.00000000',
  });
  assert.equal(o.filledSize, 0);
  assert.equal(o.fillPrice, 49000);
});

test('disconnectUserStream does not leave a reconnect timer behind', async () => {
  const a = adapter();
  let closed = false;
  const fake = { listenKey: 'x', ws: { close() { closed = true; }, readyState: 1 }, keepalive: null, reconnect: null, connecting: false };
  a.streams.set('b1', fake);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try { await a.disconnectUserStream('b1'); } finally { globalThis.fetch = realFetch; }
  assert.ok(closed);
  assert.equal(a.streams.has('b1'), false);
});
