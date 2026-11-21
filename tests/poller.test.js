import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accounts, orders, mirrorConfig } from '../server/state.js';
import { pollOnce, getAdapter, lastPolled, adapters } from '../server/poller.js';

process.env.QUANTA_TEST = '1';

/** Build a test account and push it into the global accounts array. */
function makeAcc(id, { broker = 'coinswitch', mode = 'PAPER', isMaster = false } = {}) {
  const a = {
    id, broker, accountName: id, segment: 'SPOT', exchange: 'c2c1',
    mode, status: 'ACTIVE', isMaster,
    apiKey: 'test-key', apiSecret: 'test-secret',
    totalEquityUSDT: 10000, availableMarginUSDT: 10000,
  };
  accounts.push(a);
  return a;
}

/** Reset all mutable poller state between tests. */
function reset() {
  orders.length = 0;
  mirrorConfig.logs.length = 0;
  mirrorConfig.replicas.length = 0;
  mirrorConfig.masterAccountId = null;
  mirrorConfig.enabled = true;
  lastPolled.clear();
  adapters.clear();
  for (let i = accounts.length - 1; i >= 0; i--) {
    if (accounts[i].id.startsWith('acc-test-')) accounts.splice(i, 1);
  }
}

/** New master open-order payload. */
function newOrder(overrides = {}) {
  return {
    orderId: overrides.orderId || `CS-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    symbol: overrides.symbol || 'TESTUSDT',
    side: overrides.side || 'BUY',
    type: overrides.type || 'LIMIT',
    size: overrides.size ?? 1,
    price: overrides.price ?? 100,
    status: overrides.status || 'NEW',
    filledSize: overrides.filledSize ?? 0,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function setupMirror({ replicaCount = 1, replicaMode = 'PAPER', replicaBroker = 'coinswitch' } = {}) {
  const master = makeAcc('acc-test-master', { isMaster: true, mode: 'REAL', broker: 'coinswitch' });
  const replicas = [];
  for (let i = 0; i < replicaCount; i++) {
    replicas.push(makeAcc(`acc-test-rep-${i}`, { mode: replicaMode, broker: replicaBroker }));
  }
  mirrorConfig.masterAccountId = master.id;
  mirrorConfig.replicas = replicas.map((r) => ({ accountId: r.id, active: true, multiplier: 1 }));
  return { master, replicas };
}

function mirrorFor(replica, masterOrderId) {
  return orders.filter((o) => o.accountId === replica.id && o.mirrorsMasterOrderId === masterOrderId);
}

// ============================================================================
// PAPER MODE: new / create orders
// ============================================================================

test('poller PAPER: new LIMIT order on master mirrored as OPEN to replica', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1 });

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-1' })];

  await pollOnce();

  const m = mirrorFor(replicas[0], 'CS-1');
  assert.equal(m.length, 1, 'one mirror created');
  assert.equal(m[0].status, 'OPEN');
  assert.equal(m[0].mode, 'PAPER');
  assert.equal(m[0].symbol, 'TESTUSDT');
  assert.equal(m[0].size, 1);
  assert.equal(m[0].price, 100);
});

test('poller PAPER: new MARKET order adapted to LIMIT using live price', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1 });

  // mock fetch so getLivePriceIndex returns TESTUSDT @ 100
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ symbol: 'TESTUSDT', lastPrice: '100', priceChangePercent: '1', quoteVolume: '5000000', highPrice: '110', lowPrice: '90', volume: '50000', count: 1, bidPrice: '99.9', askPrice: '100.1', weightedAvgPrice: '100' }] });
  try {
    const masterAdapter = getAdapter(master);
    masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-MKT', type: 'MARKET', price: undefined, size: 2 })];
    await pollOnce();
    const m = mirrorFor(replicas[0], 'CS-MKT');
    assert.equal(m.length, 1);
    assert.equal(m[0].orderType, 'LIMIT', 'MARKET adapted to LIMIT for Spot replica');
    assert.ok(m[0].notes.includes('Adapted MARKET order to LIMIT'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('poller PAPER: new order rejected when replica has insufficient margin', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1 });
  replicas[0].availableMarginUSDT = 0;

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-2', size: 10, price: 100 })];

  await pollOnce();

  assert.equal(mirrorFor(replicas[0], 'CS-2').length, 0, 'no mirror when margin insufficient');
  const rejected = mirrorConfig.logs.filter((l) => l.status === 'REJECTED');
  assert.ok(rejected.length >= 1, 'rejection logged');
});

test('poller PAPER: dedupe - existing mirror not recreated across cycles', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1 });

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-DEDUP' })];

  await pollOnce();
  await pollOnce();

  const m = mirrorFor(replicas[0], 'CS-DEDUP');
  assert.equal(m.length, 1, 'only one mirror exists after two cycles');
});

test('poller PAPER: new order mirrored to multiple replicas concurrently', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 3 });

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-MULTI' })];

  await pollOnce();

  for (const r of replicas) {
    const m = mirrorFor(r, 'CS-MULTI');
    assert.equal(m.length, 1, `replica ${r.id} mirrored`);
  }
});

// ============================================================================
// PAPER MODE: modify / cancel / fill
// ============================================================================

test('poller PAPER: modify price/size triggers cancel-and-replace on replica', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1 });

  // seed existing mirror
  orders.unshift({
    id: 'rep-old', accountId: replicas[0].id, broker: 'coinswitch', symbol: 'TESTUSDT', side: 'BUY',
    orderType: 'LIMIT', price: 100, size: 1, filledSize: 0, status: 'OPEN', timeInForce: 'GTC',
    leverage: 1, timestamp: new Date().toISOString(), fee: 0, mode: 'PAPER',
    notes: 'Mirror of CS-MOD', mirrorsMasterOrderId: 'CS-MOD',
  });

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-MOD', type: 'LIMIT', price: 105, size: 2, status: 'NEW' })];
  lastPolled.set(master.id, new Map([['CS-MOD', { status: 'OPEN', price: 100, size: 1, side: 'BUY', orderType: 'LIMIT', timestamp: new Date().toISOString() }]]));

  await pollOnce();

  const m = mirrorFor(replicas[0], 'CS-MOD');
  // old cancelled, new replacement OPEN
  assert.ok(m.some((o) => o.status === 'CANCELLED' && o.id === 'rep-old'), 'old mirror cancelled');
  assert.ok(m.some((o) => o.status === 'OPEN' && o.price === 105 && o.size === 2), 'replacement at new price/size');
});

test('poller PAPER: modify with no existing mirror is skipped', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1 });

  // Prime lastPolled so the order is seen as a modify (not new) on this cycle.
  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-NOEXIST', price: 105, size: 2, status: 'NEW' })];
  lastPolled.set(master.id, new Map([['CS-NOEXIST', { status: 'OPEN', price: 100, size: 1, side: 'BUY', orderType: 'LIMIT', timestamp: new Date().toISOString() }]]));

  await pollOnce();

  assert.equal(mirrorFor(replicas[0], 'CS-NOEXIST').length, 0, 'no mirror created for modify-without-existing');
});

test('poller PAPER: cancelled master order cancels replica mirror', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1 });

  orders.unshift({
    id: 'rep-c', accountId: replicas[0].id, broker: 'coinswitch', symbol: 'TESTUSDT', side: 'BUY',
    orderType: 'LIMIT', price: 100, size: 1, filledSize: 0, status: 'OPEN', timeInForce: 'GTC',
    leverage: 1, timestamp: new Date().toISOString(), fee: 0, mode: 'PAPER',
    notes: 'Mirror of CS-CAN', mirrorsMasterOrderId: 'CS-CAN',
  });

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => []; // CS-CAN gone from exchange
  masterAdapter.getOrder = async () => ({ status: 'CANCELED' }); // ...because it was cancelled, not filled
  lastPolled.set(master.id, new Map([['CS-CAN', { status: 'OPEN', price: 100, size: 1, side: 'BUY', orderType: 'LIMIT' }]]));

  await pollOnce();

  const m = mirrorFor(replicas[0], 'CS-CAN');
  assert.ok(m.every((o) => o.status === 'CANCELLED'), 'mirror marked CANCELLED');
});

test('poller PAPER: master FILLED propagates to replica mirror', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1 });

  orders.unshift({
    id: 'rep-f', accountId: replicas[0].id, broker: 'coinswitch', symbol: 'TESTUSDT', side: 'BUY',
    orderType: 'LIMIT', price: 100, size: 1, filledSize: 0, status: 'OPEN', timeInForce: 'GTC',
    leverage: 1, timestamp: new Date().toISOString(), fee: 0, mode: 'PAPER',
    notes: 'Mirror of CS-FILL', mirrorsMasterOrderId: 'CS-FILL',
  });

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-FILL', status: 'FILLED', filledSize: 1, price: 100 })];
  lastPolled.set(master.id, new Map([['CS-FILL', { status: 'OPEN', price: 100, size: 1, side: 'BUY', orderType: 'LIMIT' }]]));

  await pollOnce();

  const m = mirrorFor(replicas[0], 'CS-FILL');
  assert.equal(m[0].status, 'FILLED');
  assert.equal(m[0].filledSize, 1);
});

test('poller PAPER: master PARTIALLY_FILLED propagates to replica mirror', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1 });

  orders.unshift({
    id: 'rep-pf', accountId: replicas[0].id, broker: 'coinswitch', symbol: 'TESTUSDT', side: 'BUY',
    orderType: 'LIMIT', price: 100, size: 10, filledSize: 0, status: 'OPEN', timeInForce: 'GTC',
    leverage: 1, timestamp: new Date().toISOString(), fee: 0, mode: 'PAPER',
    notes: 'Mirror of CS-PF', mirrorsMasterOrderId: 'CS-PF',
  });

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-PF', status: 'PARTIALLY_FILLED', filledSize: 3, price: 100 })];
  lastPolled.set(master.id, new Map([['CS-PF', { status: 'OPEN', price: 100, size: 10, side: 'BUY', orderType: 'LIMIT' }]]));

  await pollOnce();

  const m = mirrorFor(replicas[0], 'CS-PF');
  assert.equal(m[0].status, 'PARTIALLY_FILLED');
  assert.equal(m[0].filledSize, 3);
});

// ============================================================================
// REAL MODE: adapter-based placement on replicas
// ============================================================================

test('poller REAL: new order on master calls adapter.placeOrder on REAL replica', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1, replicaMode: 'REAL' });

  const repAdapter = getAdapter(replicas[0]);
  const calls = [];
  repAdapter.placeOrder = async (o) => { calls.push(o); return { orderId: 'rep-1', status: 'OPEN', filledSize: 0, price: 100, fee: 0.1, timestamp: new Date().toISOString() }; };

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-REAL' })];

  await pollOnce();

  assert.equal(calls.length, 1, 'adapter.placeOrder called once for REAL replica');
  assert.equal(calls[0].symbol, 'TESTUSDT');
  const m = mirrorFor(replicas[0], 'CS-REAL');
  assert.equal(m.length, 1);
  assert.equal(m[0].exchangeOrderId, 'rep-1', 'mirror stamped with exchange order id');
});

test('poller REAL: modify on REAL replica calls cancelOrder then placeOrder', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1, replicaMode: 'REAL' });

  const repAdapter = getAdapter(replicas[0]);
  const cancels = [];
  const places = [];
  repAdapter.cancelOrder = async (id) => { cancels.push(id); };
  repAdapter.placeOrder = async (o) => { places.push(o); return { orderId: 'rep-new', status: 'OPEN', filledSize: 0, price: o.price, fee: 0.1, timestamp: new Date().toISOString() }; };

  orders.unshift({
    id: 'rep-old', accountId: replicas[0].id, broker: 'coinswitch', symbol: 'TESTUSDT', side: 'BUY',
    orderType: 'LIMIT', price: 100, size: 1, filledSize: 0, status: 'OPEN', exchangeOrderId: 'rep-old', timeInForce: 'GTC',
    leverage: 1, timestamp: new Date().toISOString(), fee: 0, mode: 'REAL',
    notes: 'Mirror of CS-REALMOD', mirrorsMasterOrderId: 'CS-REALMOD',
  });

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-REALMOD', type: 'LIMIT', price: 105, size: 2, status: 'NEW' })];
  lastPolled.set(master.id, new Map([['CS-REALMOD', { status: 'OPEN', price: 100, size: 1, side: 'BUY', orderType: 'LIMIT' }]]));

  await pollOnce();

  assert.equal(cancels.length, 1, 'cancelOrder called on REAL replica');
  assert.equal(places.length, 1, 'placeOrder called for replacement');
  assert.equal(places[0].price, 105);
});

test('poller REAL: cancel on master calls adapter.cancelOrder on REAL replica', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1, replicaMode: 'REAL' });

  const repAdapter = getAdapter(replicas[0]);
  const cancels = [];
  repAdapter.cancelOrder = async (id) => { cancels.push(id); };

  orders.unshift({
    id: 'rep-c', accountId: replicas[0].id, broker: 'coinswitch', symbol: 'TESTUSDT', side: 'BUY',
    orderType: 'LIMIT', price: 100, size: 1, filledSize: 0, status: 'OPEN', exchangeOrderId: 'rep-c', timeInForce: 'GTC',
    leverage: 1, timestamp: new Date().toISOString(), fee: 0, mode: 'REAL',
    notes: 'Mirror of CS-REALCAN', mirrorsMasterOrderId: 'CS-REALCAN',
  });

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [];
  lastPolled.set(master.id, new Map([['CS-REALCAN', { status: 'OPEN', price: 100, size: 1, side: 'BUY', orderType: 'LIMIT' }]]));

  await pollOnce();

  assert.equal(cancels.length, 1, 'adapter.cancelOrder called for REAL replica cancel');
  const m = mirrorFor(replicas[0], 'CS-REALCAN');
  assert.ok(m.every((o) => o.status === 'CANCELLED'));
});

// ============================================================================
// GUARDS
// ============================================================================

test('poller: non-CoinSwitch REAL replica is not sent to CoinSwitch adapter', async () => {
  reset();
  const master = makeAcc('acc-test-master-nb', { isMaster: true, broker: 'coinswitch', mode: 'REAL' });
  const deltaRep = makeAcc('acc-test-delta-real', { broker: 'delta', mode: 'REAL' });
  mirrorConfig.masterAccountId = master.id;
  mirrorConfig.replicas = [{ accountId: deltaRep.id, active: true, multiplier: 1 }];

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-NB' })];
  const deltaAdapter = getAdapter(deltaRep);
  let placeCalled = false;
  deltaAdapter.placeOrder = async () => { placeCalled = true; return {}; };

  await pollOnce();

  assert.equal(placeCalled, false, 'Delta replica not placed via CoinSwitch adapter');
});

test('poller: non-REAL / non-master account is not polled', async () => {
  reset();
  const notMaster = makeAcc('acc-test-notmaster', { broker: 'coinswitch', mode: 'PAPER', isMaster: false });
  let getOpenCalled = false;
  const adapter = getAdapter(notMaster);
  adapter.getOpenOrders = async () => { getOpenCalled = true; return []; };

  await pollOnce();

  assert.equal(getOpenCalled, false, 'non-master account not polled');
});

// ============================================================================
// ERROR HANDLING / SNAPSHOT
// ============================================================================

test('poller: adapter failure caught, snapshot still saved, no crash', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1, replicaMode: 'REAL' });

  const repAdapter = getAdapter(replicas[0]);
  repAdapter.placeOrder = async () => { throw new Error('Network down'); };

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-ERR' })];

  await assert.doesNotReject(pollOnce());

  assert.ok(lastPolled.has(master.id), 'lastPolled saved even when mirror fails');
  assert.equal(mirrorFor(replicas[0], 'CS-ERR').length, 0, 'no mirror on failure');
});

test('poller: failed replica does not block healthy replica in same cycle', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 2, replicaMode: 'REAL' });

  const rep0 = getAdapter(replicas[0]);
  const rep1 = getAdapter(replicas[1]);
  rep0.placeOrder = async () => { throw new Error('rep0 down'); };
  rep1.placeOrder = async () => ({ orderId: 'rep1', status: 'OPEN', filledSize: 0, price: 100, fee: 0.1, timestamp: new Date().toISOString() });

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-A' }), newOrder({ orderId: 'CS-B' })];

  await pollOnce();

  const m1 = mirrorFor(replicas[1], 'CS-B');
  assert.equal(m1.length, 1, 'second order mirrored to healthy replica despite first failing');
});

test('poller: lastPolled prevents reprocessing same order next cycle', async () => {
  reset();
  const { master, replicas } = await setupMirror({ replicaCount: 1, replicaMode: 'REAL' });

  let placeCalls = 0;
  const repAdapter = getAdapter(replicas[0]);
  repAdapter.placeOrder = async () => { placeCalls++; return { orderId: 'rep', status: 'OPEN', filledSize: 0, price: 100, fee: 0.1, timestamp: new Date().toISOString() }; };

  const masterAdapter = getAdapter(master);
  masterAdapter.getOpenOrders = async () => [newOrder({ orderId: 'CS-SNAP' })];

  await pollOnce();
  assert.equal(placeCalls, 1);

  await pollOnce();
  assert.equal(placeCalls, 1, 'no re-mirror in second cycle');
});
