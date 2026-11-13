import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.QUANTA_TEST = '1';
const { app } = await import('../server.ts');
const { accounts, orders, trades, positions, holdings } = await import('../server/state.js');
const { feeRates, feePct, slippagePercent, executionCost } = await import('../server/costs.js');
const { applyToPosition } = await import('../server/positions.js');
const { __runners } = await import('../server/bots.js');

// ---------- fees + slippage (pure functions) ----------
test('spot CoinSwitch has no maker discount (maker == taker)', () => {
  assert.equal(feeRates('coinswitch').maker, feeRates('coinswitch').taker);
});

test('slippage grows with order size, shrinks with liquidity, and is capped', () => {
  const vol = 50_000_000;
  const small = slippagePercent(1_000, vol), mid = slippagePercent(100_000, vol), big = slippagePercent(5_000_000, vol);
  assert.ok(small < mid && mid < big, `${small} < ${mid} < ${big}`);
  assert.ok(slippagePercent(100_000, 1_000_000) > slippagePercent(100_000, 500_000_000), 'thin coin slips more');
  assert.ok(slippagePercent(1e12, vol) <= 5, 'capped at SLIPPAGE_MAX_PERCENT');
  const base = slippagePercent(0, vol);
  assert.ok(Math.abs((slippagePercent(4_000_000, vol) - base) / (slippagePercent(1_000_000, vol) - base) - 2) < 0.05);
});

test('taker fills move against the order; maker fills do not', () => {
  const buy = executionCost({ broker: 'coinswitch', side: 'BUY', refPrice: 100, size: 100, quoteVolume: 1e6 });
  const sell = executionCost({ broker: 'coinswitch', side: 'SELL', refPrice: 100, size: 100, quoteVolume: 1e6 });
  assert.ok(buy.price > 100 && sell.price < 100);
  const maker = executionCost({ broker: 'coinswitch', side: 'BUY', refPrice: 100, size: 100, quoteVolume: 1e6, liquidity: 'MAKER' });
  assert.equal(maker.price, 100); assert.equal(maker.slippagePct, 0); assert.equal(maker.feePct, feeRates('coinswitch').maker);
});

// ---------- spot order flow through the HTTP API ----------
const feed = async () => ({ ok: true, json: async () => [{ symbol: 'TESTUSDT', lastPrice: '100', priceChangePercent: '1', quoteVolume: '5000000', highPrice: '110', lowPrice: '90', volume: '50000', count: 1, bidPrice: '99.9', askPrice: '100.1', weightedAvgPrice: '100' }] });
async function api(method, url, body) {
  const orig = globalThis.fetch; globalThis.fetch = feed;
  try { return await request(app)[method](url).send(body); } finally { globalThis.fetch = orig; }
}
const cs = () => accounts.find((a) => a.id === 'acc-cs-01');
function reset() {
  orders.length = 0; trades.length = 0; positions.length = 0;
  const a = cs(); a.availableMarginUSDT = 10000; a.totalEquityUSDT = 10000;
  holdings.splice(0, holdings.length, ...holdings.filter((h) => h.accountId !== a.id || h.asset === 'USDT'));
  holdings.find((h) => h.accountId === a.id && h.asset === 'USDT').free = 10000;
}
const usdt = () => holdings.find((h) => h.accountId === 'acc-cs-01' && h.asset === 'USDT');
const limit = (side, price, size) => api('post', '/api/orders', { accountId: 'acc-cs-01', symbol: 'TESTUSDT', side, orderType: 'LIMIT', price, size });

test('a resting BUY limit reserves cash; a second order cannot reuse the same funds; cancel releases', async () => {
  reset();
  const o1 = await limit('BUY', 90, 80);
  assert.equal(o1.status, 201); assert.equal(o1.body.status, 'OPEN');
  assert.ok(Math.abs(o1.body.reservedUSDT - 7207.2) < 0.01, `reserved ${o1.body.reservedUSDT}`); // 7200 + 0.1% maker fee
  assert.ok(Math.abs(cs().availableMarginUSDT - 2792.8) < 0.01);
  assert.ok(Math.abs(usdt().locked - 7207.2) < 0.01 && Math.abs(usdt().total - 10000) < 0.01, 'wallet shows funds as locked, equity unchanged');
  const o2 = await limit('BUY', 90, 80);
  assert.equal(o2.status, 400); assert.match(o2.body.error, /Insufficient/);
  const del = await api('delete', `/api/orders/${o1.body.id}`);
  assert.equal(del.status, 200);
  assert.ok(Math.abs(cs().availableMarginUSDT - 10000) < 1e-6); assert.equal(usdt().locked, 0);
});

