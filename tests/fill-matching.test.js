import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOrderForEvent } from '../server/positions.js';

// Newest first, like the real `orders` array. Neither order has a clientOrderId field.
const list = () => [
  { id: 'ord-new', accountId: 'a1', exchangeOrderId: '222' },
  { id: 'ord-old', accountId: 'a1', exchangeOrderId: '111' },
  { id: 'ord-other', accountId: 'a2', exchangeOrderId: '111' },
];

test('an event without clientOrderId matches by exchange id, not the newest order', () => {
  assert.equal(findOrderForEvent(list(), 'a1', { orderId: '111' }).id, 'ord-old');
});

test('numeric exchange ids match string ids', () => {
  assert.equal(findOrderForEvent(list(), 'a1', { orderId: 111 }).id, 'ord-old');
});

test('matches by client order id (stored as order.id) when the exchange id is unknown', () => {
  assert.equal(findOrderForEvent(list(), 'a1', { clientOrderId: 'ord-new' }).id, 'ord-new');
});

test('never matches another account, and an event with no ids matches nothing', () => {
  assert.equal(findOrderForEvent(list(), 'a2', { orderId: '222' }), undefined);
  assert.equal(findOrderForEvent(list(), 'a1', {}), undefined);
  assert.equal(findOrderForEvent(list(), 'a1', { orderId: '999' }), undefined);
});
