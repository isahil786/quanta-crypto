import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accounts, orders, mirrorConfig, holdings } from '../server/state.js';
import { shouldMirror, mirrorFilledOrder } from '../server/mirror.js';

function reset() {
  accounts.length = 0;
  orders.length = 0;
  holdings.length = 0;
  mirrorConfig.enabled = true;
  mirrorConfig.masterAccountId = 'master-1';
  mirrorConfig.replicas = [];
  mirrorConfig.logs = [];
}

function addAccount(overrides = {}) {
  const a = {
    id: overrides.id || `acc-${Date.now()}`,
    broker: 'coinswitch', accountName: 'Test', segment: 'SPOT',
    status: 'ACTIVE', mode: 'PAPER', apiKey: '', apiSecret: '', apiKeyMasked: '',
    createdAt: new Date().toISOString(), totalEquityUSDT: 10000, availableMarginUSDT: 10000,
    unrealizedPnlUSDT: 0, isMaster: false, ...overrides,
  };
  accounts.push(a);
  if (overrides.asset === 'USDT' || !overrides.asset) {
    holdings.push({
      accountId: a.id, broker: a.broker, asset: 'USDT', name: 'USDT',
      free: a.availableMarginUSDT, locked: 0, total: a.availableMarginUSDT,
      rateUSDT: 1.0, valueUSDT: a.availableMarginUSDT,
    });
  }
  return a;
}

function addHolding(accountId, asset, total, free) {
  holdings.push({ accountId, broker: 'coinswitch', asset, name: asset,
    free, locked: 0, total, rateUSDT: 1.0, valueUSDT: total });
}

// ---------- shouldMirror ----------

test('shouldMirror: false when mirror is disabled', () => {
  reset();
  mirrorConfig.enabled = false;
  const master = addAccount({ id: 'master-1', isMaster: true });
  mirrorConfig.masterAccountId = master.id;
  const order = { status: 'FILLED', id: 'ord-1', source: undefined, notes: '' };
  assert.equal(shouldMirror(master, order), false);
});

test('shouldMirror: false when account is not master', () => {
  reset();
  const replica = addAccount({ id: 'rep-1', isMaster: false });
  mirrorConfig.masterAccountId = 'master-1';
  const order = { status: 'FILLED', id: 'ord-1', source: undefined, notes: '' };
  assert.equal(shouldMirror(replica, order), false);
});

test('shouldMirror: false when order is not FILLED', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true });
  mirrorConfig.masterAccountId = master.id;
  for (const s of ['OPEN', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED']) {
    assert.equal(shouldMirror(master, { status: s, id: 'ord-1', source: undefined, notes: '' }), false);
  }
});

test('shouldMirror: false when order is a mirror order (notes starts with Mirror of)', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true });
  mirrorConfig.masterAccountId = master.id;
  const order = { status: 'FILLED', id: 'ord-1', source: undefined, notes: 'Mirror of ord-0' };
  assert.equal(shouldMirror(master, order), false);
});

test('shouldMirror: false when order.source is set (bot/rule fill)', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true });
  mirrorConfig.masterAccountId = master.id;
  const order = { status: 'FILLED', id: 'ord-1', source: 'grid-bot', notes: '' };
  assert.equal(shouldMirror(master, order), false);
});

test('shouldMirror: true when master, enabled, FILLED, not a mirror order', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true });
  mirrorConfig.masterAccountId = master.id;
  const order = { status: 'FILLED', id: 'ord-1', source: undefined, notes: '' };
  assert.equal(shouldMirror(master, order), true);
});

// ---------- mirrorFilledOrder ----------

test('mirrorFilledOrder: replicates filled master order to active replica at 1x', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true, availableMarginUSDT: 10000 });
  mirrorConfig.masterAccountId = master.id;
  const replica = addAccount({ id: 'rep-1', availableMarginUSDT: 10000 });
  mirrorConfig.replicas.push({ accountId: replica.id, multiplier: 1.0, active: true, maxSlippagePercent: 5 });

  const order = { id: 'ord-master', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', size: 1, price: 100, filledSize: 1, status: 'FILLED', leverage: 1, source: undefined, notes: '' };
  const result = mirrorFilledOrder(master, order, 100, { quoteVolume: 1e6 });

  const repOrders = orders.filter((o) => o.accountId === replica.id && o.notes === 'Mirror of ord-master');
  assert.equal(repOrders.length, 1, 'replica order should be created');
  assert.equal(repOrders[0].size, 1, 'replica size should match master at 1x');
  assert.equal(repOrders[0].status, 'FILLED');
  assert.equal(repOrders[0].price, 100);
});

