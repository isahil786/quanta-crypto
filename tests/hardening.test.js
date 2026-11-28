import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.QUANTA_TEST = '1';
const { app } = await import('../server.ts');
const { mirrorConfig } = await import('../server/state.js');
const { redact, installConsoleCapture, getLogs } = await import('../server/logs.js');

test('redact masks keys, secrets and bearer tokens', () => {
  const out = redact('apiKey=abcd1234 {"apiSecret":"deadbeef"} Authorization: Bearer xyz.123 /ws?token=s3cret&a=1');
  assert.ok(!/abcd1234|deadbeef|xyz\.123|s3cret/.test(out), out);
});

test('console capture survives circular objects and keeps Error stacks', () => {
  installConsoleCapture();
  const a = {}; a.self = a;
  console.log('circ', a);
  console.error(new Error('boom-test'));
  const msgs = getLogs().map((l) => l.message).join('\n');
  assert.match(msgs, /unserializable/);
  assert.match(msgs, /boom-test/);
  assert.ok(getLogs().every((l) => !('raw' in l)));
});

test('mirror CSV export neutralises formula injection', async () => {
  mirrorConfig.logs.unshift({ timestamp: 't', masterOrder: '=HYPERLINK("x")', targetAccount: '+cmd', status: '@sum', details: 'ok' });
  const r = await request(app).get('/api/mirror/logs/export');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(`"'=HYPERLINK(""x"")"`), r.text);
  assert.ok(r.text.includes(`"'+cmd"`) && r.text.includes(`"'@sum"`));
});
