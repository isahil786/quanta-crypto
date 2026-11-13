import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.QUANTA_TEST = '1';
const { app } = await import('../server.ts');
const { accounts, orders, trades, positions, holdings, fundingLog } = await import('../server/state.js');
const { feeRates, feePct, slippagePercent, executionCost } = await import('../server/costs.js');
const { applyToPosition } = await import('../server/positions.js');
const { settleFunding, fundingDue, fundingBoundary, FUNDING_INTERVAL_MS } = await import('../server/funding.js');
const { __runners } = await import('../server/bots.js');

// ---------- fees + slippage (pure functions) ----------
test('maker fee is below taker fee on futures brokers; spot CoinSwitch has no maker discount', () => {
  assert.ok(feeRates('delta').maker < feeRates('delta').taker);
  assert.ok(feeRates('coindcx').maker < feeRates('coindcx').taker);
  assert.equal(feeRates('coinswitch').maker, feeRates('coinswitch').taker);
  assert.equal(feePct('delta', 'MAKER'), feeRates('delta').maker);
});

test('slippage grows with order size, shrinks with liquidity, and is capped', () => {
  const vol = 50_000_000;
  const small = slippagePercent(1_000, vol), mid = slippagePercent(100_000, vol), big = slippagePercent(5_000_000, vol);
  assert.ok(small < mid && mid < big, `${small} < ${mid} < ${big}`);
  assert.ok(slippagePercent(100_000, 1_000_000) > slippagePercent(100_000, 500_000_000), 'thin coin slips more');
  assert.ok(slippagePercent(1e12, vol) <= 5, 'capped at SLIPPAGE_MAX_PERCENT');
  // square-root law: 4x the size -> about 2x the impact (above the fixed spread part)
  const base = slippagePercent(0, vol);
  assert.ok(Math.abs((slippagePercent(4_000_000, vol) - base) / (slippagePercent(1_000_000, vol) - base) - 2) < 0.05);
});

test('taker fills move against the order; maker fills do not', () => {
  const buy = executionCost({ broker: 'delta', side: 'BUY', refPrice: 100, size: 100, quoteVolume: 1e6 });
  const sell = executionCost({ broker: 'delta', side: 'SELL', refPrice: 100, size: 100, quoteVolume: 1e6 });
  assert.ok(buy.price > 100 && sell.price < 100);
  const maker = executionCost({ broker: 'delta', side: 'BUY', refPrice: 100, size: 100, quoteVolume: 1e6, liquidity: 'MAKER' });
  assert.equal(maker.price, 100); assert.equal(maker.slippagePct, 0); assert.equal(maker.feePct, feeRates('delta').maker);
});

// ---------- reservation + taker/maker through the HTTP API ----------
const feed = async () => ({ ok: true, json: async () => [{ symbol: 'TESTUSDT', lastPrice: '100', priceChangePercent: '1', quoteVolume: '5000000', highPrice: '110', lowPrice: '90', volume: '50000', count: 1, bidPrice: '99.9', askPrice: '100.1', weightedAvgPrice: '100' }] });
async function api(method, url, body) {
  const orig = globalThis.fetch; globalThis.fetch = feed;
  try { return await request(app)[method](url).send(body); } finally { globalThis.fetch = orig; }
}
const cs = () => accounts.find((a) => a.id === 'acc-cs-01');
function reset() {
  orders.length = 0; trades.length = 0; positions.length = 0; fundingLog.length = 0;
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
  assert.equal(holdings.find((h) => h.asset === 'TEST' && h.accountId === 'acc-cs-01').total, 10);
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

// ---------- funding ----------
const T0 = fundingBoundary(Date.UTC(2026, 10, 12, 9, 0, 0)); // a funding boundary
function futuresAccount() {
  const a = accounts.find((x) => x.id === 'acc-delta-01'); a.availableMarginUSDT = 25000; a.totalEquityUSDT = 25000; positions.length = 0; fundingLog.length = 0; return a;
}
const rate = () => 0.0001;

test('funding: with a positive rate longs pay and shorts receive, once per boundary', () => {
  const a = futuresAccount();
  applyToPosition(a, { symbol: 'AAAUSDT', side: 'BUY', size: 2, price: 100, leverage: 10 });
  applyToPosition(a, { symbol: 'BBBUSDT', side: 'SELL', size: 2, price: 100, leverage: 10 });
  for (const p of positions) p.fundingSettledAt = T0;
  const before = a.totalEquityUSDT;
  assert.ok(fundingDue(T0 + FUNDING_INTERVAL_MS + 1));
  const ev = settleFunding({ now: T0 + FUNDING_INTERVAL_MS + 1, rateFor: rate, markFor: () => 100 });
  assert.equal(ev.length, 2);
  const long = ev.find((e) => e.symbol === 'AAAUSDT'), short = ev.find((e) => e.symbol === 'BBBUSDT');
  assert.ok(Math.abs(long.paymentUSDT - 0.02) < 1e-9, `long pays ${long.paymentUSDT}`);
  assert.ok(Math.abs(short.paymentUSDT + 0.02) < 1e-9, 'short receives');
  assert.ok(Math.abs(a.totalEquityUSDT - before) < 1e-9, 'long and short cancel out here');
  assert.equal(settleFunding({ now: T0 + FUNDING_INTERVAL_MS + 2, rateFor: rate, markFor: () => 100 }).length, 0, 'same boundary is never charged twice');
  assert.ok(positions.every((p) => p.fundingSettledAt === T0 + FUNDING_INTERVAL_MS));
});

test('funding: a position opened after the boundary pays nothing until the next one; long outages are capped', () => {
  const a = futuresAccount();
  applyToPosition(a, { symbol: 'AAAUSDT', side: 'BUY', size: 1, price: 100, leverage: 5 });
  positions[0].fundingSettledAt = T0 + FUNDING_INTERVAL_MS; // opened after this boundary
  assert.equal(settleFunding({ now: T0 + FUNDING_INTERVAL_MS + 3600e3, rateFor: rate, markFor: () => 100 }).length, 0);
  const eq = a.totalEquityUSDT;
  const ev = settleFunding({ now: T0 + 10 * FUNDING_INTERVAL_MS, rateFor: rate, markFor: () => 100 });
  assert.equal(ev[0].intervals, 3, 'catch-up capped at 3 intervals');
  assert.ok(Math.abs(eq - a.totalEquityUSDT - 0.03) < 1e-9);
});

test('funding: negative rate flips the direction; positions on spot accounts are ignored', () => {
  const a = futuresAccount();
  applyToPosition(a, { symbol: 'AAAUSDT', side: 'BUY', size: 1, price: 100, leverage: 5 });
  positions[0].fundingSettledAt = T0;
  const eq = a.totalEquityUSDT;
  settleFunding({ now: T0 + FUNDING_INTERVAL_MS, rateFor: () => -0.0002, markFor: () => 100 });
  assert.ok(Math.abs(a.totalEquityUSDT - (eq + 0.02)) < 1e-9, 'long receives when the rate is negative');
  const spot = accounts.find((x) => x.id === 'acc-cs-01');
  positions.push({ id: 'p-spot', accountId: spot.id, symbol: 'AAAUSDT', side: 'LONG', size: 1, entryPrice: 100, margin: 20, fundingSettledAt: T0 });
  const spotEq = spot.totalEquityUSDT;
  settleFunding({ now: T0 + 2 * FUNDING_INTERVAL_MS, rateFor: rate, markFor: () => 100 });
  assert.equal(spot.totalEquityUSDT, spotEq);
  positions.length = 0;
});