test('mirrorFilledOrder: applies multiplier to replica size', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true, availableMarginUSDT: 10000 });
  mirrorConfig.masterAccountId = master.id;
  const replica = addAccount({ id: 'rep-1', availableMarginUSDT: 20000 });
  mirrorConfig.replicas.push({ accountId: replica.id, multiplier: 0.5, active: true, maxSlippagePercent: 5 });

  const order = { id: 'ord-master', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', size: 10, price: 100, filledSize: 10, status: 'FILLED', leverage: 1, source: undefined, notes: '' };
  mirrorFilledOrder(master, order, 100, { quoteVolume: 1e6 });

  const repOrders = orders.filter((o) => o.accountId === replica.id);
  assert.equal(repOrders.length, 1);
  assert.equal(repOrders[0].size, 5, 'replica size should be 10 * 0.5 = 5');
});

test('mirrorFilledOrder: skips inactive replicas', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true, availableMarginUSDT: 10000 });
  mirrorConfig.masterAccountId = master.id;
  const replica = addAccount({ id: 'rep-1', availableMarginUSDT: 10000 });
  mirrorConfig.replicas.push({ accountId: replica.id, multiplier: 1.0, active: false, maxSlippagePercent: 5 });

  const order = { id: 'ord-master', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', size: 1, price: 100, filledSize: 1, status: 'FILLED', leverage: 1, source: undefined, notes: '' };
  mirrorFilledOrder(master, order, 100, { quoteVolume: 1e6 });

  const repOrders = orders.filter((o) => o.accountId === replica.id);
  assert.equal(repOrders.length, 0, 'inactive replica should not receive mirror order');
});

test('mirrorFilledOrder: skips replica when size rounds to zero', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true, availableMarginUSDT: 10000 });
  mirrorConfig.masterAccountId = master.id;
  const replica = addAccount({ id: 'rep-1', availableMarginUSDT: 10000 });
  mirrorConfig.replicas.push({ accountId: replica.id, multiplier: 0.000000001, active: true, maxSlippagePercent: 5 });

  const order = { id: 'ord-master', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', size: 1, price: 100, filledSize: 1, status: 'FILLED', leverage: 1, source: undefined, notes: '' };
  mirrorFilledOrder(master, order, 100, { quoteVolume: 1e6 });

  const repOrders = orders.filter((o) => o.accountId === replica.id);
  assert.equal(repOrders.length, 0);
  assert.equal(mirrorConfig.logs[0].status, 'SKIPPED');
  assert.ok(/rounded to zero/.test(mirrorConfig.logs[0].details));
});

test('mirrorFilledOrder: adapts MARKET to LIMIT for CoinSwitch Spot replica', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true, availableMarginUSDT: 10000 });
  mirrorConfig.masterAccountId = master.id;
  const replica = addAccount({ id: 'rep-1', broker: 'coinswitch', segment: 'SPOT', availableMarginUSDT: 10000 });
  mirrorConfig.replicas.push({ accountId: replica.id, multiplier: 1.0, active: true, maxSlippagePercent: 5 });

  const order = { id: 'ord-master', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', size: 1, price: 100, filledSize: 1, status: 'FILLED', leverage: 1, source: undefined, notes: '' };
  mirrorFilledOrder(master, order, 100, { quoteVolume: 1e6 });

  const repOrders = orders.filter((o) => o.accountId === replica.id);
  assert.equal(repOrders.length, 1);
  assert.equal(repOrders[0].orderType, 'LIMIT', 'MARKET should be adapted to LIMIT for CoinSwitch Spot');
  assert.ok(/ADAPTED/.test(mirrorConfig.logs[0].status));
});

