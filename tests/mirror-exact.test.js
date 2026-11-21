import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accounts, orders, mirrorConfig } from '../server/state.js';
import { pollOnce, mirrorMasterOrder, getAdapter, lastPolled, adapters } from '../server/poller.js';

process.env.QUANTA_TEST = '1';

function makeAcc(id, { mode = 'REAL', isMaster = false } = {}) {
  const a = { id, broker: 'coinswitch', accountName: id, segment: 'SPOT', exchange: 'c2c1', mode, status: 'ACTIVE', isMaster,
    apiKey: 'k', apiSecret: 's', totalEquityUSDT: 10000, availableMarginUSDT: 10000 };
  accounts.push(a);
  return a;
}
function reset() {
  orders.length = 0; mirrorConfig.logs.length = 0; mirrorConfig.replicas.length = 0;
  mirrorConfig.masterAccountId = null; mirrorConfig.enabled = true;
  lastPolled.clear(); adapters.clear();
  for (let i = accounts.length - 1; i >= 0; i--) if (accounts[i].id.startsWith('acc-test-')) accounts.splice(i, 1);
}
/** REAL master + REAL replicas whose exchange adapter records every call. */
function setup({ replicas = 1, multiplier = 1 } = {}) {
  reset();
  const master = makeAcc('acc-test-master', { isMaster: true });
  const reps = []; const calls = []; const cancels = [];
  for (let i = 0; i < replicas; i++) {
    const r = makeAcc(`acc-test-rep-${i}`);
    adapters.set(r.id, {
      placeOrder: async (req) => { calls.push({ accountId: r.id, ...req }); return { orderId: `EX-${r.id}-${calls.length}`, status: 'NEW', filledSize: 0, timestamp: new Date().toISOString() }; },
      cancelOrder: async (accountId, orderId) => { cancels.push(orderId); return { orderId }; },
    });
    reps.push(r);
  }
  mirrorConfig.masterAccountId = master.id;
  mirrorConfig.replicas = reps.map((r) => ({ accountId: r.id, active: true, multiplier }));
  return { master, reps, calls, cancels };
}
const masterOrder = (o = {}) => ({ orderId: 'M1', symbol: 'TESTUSDT', side: 'BUY', type: 'MARKET', size: 2, status: 'FILLED', ...o });

test('master MARKET order is copied to a REAL replica as a real MARKET order', async () => {
  const { master, calls } = setup();
  await mirrorMasterOrder(master, masterOrder());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'MARKET');
  assert.equal(calls[0].side, 'BUY');
  assert.equal(calls[0].size, 2);
  assert.equal(calls[0].symbol, 'TESTUSDT');
});

test('master LIMIT order is copied as a LIMIT at the same price', async () => {
  const { master, calls } = setup();
  await mirrorMasterOrder(master, masterOrder({ type: 'LIMIT', price: 123.45, status: 'NEW', side: 'SELL' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'LIMIT');
  assert.equal(calls[0].price, 123.45);
  assert.equal(calls[0].side, 'SELL');
});

test('replica multiplier scales the size and every replica gets a copy', async () => {
  const { master, calls } = setup({ replicas: 3, multiplier: 0.5 });
  await mirrorMasterOrder(master, masterOrder({ size: 4 }));
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.size === 2 && c.type === 'MARKET'));
});

test('the same master order reported twice (poller + order form + fill stream) is copied once', async () => {
  const { master, calls } = setup();
  await Promise.all([mirrorMasterOrder(master, masterOrder()), mirrorMasterOrder(master, masterOrder()), mirrorMasterOrder(master, masterOrder())]);
  await mirrorMasterOrder(master, masterOrder());
  assert.equal(calls.length, 1);
});

test('nothing is copied when mirroring is off, or the master order was rejected/cancelled', async () => {
  const { master, calls } = setup();
  mirrorConfig.enabled = false;
  await mirrorMasterOrder(master, masterOrder());
  mirrorConfig.enabled = true;
  await mirrorMasterOrder(master, masterOrder({ orderId: 'M2', status: 'REJECTED' }));
  await mirrorMasterOrder(master, masterOrder({ orderId: 'M3', status: 'CANCELED' }));
  assert.equal(calls.length, 0);
});

test('the poller does not mirror (or cancel) anything while mirroring is switched off', async () => {
  const { master, calls } = setup();
  getAdapter(master).getOpenOrders = async () => [{ orderId: 'L1', symbol: 'TESTUSDT', side: 'BUY', type: 'LIMIT', size: 1, price: 100, status: 'NEW' }];
  mirrorConfig.enabled = false;
  await pollOnce();
  assert.equal(calls.length, 0);
  mirrorConfig.enabled = true;
  await pollOnce(); // snapshot was refreshed while off, so the already-known order is not copied as "new"
  assert.equal(calls.length, 0);
});

test('a master limit order that FILLS does not cancel the replica copy', async () => {
  const { master, reps, cancels } = setup();
  orders.unshift({ id: 'rep-1', accountId: reps[0].id, broker: 'coinswitch', symbol: 'TESTUSDT', side: 'BUY', orderType: 'LIMIT',
    price: 100, size: 1, filledSize: 0, status: 'OPEN', mode: 'REAL', exchangeOrderId: 'EX-REP', mirrorsMasterOrderId: 'L1' });
  const ma = getAdapter(master);
  ma.getOpenOrders = async () => [];                    // gone from the open list...
  ma.getOrder = async () => ({ status: 'FILLED' });     // ...because it filled
  lastPolled.set(master.id, new Map([['L1', { status: 'OPEN', price: 100, size: 1, side: 'BUY', symbol: 'TESTUSDT', orderType: 'LIMIT' }]]));
  await pollOnce();
  assert.deepEqual(cancels, []);
  assert.equal(orders.find((o) => o.id === 'rep-1').status, 'OPEN');
});

test('a master limit order that is CANCELLED cancels the replica copy on the exchange', async () => {
  const { master, reps, cancels } = setup();
  orders.unshift({ id: 'rep-1', accountId: reps[0].id, broker: 'coinswitch', symbol: 'TESTUSDT', side: 'BUY', orderType: 'LIMIT',
    price: 100, size: 1, filledSize: 0, status: 'OPEN', mode: 'REAL', exchangeOrderId: 'EX-REP', mirrorsMasterOrderId: 'L1' });
  const ma = getAdapter(master);
  ma.getOpenOrders = async () => [];
  ma.getOrder = async () => ({ status: 'CANCELED' });
  lastPolled.set(master.id, new Map([['L1', { status: 'OPEN', price: 100, size: 1, side: 'BUY', symbol: 'TESTUSDT', orderType: 'LIMIT' }]]));
  await pollOnce();
  assert.deepEqual(cancels, ['EX-REP']);
  assert.equal(orders.find((o) => o.id === 'rep-1').status, 'CANCELLED');
});
