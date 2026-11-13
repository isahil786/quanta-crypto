import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accounts, orders, positions, holdings, trades } from '../server/state.js';
import { generateGridRungs, checkGridSpacing, qslScale, generateSquareLevels, f_priceLevel, seedGridInventory, __runners } from '../server/bots.js';

const reset = () => { orders.length = 0; trades.length = 0; positions.length = 0; };
const spotAcc = () => { const a = accounts.find((x) => x.id === 'acc-cs-01'); a.availableMarginUSDT = 10000; a.totalEquityUSDT = 10000; holdings.splice(0, holdings.length, ...holdings.filter((h) => h.accountId !== a.id || h.asset === 'USDT')); return a; };
const bot = (extra) => ({ id: 'b', symbol: 'XUSDT', status: 'RUNNING', logs: [], completedRounds: 0, broker: 'coinswitch', accountId: 'acc-cs-01', ...extra });

test('grid: exactly one order per interval, no duplicate price lines', () => {
  const r = generateGridRungs({ lowerPrice: 90, upperPrice: 110, gridCount: 10, currentPrice: 100, sizePerGrid: 1 });
  assert.equal(r.length, 10);
  assert.equal(r.filter((x) => x.side === 'BUY').length, 5);
  assert.equal(r.filter((x) => x.side === 'SELL').length, 5);
  assert.equal(new Set(r.map((x) => x.price)).size, 10);
  for (const x of r) assert.ok(x.side === 'BUY' ? x.targetPrice > x.price : x.targetPrice < x.price);
});

test('grid: geometric ladder below range has no zero-spread rung; tight ranges keep distinct prices', () => {
  const g = generateGridRungs({ lowerPrice: 90, upperPrice: 110, gridCount: 10, currentPrice: 80, sizePerGrid: 1, gridMode: 'GEOMETRIC' });
  assert.ok(g.every((x) => x.targetPrice !== x.price));
  const t = generateGridRungs({ lowerPrice: 1.2, upperPrice: 1.24, gridCount: 20, currentPrice: 1.22, sizePerGrid: 1 });
  assert.equal(new Set(t.map((x) => x.price)).size, 20);
});

test('grid: spacing below the round-trip fee is rejected', () => {
  assert.match(checkGridSpacing({ lowerPrice: 100, upperPrice: 101, gridCount: 20, feePercent: 0.1 }), /round-trip fee/);
  assert.equal(checkGridSpacing({ lowerPrice: 90, upperPrice: 110, gridCount: 10, feePercent: 0.1 }), null);
});

test('grid run: buys on the way down, sells on the way up, inventory and cost stay consistent', () => {
  reset(); const a = spotAcc();
  const b = bot({ sizePerGrid: 1, rungs: generateGridRungs({ lowerPrice: 90, upperPrice: 110, gridCount: 10, currentPrice: 100, sizePerGrid: 1 }), realizedProfitUSDT: 0, totalBaseHoldings: 0, initialPrice: 100 });
  assert.ok(seedGridInventory(b, a, 100).ok);
  assert.equal(b.totalBaseHoldings, 5);
  for (const p of [100, 97, 94, 91, 96, 101, 104, 108, 103, 99, 95, 100]) __runners.runGrid(b, p);
  const held = holdings.find((h) => h.accountId === a.id && h.asset === 'X')?.total ?? 0;
  assert.ok(Math.abs(held - b.totalBaseHoldings) < 1e-9, 'bot inventory matches account inventory');
  assert.ok(b.realizedProfitUSDT > 0);
  assert.equal(new Set(b.rungs.map((r) => `${r.side}${r.price}`)).size, b.rungs.length, 'no two rungs rest at the same price/side');
  const cost = b.inventoryCostUSDT;
  assert.ok(Math.abs(b.unrealizedPnlUSDT - (b.totalBaseHoldings * 100 - cost)) < 0.05);
});

test('QSL: level spacing always clears the round-trip fee and is never absurdly wide', () => {
  for (const px of [90123.45, 2.5, 0.8123, 187.34, 3.1234, 0.000123]) {
    const sc = qslScale(px, 0.1);
    assert.ok(sc.spacingPct >= 0.4 * 0.99, `${px}: spacing ${sc.spacingPct}% too tight`);
    assert.ok(sc.spacingPct <= 3, `${px}: spacing ${sc.spacingPct}% too wide`);
    const lv = generateSquareLevels({ centerNumber: sc.baseNumber, levelsEachSide: 3, currentPrice: px, multiplier: sc.multiplier, sizePerGrid: 1, stride: sc.stride });
    const prices = lv.map((l) => l.price);
    assert.deepEqual(prices, [...prices].sort((x, y) => x - y));
    for (const l of lv) assert.ok(l.side === 'BUY' ? l.targetPrice > l.price : l.targetPrice < l.price, `${px}: target on wrong side`);
  }
});