test('mirrorFilledOrder: rejects replica when expected slippage exceeds maxSlippagePercent', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true, availableMarginUSDT: 10000 });
  mirrorConfig.masterAccountId = master.id;
  const replica = addAccount({ id: 'rep-1', availableMarginUSDT: 10000 });
  mirrorConfig.replicas.push({ accountId: replica.id, multiplier: 1.0, active: true, maxSlippagePercent: 0.001 });

  // Huge size on low liquidity -> high slippage
  const order = { id: 'ord-master', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', size: 1000000, price: 100, filledSize: 1000000, status: 'FILLED', leverage: 1, source: undefined, notes: '' };
  mirrorFilledOrder(master, order, 100, { quoteVolume: 1000 });

  const repOrders = orders.filter((o) => o.accountId === replica.id);
  assert.equal(repOrders.length, 0, 'order should be rejected due to slippage');
  assert.equal(mirrorConfig.logs[0].status, 'REJECTED');
  assert.ok(/slippage/.test(mirrorConfig.logs[0].details));
});

test('mirrorFilledOrder: rejects replica when insufficient margin', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true, availableMarginUSDT: 10000 });
  mirrorConfig.masterAccountId = master.id;
  const replica = addAccount({ id: 'rep-1', availableMarginUSDT: 1 }); // almost no funds
  mirrorConfig.replicas.push({ accountId: replica.id, multiplier: 1.0, active: true, maxSlippagePercent: 5 });

  const order = { id: 'ord-master', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', size: 1000, price: 100, filledSize: 1000, status: 'FILLED', leverage: 1, source: undefined, notes: '' };
  mirrorFilledOrder(master, order, 100, { quoteVolume: 1e6 });

  const repOrders = orders.filter((o) => o.accountId === replica.id);
  assert.equal(repOrders.length, 0, 'order should be rejected due to insufficient margin');
  assert.equal(mirrorConfig.logs[0].status, 'REJECTED');
});

test('mirrorFilledOrder: marks mirrored order notes with Mirror of <master id>', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true, availableMarginUSDT: 10000 });
  mirrorConfig.masterAccountId = master.id;
  const replica = addAccount({ id: 'rep-1', availableMarginUSDT: 10000 });
  mirrorConfig.replicas.push({ accountId: replica.id, multiplier: 1.0, active: true, maxSlippagePercent: 5 });

  const order = { id: 'ord-master-42', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', size: 1, price: 100, filledSize: 1, status: 'FILLED', leverage: 1, source: undefined, notes: '' };
  mirrorFilledOrder(master, order, 100, { quoteVolume: 1e6 });

  const repOrders = orders.filter((o) => o.accountId === replica.id);
  assert.equal(repOrders.length, 1);
  assert.equal(repOrders[0].notes, 'Mirror of ord-master-42');
});

test('mirrorFilledOrder: does not mirror to master account itself', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true, availableMarginUSDT: 10000 });
  mirrorConfig.masterAccountId = master.id;
  mirrorConfig.replicas.push({ accountId: master.id, multiplier: 1.0, active: true, maxSlippagePercent: 5 });

  const order = { id: 'ord-master', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', size: 1, price: 100, filledSize: 1, status: 'FILLED', leverage: 1, source: undefined, notes: '' };
  mirrorFilledOrder(master, order, 100, { quoteVolume: 1e6 });

  const masterOrders = orders.filter((o) => o.accountId === master.id && o.notes === 'Mirror of ord-master');
  assert.equal(masterOrders.length, 0, 'master should not receive its own mirror');
});

test('mirrorFilledOrder: caps mirror log at 500 entries', () => {
  reset();
  const master = addAccount({ id: 'master-1', isMaster: true, availableMarginUSDT: 10000 });
  mirrorConfig.masterAccountId = master.id;
  const replica = addAccount({ id: 'rep-1', availableMarginUSDT: 10000 });
  mirrorConfig.replicas.push({ accountId: replica.id, multiplier: 1.0, active: true, maxSlippagePercent: 5 });

  const order = { id: 'ord-master', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', size: 1, price: 100, filledSize: 1, status: 'FILLED', leverage: 1, source: undefined, notes: '' };
  for (let i = 0; i < 510; i++) {
    mirrorFilledOrder(master, { ...order, id: `ord-master-${i}` }, 100, { quoteVolume: 1e6 });
  }
  assert.ok(mirrorConfig.logs.length <= 500, `log should be capped at 500, got ${mirrorConfig.logs.length}`);
});
