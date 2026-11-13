import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accounts, orders, positions, holdings, trades } from '../server/state.js';
import { generateGridRungs, qslScale, generateSquareLevels, seedGridInventory, __runners } from '../server/bots.js';

// Deterministic PRNG so failures are reproducible
const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const reset = () => { orders.length = 0; trades.length = 0; positions.length = 0; };
const acct = () => { const a = accounts.find((x) => x.id === 'acc-cs-01'); a.availableMarginUSDT = 100000; a.totalEquityUSDT = 100000; holdings.splice(0, holdings.length, ...holdings.filter((h) => h.accountId !== a.id || h.asset === 'USDT')); return a; };
const held = (a) => holdings.find((h) => h.accountId === a.id && h.asset === 'X')?.total ?? 0;

function invariants(b, a, label) {
  assert.ok(Math.abs(held(a) - (b.totalBaseHoldings || 0)) < 1e-6, `${label}: bot inventory ${b.totalBaseHoldings} != account ${held(a)}`);
  assert.ok(a.availableMarginUSDT > -1e-6, `${label}: negative cash ${a.availableMarginUSDT}`);
  for (const k of ['realizedProfitUSDT', 'unrealizedPnlUSDT', 'inventoryCostUSDT', 'totalBaseHoldings']) assert.ok(Number.isFinite(b[k] ?? 0), `${label}: ${k} not finite`);
  assert.ok((b.totalBaseHoldings || 0) >= -1e-9, `${label}: negative inventory`);
  if (b.maxInventory) assert.ok(b.totalBaseHoldings <= b.maxInventory + 1e-6, `${label}: cap exceeded ${b.totalBaseHoldings} > ${b.maxInventory}`);
  const seen = new Set();
  for (const r of b.rungs) {
    assert.ok(r.side === 'BUY' ? r.targetPrice > r.price : r.targetPrice < r.price, `${label}: rung ${r.side} ${r.price}->${r.targetPrice} wrong side`);
  }
}

for (const seed of [1, 2, 3, 4, 5]) {
  test(`fuzz grid (seed ${seed}): random walk keeps books consistent`, () => {
    reset(); const a = acct(); const r = rng(seed);
    const b = { id: 'f', symbol: 'XUSDT', status: 'RUNNING', logs: [], completedRounds: 0, broker: 'coinswitch', accountId: a.id, sizePerGrid: 1, realizedProfitUSDT: 0, totalBaseHoldings: 0, initialPrice: 100, maxInventory: 12, lowerPrice: 80, upperPrice: 120, gridCount: 16 };
    b.rungs = generateGridRungs({ lowerPrice: 80, upperPrice: 120, gridCount: 16, currentPrice: 100, sizePerGrid: 1, gridMode: seed % 2 ? 'GEOMETRIC' : 'ARITHMETIC' });
    assert.ok(seedGridInventory(b, a, 100).ok);
    let p = 100;
    for (let i = 0; i < 3000 && b.status === 'RUNNING'; i++) {
      p = Math.max(1, p * (1 + (r() - 0.5) * 0.04)); // up to +-2% per tick, includes gaps across many rungs
      __runners.runGrid(b, p);
      invariants(b, a, `grid@${i} p=${p.toFixed(2)}`);
    }
  });

  test(`fuzz QSL (seed ${seed}): random walk with recentering keeps books consistent`, () => {
    reset(); const a = acct(); const r = rng(seed + 100);
    const px = 187.34; const sc = qslScale(px, 0.1);
    const levels = generateSquareLevels({ centerNumber: sc.baseNumber, levelsEachSide: 5, currentPrice: px, multiplier: sc.multiplier, sizePerGrid: 1, stride: sc.stride });
    const b = { id: 'q', symbol: 'XUSDT', status: 'RUNNING', logs: [], completedRounds: 0, broker: 'coinswitch', accountId: a.id, levels, rungs: levels, levelsEachSide: 5, triggerLevel: 2, sizePerGrid: 1, baseNumber: sc.baseNumber, multiplier: sc.multiplier, decimalPlaces: sc.decimals, stride: sc.stride, realizedProfitUSDT: 0, totalBaseHoldings: 0, initialPrice: px, maxInventory: 10 };
    assert.ok(seedGridInventory(b, a, px).ok);
    let p = px;
    for (let i = 0; i < 3000 && b.status === 'RUNNING'; i++) {
      p = Math.max(5, p * (1 + (r() - 0.5) * 0.03));
      __runners.runQSL(b, p);
      b.rungs = b.levels;
      invariants(b, a, `qsl@${i} p=${p.toFixed(2)}`);
    }
  });
}
