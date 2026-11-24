import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../server.ts';
import { accounts, orders } from '../server/state.js';
import { __runners } from '../server/bots.js';

test('REAL resting limit orders are never paper-filled by the background loop', () => {
  const acc = accounts[0];
  const prev = acc.mode;
  acc.mode = 'REAL';
  const before = acc.availableMarginUSDT;
  orders.unshift({ id: 'real-regress', exchangeOrderId: 'X1', accountId: acc.id, broker: acc.broker, symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', price: 100000, size: 0.01, filledSize: 0, status: 'OPEN', mode: 'REAL', timestamp: new Date().toISOString(), fee: 0 });
  __runners.runOpenOrders(new Map([['BTCUSDT', { price: 90000, quoteVolume: 1e9 }]]));
  const o = orders.find((x) => x.id === 'real-regress');
  assert.equal(o.status, 'OPEN');
  assert.equal(acc.availableMarginUSDT, before);
  o.status = 'CANCELLED';
  acc.mode = prev;
});

test('bots cannot be created on a REAL account', async () => {
  const acc = accounts[0];
  const prev = acc.mode;
  acc.mode = 'REAL';
  const r = await request(app).post('/api/bots').send({ type: 'TWAP_SLICER', accountId: acc.id, symbol: 'BTCUSDT', totalSize: 1, slicesCount: 2, intervalSeconds: 15 });
  acc.mode = prev;
  assert.equal(r.status, 400);
  assert.match(r.body.error, /REAL/);
});

test('rejected mirror toggle leaves the config untouched', async () => {
  const before = await request(app).get('/api/mirror');
  const r = await request(app).post('/api/mirror/toggle').send({ enabled: !before.body.config.enabled, masterAccountId: 'nope' });
  assert.equal(r.status, 404);
  const after = await request(app).get('/api/mirror');
  assert.equal(after.body.config.enabled, before.body.config.enabled);
});

test('sync-balance is refused cleanly for PAPER accounts (route used an out-of-scope function)', async () => {
  const r = await request(app).post(`/api/accounts/${accounts[0].id}/sync-balance`).send({});
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.body.error, /not defined/);
});

import { floorToStep, roundToTick } from '../server/execution/binance.ts';
test('Binance lot/tick rounding is exact', () => {
  assert.equal(floorToStep(0.123456, 0.001), 0.123);
  assert.equal(floorToStep(0.3, 0.1), 0.3); // 0.3/0.1 = 2.9999999999999996 in floats
  assert.equal(floorToStep(5, 1), 5);
  assert.equal(roundToTick(100.126, 0.01), 100.13);
  assert.equal(roundToTick(0.00001234, 0.00000001), 0.00001234);
});

import { applyRealFill } from '../server.ts';
import { holdings, trades } from '../server/state.js';
test('live fill books a trade, uses the reported USDT fee, and a later cancel event closes the order', () => {
  const acc = accounts[0];
  const ord = { id: 'rf-1', exchangeOrderId: 'EX-RF1', clientOrderId: 'rf-1', accountId: acc.id, broker: acc.broker, symbol: 'ETHUSDT', side: 'BUY', orderType: 'LIMIT', price: 2000, size: 1, filledSize: 0, status: 'OPEN', mode: 'REAL', timestamp: new Date().toISOString(), fee: 0 };
  orders.unshift(ord);
  const n = trades.length;
  applyRealFill(acc, { orderId: 'EX-RF1', clientOrderId: 'rf-1', symbol: 'ETHUSDT', status: 'PARTIALLY_FILLED', filledSize: 0.4, lastFilledSize: 0.4, fillPrice: 2000, fee: 0.5, feeAsset: 'USDT' });
  assert.equal(trades.length, n + 1);
  assert.equal(trades[0].fee, 0.5);
  assert.equal(ord.status, 'PARTIALLY_FILLED');
  assert.ok(holdings.find((h) => h.accountId === acc.id && h.asset === 'ETH').total >= 0.4);
  applyRealFill(acc, { orderId: 'EX-RF1', clientOrderId: 'rf-1', symbol: 'ETHUSDT', status: 'CANCELED', filledSize: 0.4 });
  assert.equal(ord.status, 'CANCELLED');
});
