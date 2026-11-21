import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accounts, orders, emergencyStop } from '../server/state.js';
import { activateEmergencyStop, cancelAllOpenOrders } from '../server/safety.js';

const setup = () => {
  accounts.length = 0; orders.length = 0;
  accounts.push(
    { id: 'real-delta', broker: 'delta', mode: 'REAL', totalEquityUSDT: 1000, availableMarginUSDT: 1000 },
    { id: 'paper-cs', broker: 'coinswitch', mode: 'PAPER', totalEquityUSDT: 1000, availableMarginUSDT: 1000 },
  );
  orders.push(
    { id: 'o-real', exchangeOrderId: 'EX1', accountId: 'real-delta', symbol: 'BTCUSDT', side: 'BUY', price: 10, size: 1, status: 'OPEN', mode: 'REAL' },
    { id: 'o-paper', accountId: 'paper-cs', symbol: 'BTCUSDT', side: 'BUY', price: 10, size: 1, status: 'OPEN' },
  );
  activateEmergencyStop('test', 'test');
  return emergencyStop.confirmNonce;
};

test('emergency cancel-all cancels REAL orders on the exchange (any broker) and PAPER orders locally', async () => {
  const nonce = setup();
  const calls = [];
  const adapter = { cancelOrder: async (accountId, orderId, symbol) => { calls.push([accountId, orderId, symbol]); } };
  const r = await cancelAllOpenOrders(nonce, (acc) => (acc.id === 'real-delta' ? adapter : assert.fail('paper account must not hit an exchange adapter')));
  assert.deepEqual(calls, [['real-delta', 'EX1', 'BTCUSDT']]);
  assert.equal(r.cancelled.length, 2);
  assert.ok(orders.every((o) => o.status === 'CANCELLED'));
});

test('a failed exchange cancel leaves the REAL order OPEN and reports it', async () => {
  const nonce = setup();
  const adapter = { cancelOrder: async () => { throw new Error('exchange down: 503'); } };
  const r = await cancelAllOpenOrders(nonce, () => adapter);
  assert.equal(orders.find((o) => o.id === 'o-real').status, 'OPEN');
  assert.equal(r.failed.length, 1);
  assert.equal(orders.find((o) => o.id === 'o-paper').status, 'CANCELLED');
});
