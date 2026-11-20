import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.QUANTA_TEST = '1';
const { app } = await import('../server.ts');

test('emergency stop activates, issues a nonce, blocks orders, and resets', async () => {
  const on = await request(app).post('/api/safety/emergency-stop').send({ reason: 'test' });
  assert.equal(on.status, 200);
  assert.ok(on.body.emergencyStop.active);
  assert.ok(on.body.emergencyStop.confirmNonce, 'nonce must be issued');

  const blocked = await request(app).post('/api/orders').send({ accountId: 'x', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', size: 1 });
  assert.equal(blocked.status, 409);

  const noNonce = await request(app).post('/api/safety/emergency-stop/cancel-all').send({});
  assert.equal(noNonce.status, 400);

  const ok = await request(app).post('/api/safety/emergency-stop/cancel-all').send({ confirmNonce: on.body.emergencyStop.confirmNonce });
  assert.equal(ok.status, 200);

  const off = await request(app).post('/api/safety/emergency-stop/reset').send({});
  assert.equal(off.body.emergencyStop.active, false);
});

test('reconcile endpoint does not crash', async () => {
  const r = await request(app).post('/api/safety/reconcile').send({});
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.actions));
});