test('modifying a resting order re-reserves; a refused edit keeps the old reservation', async () => {
  reset();
  const o = await limit('BUY', 90, 10);
  assert.ok(Math.abs(cs().availableMarginUSDT - (10000 - 900.9)) < 0.01);
  const up = await api('put', `/api/orders/${o.body.id}`, { size: 20 });
  assert.equal(up.status, 200);
  const live = orders.find((x) => x.status === 'OPEN');
  assert.ok(Math.abs(cs().availableMarginUSDT - (10000 - 1801.8)) < 0.01, `available ${cs().availableMarginUSDT}`);
  assert.ok(Math.abs(live.reservedUSDT - 1801.8) < 0.01);
  const bad = await api('put', `/api/orders/${live.id}`, { size: 1_000_000 });
  assert.equal(bad.status, 400);
  assert.ok(Math.abs(cs().availableMarginUSDT - (10000 - 1801.8)) < 0.01, 'refused edit must not change the reservation');
  const open = orders.filter((x) => x.status === 'OPEN');
  assert.equal(open.length, 1, 'cancel-and-replace leaves exactly one open order');
  assert.ok(Math.abs(open[0].reservedUSDT - 1801.8) < 0.01);
});

test('a resting order that gets hit fills as MAKER at its limit price and releases its reservation', async () => {
  reset();
  const o = await limit('BUY', 90, 10);
  __runners.runOpenOrders(new Map([['TESTUSDT', { symbol: 'TESTUSDT', price: 89.5, quoteVolume: 5e6 }]]));
  const filled = orders.find((x) => x.id === o.body.id);
  assert.equal(filled.status, 'FILLED'); assert.equal(filled.liquidity, 'MAKER'); assert.equal(filled.slippagePct, 0);
  assert.ok(Math.abs(filled.fee - 0.9) < 1e-6, `maker fee ${filled.fee}`); // 900 * 0.1%
  assert.equal(filled.reservedUSDT, 0);
  assert.ok(Math.abs(cs().availableMarginUSDT - (10000 - 900 - 0.9)) < 0.01, `cash ${cs().availableMarginUSDT}`);
  assert.equal(usdt().locked, 0);
  assert.equal(holdings.find((h) => h.asset === 'TEST' && h.accountId === 'acc-cs-01')?.total, 10);
});

test('a resting SELL locks the coins so they cannot back a second SELL', async () => {
  reset();
  const buy = await api('post', '/api/orders', { accountId: 'acc-cs-01', symbol: 'TESTUSDT', side: 'BUY', orderType: 'LIMIT', price: 101, size: 1 }); // marketable limit: fills now
  assert.equal(buy.body.status, 'FILLED');
  const s1 = await limit('SELL', 110, 1);
  assert.equal(s1.status, 201);
  const h = holdings.find((x) => x.asset === 'TEST' && x.accountId === 'acc-cs-01');
  assert.equal(h.locked, 1); assert.equal(h.free, 0);
  const s2 = await limit('SELL', 111, 0.5);
  assert.equal(s2.status, 400); assert.match(s2.body.error, /Insufficient TEST/);
  await api('delete', `/api/orders/${s1.body.id}`);
  assert.equal(holdings.find((x) => x.asset === 'TEST' && x.accountId === 'acc-cs-01').free, 1);
});

test('market orders are taker fills: slipped price, taker fee, bigger orders slip more', async () => {
  reset(); cs().availableMarginUSDT = 5e7; cs().totalEquityUSDT = 5e7;
  const small = await api('post', '/api/orders', { accountId: 'acc-cs-01', symbol: 'TESTUSDT', side: 'BUY', orderType: 'LIMIT', price: 100.5, size: 1 }); // marketable
  const big = await api('post', '/api/orders', { accountId: 'acc-cs-01', symbol: 'TESTUSDT', side: 'BUY', orderType: 'LIMIT', price: 150, size: 20000 });
  const ts = trades.find((t) => t.orderId === small.body.id), tb = trades.find((t) => t.orderId === big.body.id);
  assert.equal(ts.liquidity, 'TAKER'); assert.ok(ts.price > 100 && ts.price <= 100.5);
  assert.ok(tb.slippagePct > ts.slippagePct * 5, `big ${tb.slippagePct}% vs small ${ts.slippagePct}%`);
  assert.ok(tb.price > ts.price);
  assert.ok(Math.abs(tb.fee - tb.price * 20000 * 0.001) < 0.01, 'taker fee on the slipped notional');
});
