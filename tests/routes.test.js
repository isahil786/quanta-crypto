import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.QUANTA_TEST = '1';
const { app } = await import('../server.ts');

test('GET /api/health is public', async () => {
  const r = await request(app).get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('/api/accounts and /api/mirror never expose API credentials', async () => {
  for (const url of ['/api/accounts', '/api/mirror']) {
    const r = await request(app).get(url);
    assert.equal(r.status, 200);
    assert.ok(!/"apiSecret"|"apiKey"\s*:/.test(JSON.stringify(r.body)), `${url} leaked credentials`);
  }
});

test('/api/meta/brokers does not crash when the market feed is unavailable', async () => {
  const r = await request(app).get('/api/meta/brokers');
  assert.ok(r.status === 200 || r.status === 500);
  if (r.status === 500) assert.ok(!/undefined/.test(r.body.error)); // not a TypeError on an undefined feed
});

test('order validation rejects bad input', async () => {
  const bad = await request(app).post('/api/orders').send({ accountId: 'acc-delta-01', symbol: 'BTCUSDT', side: 'HOLD', orderType: 'MARKET', size: 1 });
  assert.equal(bad.status, 400);
  const noAcct = await request(app).post('/api/orders').send({ accountId: 'nope' });
  assert.equal(noAcct.status, 404);
});

test('unknown /api routes return JSON 404', async () => {
  const r = await request(app).get('/api/nope');
  assert.equal(r.status, 404);
  assert.ok(r.body.error);
});

test('modifying a missing order returns 404', async () => {
  const r = await request(app).put('/api/orders/zzz').send({ price: 1 });
  assert.equal(r.status, 404);
});

// ---- bot creation rules, with the market feed mocked (TESTUSDT = 100)
const feed = async () => ({ ok: true, json: async () => [{ symbol: 'TESTUSDT', lastPrice: '100', priceChangePercent: '1', quoteVolume: '5000000', highPrice: '110', lowPrice: '90', volume: '1', count: 1, bidPrice: '99.9', askPrice: '100.1', weightedAvgPrice: '100' }] });
async function postBot(body) {
  const orig = globalThis.fetch; globalThis.fetch = feed;
  try { return await request(app).post('/api/bots').send({ accountId: 'acc-delta-01', symbol: 'TESTUSDT', ...body }); }
  finally { globalThis.fetch = orig; }
}

test('breakout bot: trigger on the wrong side of the market is rejected', async () => {
  const buy = await postBot({ type: 'BREAKOUT_CHASER', side: 'BUY', triggerPrice: 95, size: 1 });
  assert.equal(buy.status, 400); assert.match(buy.body.error, /above the current price/);
  const sell = await postBot({ type: 'BREAKOUT_CHASER', side: 'SELL', triggerPrice: 105, size: 1 });
  assert.equal(sell.status, 400); assert.match(sell.body.error, /below the current price/);
  const ok = await postBot({ type: 'BREAKOUT_CHASER', side: 'BUY', triggerPrice: 105, size: 1, leverage: 5 });
  assert.equal(ok.status, 201); assert.equal(ok.body.leverage, 5);
});

test('grid bot: spacing below the round-trip fee is rejected, a sane grid is created with one order per interval', async () => {
  const tight = await postBot({ type: 'GRID_BOT', lowerPrice: 99.9, upperPrice: 100.1, gridCount: 20, sizePerGrid: 0.1 });
  assert.equal(tight.status, 400); assert.match(tight.body.error, /round-trip fee/);
  const good = await postBot({ type: 'GRID_BOT', lowerPrice: 90, upperPrice: 110, gridCount: 10, sizePerGrid: 0.1 });
  assert.equal(good.status, 201); assert.equal(good.body.rungs.length, 10);
});

test('QSL bot: levels are spaced wide enough to beat fees', async () => {
  const r = await postBot({ type: 'QSL', levelsEachSide: 3, triggerLevel: 2, sizePerGrid: 0.1 });
  assert.equal(r.status, 201);
  assert.ok(r.body.levelSpacingPercent >= 0.4 && r.body.levelSpacingPercent <= 3);
});