test('QSL: recenter trigger does not drift after rungs flip', () => {
  reset(); const a = spotAcc();
  const px = 187.34; const sc = qslScale(px, 0.1);
  const levels = generateSquareLevels({ centerNumber: sc.baseNumber, levelsEachSide: 5, currentPrice: px, multiplier: sc.multiplier, sizePerGrid: 1, stride: sc.stride });
  const b = bot({ levels, rungs: levels, levelsEachSide: 5, triggerLevel: 2, sizePerGrid: 1, baseNumber: sc.baseNumber, multiplier: sc.multiplier, decimalPlaces: sc.decimals, stride: sc.stride, realizedProfitUSDT: 0, totalBaseHoldings: 0, initialPrice: px });
  assert.ok(seedGridInventory(b, a, px).ok);
  const trigger = f_priceLevel(sc.baseNumber + 2 * sc.stride, sc.multiplier);
  const lvl1 = f_priceLevel(sc.baseNumber + sc.stride, sc.multiplier);
  __runners.runQSL(b, lvl1 + 0.001);          // fills the +1 rung, flips it
  assert.equal(b.baseNumber, sc.baseNumber, 'no recenter below the trigger');
  __runners.runQSL(b, trigger + 0.001);        // crossing the trigger recenters
  assert.notEqual(b.baseNumber, sc.baseNumber);
});

test('TWAP: exactly N slices, last slice takes the remainder; gives up when unfundable', () => {
  reset(); spotAcc();
  const mk = (totalSize) => bot({ type: 'TWAP_SLICER', side: 'BUY', totalSize, executedSize: 0, slicesCount: 3, completedSlices: 0, intervalSeconds: 1, nextExecutionTime: 0, averageExecPrice: 100 });
  const t = mk(1); let now = 1000;
  for (let i = 0; i < 6; i++) { __runners.runTwap(t, 100, now); now += 1500; }
  assert.equal(t.status, 'COMPLETED'); assert.equal(t.completedSlices, 3); assert.equal(t.executedSize, 1);
  const u = mk(1e9); now = 1000;
  for (let i = 0; i < 8; i++) { __runners.runTwap(u, 100, now); now += 1500; }
  assert.equal(u.status, 'ERROR');
});

test('grid risk limits: inventory cap blocks buys, stop-loss sells everything and stops the bot', () => {
  reset(); const a = spotAcc();
  const mk = (extra) => bot({ sizePerGrid: 1, rungs: generateGridRungs({ lowerPrice: 90, upperPrice: 110, gridCount: 10, currentPrice: 100, sizePerGrid: 1 }), realizedProfitUSDT: 0, totalBaseHoldings: 0, initialPrice: 100, ...extra });
  const capped = mk({ maxInventory: 5 });
  assert.ok(seedGridInventory(capped, a, 100).ok);          // seeds 5 = cap
  for (const p of [97, 94, 91]) __runners.runGrid(capped, p);
  assert.equal(capped.totalBaseHoldings, 5, 'no buys beyond the cap');
  assert.ok(capped.logs.some((l) => /max inventory/.test(l.text)));

  reset(); spotAcc();
  const tooSmall = mk({ maxInventory: 2 });
  assert.equal(seedGridInventory(tooSmall, a, 100).ok, false, 'seed larger than the cap is refused');

  reset(); spotAcc();
  const sl = mk({ maxInventory: 10, stopLossPrice: 85, takeProfitPrice: 115 });
  assert.ok(seedGridInventory(sl, a, 100).ok);
  __runners.runGrid(sl, 97);
  __runners.runGrid(sl, 84);
  assert.equal(sl.status, 'STOPPED_OUT'); assert.equal(sl.stopReason, 'STOP_LOSS');
  assert.equal(sl.totalBaseHoldings, 0);
  assert.equal(holdings.find((h) => h.accountId === a.id && h.asset === 'X')?.total ?? 0, 0, 'account inventory sold');

  reset(); spotAcc();
  const tp = mk({ maxInventory: 10, takeProfitPrice: 115 });
  assert.ok(seedGridInventory(tp, a, 100).ok);
  __runners.runGrid(tp, 116);
  assert.equal(tp.status, 'STOPPED_OUT'); assert.equal(tp.stopReason, 'TAKE_PROFIT');
});
