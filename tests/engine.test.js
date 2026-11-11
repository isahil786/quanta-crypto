import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uid } from '../server/util.js';
import { positions, orders, trades, accounts } from '../server/state.js';
import { applyToPosition, checkMargin, settleOrderFill, baseInventory } from '../server/positions.js';
import { simulateGridBot, optimizeGridStrategies, generateSimulationRungs } from '../server/backtest.js';
import { generateGridRungs, seedGridInventory, botsState, runBotsBackgroundCycle } from '../server/bots.js';

const acct = () => ({ id: 'a1', broker: 'delta', segment: 'FUTURES', totalEquityUSDT: 10000, availableMarginUSDT: 10000 });
const reset = () => { positions.length = 0; orders.length = 0; trades.length = 0; };

test('uid never collides within the same millisecond', () => {
  const ids = new Set(Array.from({ length: 5000 }, () => uid('x')));
  assert.equal(ids.size, 5000);
});

test('opposite-side order reduces a position instead of growing it', () => {
  reset();
  const a = acct();
  applyToPosition(a, { symbol: 'BTCUSDT', side: 'BUY', size: 1, price: 100, leverage: 10 });
  assert.equal(positions[0].size, 1);
  const pnl = applyToPosition(a, { symbol: 'BTCUSDT', side: 'SELL', size: 0.4, price: 110, leverage: 10 });
  assert.equal(positions[0].size, 0.6);
  assert.equal(Number(pnl.toFixed(6)), 4);
  assert.equal(a.totalEquityUSDT, 10004);
});

test('opposite order larger than position flips it', () => {
  reset();
  const a = acct();
  applyToPosition(a, { symbol: 'ETHUSDT', side: 'BUY', size: 1, price: 100, leverage: 5 });
  applyToPosition(a, { symbol: 'ETHUSDT', side: 'SELL', size: 3, price: 100, leverage: 5 });
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, 'SHORT');
  assert.equal(positions[0].size, 2);
});

test('closing a position releases margin and realises PnL', () => {
  reset();
  const a = acct();
  applyToPosition(a, { symbol: 'BTCUSDT', side: 'BUY', size: 1, price: 100, leverage: 10 });
  assert.equal(a.availableMarginUSDT, 9990);
  applyToPosition(a, { symbol: 'BTCUSDT', side: 'SELL', size: 1, price: 90, leverage: 10 });
  assert.equal(positions.length, 0);
  assert.equal(a.availableMarginUSDT, 9990 + 10 - 10);
  assert.equal(a.totalEquityUSDT, 9990);
});

test('margin check rejects over-leveraged orders', () => {
  reset();
  const a = acct();
  const r = checkMargin(a, { symbol: 'BTCUSDT', side: 'BUY', size: 100, leverage: 2 }, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.required, 50100); // margin 50000 + 0.1% fee
});

test('settleOrderFill charges the fee and writes a trade', () => {
  reset();
  const a = acct();
  const o = { id: 'o1', symbol: 'BTCUSDT', side: 'BUY', size: 1, leverage: 1 };
  const t = settleOrderFill(a, o, 100, 0.1);
  assert.equal(o.status, 'FILLED');
  assert.equal(t.fee, 0.1);
  assert.equal(a.totalEquityUSDT, 9999.9);
});

const tickerMock = (price) => async () => ({ ok: true, json: async () => [{ symbol: 'TESTUSDT', lastPrice: String(price), priceChangePercent: '1', quoteVolume: '5000000', highPrice: '200', lowPrice: '1', volume: '1', count: 1, bidPrice: '1', askPrice: '1', weightedAvgPrice: '1' }] });
const makeBot = (accountId, broker) => {
  const rungs = generateGridRungs({ lowerPrice: 90, upperPrice: 110, gridCount: 4, currentPrice: 100, sizePerGrid: 1 });
  return { id: 'b1', type: 'GRID_BOT', status: 'RUNNING', symbol: 'TESTUSDT', accountId, broker, side: 'BUY', initialPrice: 100, sizePerGrid: 1, rungs, totalBaseHoldings: 0, completedRounds: 0, realizedProfitUSDT: 0, logs: [] };
};
async function cycleAt(price) {
  const orig = globalThis.fetch;
  globalThis.fetch = tickerMock(price);
  try { await runBotsBackgroundCycle(); } finally { globalThis.fetch = orig; }
}

test('grid bot on a futures account: seed opens a long, sells reduce it, margin and equity move', async () => {
  reset(); botsState.bots.length = 0;
  const account = accounts.find((a) => a.id === 'acc-cdcx-01');
  const before = account.availableMarginUSDT;
  const bot = makeBot(account.id, 'coindcx');
  const seed = seedGridInventory(bot, account, 100);
  assert.equal(seed.ok, true);
  assert.equal(positions[0].side, 'LONG');
  assert.equal(positions[0].size, bot.totalBaseHoldings);
  assert.ok(account.availableMarginUSDT < before);
  botsState.bots.push(bot);
  await cycleAt(112); // sell rungs above fill, using the seeded inventory
  assert.ok(bot.realizedProfitUSDT > 0);
  assert.ok(positions.length === 0 || positions[0].size < bot.sizePerGrid * 3);
  assert.ok(trades.some((t) => t.side === 'SELL'));
  botsState.bots.length = 0;
});

test('grid bot never sells coins it does not hold', async () => {
  reset(); botsState.bots.length = 0;
  const account = accounts.find((a) => a.id === 'acc-cdcx-01');
  const bot = makeBot(account.id, 'coindcx'); // not seeded
  botsState.bots.push(bot);
  await cycleAt(115);
  assert.equal(bot.realizedProfitUSDT, 0);
  assert.equal(trades.length, 0);
  botsState.bots.length = 0;
});

test('spot accounting: buy moves USDT into holdings, sell without holdings is rejected', () => {
  reset();
  const spot = { id: 'spot1', broker: 'coinswitch', segment: 'SPOT', totalEquityUSDT: 1000, availableMarginUSDT: 1000 };
  const buy = { id: 'o1', symbol: 'SOLUSDT', side: 'BUY', size: 2, leverage: 1 };
  assert.equal(checkMargin(spot, buy, 100).ok, true);
  settleOrderFill(spot, buy, 100, 0.1);
  assert.equal(Number(spot.availableMarginUSDT.toFixed(2)), 799.8);
  const sell = { id: 'o2', symbol: 'SOLUSDT', side: 'SELL', size: 3, leverage: 1 };
  assert.equal(checkMargin(spot, sell, 110).ok, false);
  const sell2 = { id: 'o3', symbol: 'SOLUSDT', side: 'SELL', size: 2, leverage: 1 };
  settleOrderFill(spot, sell2, 110, 0.1);
  assert.equal(Number(spot.availableMarginUSDT.toFixed(2)), 1019.58);
  assert.equal(baseInventory(spot, 'SOLUSDT'), 0);
  assert.equal(checkMargin(spot, { symbol: 'SOLUSDT', side: 'BUY', size: 1000, leverage: 1 }, 100).ok, false);
});

const flat = (n, p = 100) => Array.from({ length: n }, (_, i) => ({ openTime: i * 3.6e6, closeTime: i * 3.6e6 + 3.6e6 - 1, open: p, high: p, low: p, close: p, volume: 1, quoteVolume: p, tradesCount: 1 }));

test('backtest: a single wide candle cannot produce a free round trip on one rung', () => {
  const k = flat(10);
  k[3] = { ...k[3], high: 104, low: 96 };
  const r = simulateGridBot({ klines: k, initialCapital: 1000, lowerPrice: 90, upperPrice: 110, gridCount: 4, feeRate: 0 });
  const perRung = r.rungs.map((x) => x.fillsCount);
  assert.ok(Math.max(...perRung) <= 1, `a rung filled twice in one candle: ${perRung}`);
});

test('backtest: win rate stays within 0-100% and no fabricated Sharpe', () => {
  const k = flat(60).map((c, i) => { const p = 100 + 5 * Math.sin(i / 3); return { ...c, open: p, close: p, high: p + 2, low: p - 2 }; });
  const r = simulateGridBot({ klines: k, initialCapital: 1000, lowerPrice: 90, upperPrice: 110, gridCount: 10 });
  assert.ok(r.winRate >= 0 && r.winRate <= 100);
  assert.ok(Number.isFinite(r.sharpeRatio));
  assert.equal(typeof r.aprReliable, 'boolean');
});

test('backtest: sub-cent prices keep distinct rungs', () => {
  const rungs = generateSimulationRungs({ lowerPrice: 0.00001, upperPrice: 0.00002, gridCount: 5, startPrice: 0.000015, sizePerGrid: 1 });
  const prices = new Set(rungs.map((r) => r.price));
  assert.equal(prices.size, rungs.length);
  assert.ok(rungs.every((r) => r.price > 0));
});

test('backtest: invalid ranges are rejected', () => {
  assert.throws(() => simulateGridBot({ klines: flat(10), lowerPrice: 120, upperPrice: 100 }), /range invalid/i);
});

test('optimizer ranks strategies by Sharpe ratio', () => {
  const k = flat(100).map((c, i) => { const p = 100 + 8 * Math.sin(i / 5); return { ...c, open: p, close: p, high: p + 1, low: p - 1 }; });
  const res = optimizeGridStrategies({ symbol: 'X', klines: k, initialCapital: 1000 });
  assert.ok(res.length > 0);
  for (let i = 1; i < res.length; i++) assert.ok(res[i - 1].sharpeRatio >= res[i].sharpeRatio);
  assert.equal(res.filter((r) => r.isWinner).length, 1);
  assert.equal(res[0].isWinner, true);
});

test('bots are priced for symbols outside the top-100 movers', async () => {
  reset(); botsState.bots.length = 0;
  const account = accounts.find((a) => a.id === 'acc-cdcx-01');
  const orig = globalThis.fetch;
  // 101 tickers with higher 24h change than BTCUSDT, so BTCUSDT falls outside the top-100 list
  const rows = Array.from({ length: 101 }, (_, i) => ({ symbol: `X${i}USDT`, lastPrice: '1', priceChangePercent: String(50 + i), quoteVolume: '5000000', highPrice: '2', lowPrice: '1', volume: '1', count: 1, bidPrice: '1', askPrice: '1', weightedAvgPrice: '1' }));
  rows.push({ symbol: 'BTCUSDT', lastPrice: '100', priceChangePercent: '0.1', quoteVolume: '5000000', highPrice: '110', lowPrice: '90', volume: '1', count: 1, bidPrice: '1', askPrice: '1', weightedAvgPrice: '1' });
  globalThis.fetch = async () => ({ ok: true, json: async () => rows });
  const { getLiveTop100MomentumCoins, getLiveCoin } = await import('../server/binance.js');
  try {
    await new Promise((r) => setTimeout(r, 3100)); // let any earlier cache expire
    const top = await getLiveTop100MomentumCoins();
    assert.ok(!top.some((c) => c.symbol === 'BTCUSDT'));
    assert.equal((await getLiveCoin('BTCUSDT')).price, 100);
  } finally { globalThis.fetch = orig; }
  assert.ok(account);
});

const cycleWith = async (symbol, price) => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ symbol, lastPrice: String(price), priceChangePercent: '1', quoteVolume: '5000000', highPrice: '999', lowPrice: '1', volume: '1', count: 1, bidPrice: '1', askPrice: '1', weightedAvgPrice: '1' }] });
  const { getLiveTop100MomentumCoins } = await import('../server/binance.js');
  try { await new Promise((r) => setTimeout(r, 3100)); await runBotsBackgroundCycle(); } finally { globalThis.fetch = orig; }
};

test('TP/SL auto-closes a position when the price reaches it', async () => {
  reset(); botsState.bots.length = 0;
  const account = accounts.find((a) => a.id === 'acc-cdcx-01');
  const before = account.totalEquityUSDT;
  applyToPosition(account, { symbol: 'TPUSDT', side: 'BUY', size: 1, price: 100, leverage: 5, tpPrice: 110, slPrice: 95 });
  await cycleWith('TPUSDT', 105); // inside the band: nothing happens
  assert.equal(positions.length, 1);
  await cycleWith('TPUSDT', 111); // take-profit hit
  assert.equal(positions.length, 0);
  assert.equal(orders[0].source, 'TP_SL');
  assert.ok(account.totalEquityUSDT > before + 9);
});

test('TP/SL stop-loss closes a short when price rises through it', async () => {
  reset(); botsState.bots.length = 0;
  const account = accounts.find((a) => a.id === 'acc-cdcx-01');
  applyToPosition(account, { symbol: 'SLUSDT', side: 'SELL', size: 1, price: 100, leverage: 5, tpPrice: 90, slPrice: 105 });
  await cycleWith('SLUSDT', 106);
  assert.equal(positions.length, 0);
});

test('a resting master limit order mirrors to replicas when it fills', async () => {
  reset(); botsState.bots.length = 0;
  const master = accounts.find((a) => a.isMaster);
  const replica = accounts.find((a) => a.id === 'acc-cdcx-01');
  const o = { id: 'lim1', accountId: master.id, broker: master.broker, symbol: 'MIRUSDT', side: 'BUY', orderType: 'LIMIT', price: 100, size: 1, filledSize: 0, status: 'OPEN', leverage: 1, timestamp: new Date().toISOString(), fee: 0 };
  orders.unshift(o);
  await cycleWith('MIRUSDT', 99);
  assert.equal(o.status, 'FILLED');
  assert.ok(orders.some((x) => x.accountId === replica.id && String(x.notes).startsWith('Mirror of lim1')));
});

test('checkTpSl-style guard: TP on the wrong side would close instantly, so TP/SL must bracket entry', () => {
  // Documented behaviour of the engine: a long with TP below price exits on the very next cycle.
  reset();
  const a = acct();
  applyToPosition(a, { symbol: 'WRUSDT', side: 'BUY', size: 1, price: 100, leverage: 2, tpPrice: 90 });
  assert.equal(positions[0].tpPrice, 90); // the API layer (not the engine) rejects this input
});

test('halal list: deduped, pegged assets dropped, renamed tickers mapped', async () => {
  const { getHalalCoins, isHalalSymbol } = await import('../server/halal.js');
  const syms = getHalalCoins().map((c) => c.symbol);
  assert.equal(new Set(syms).size, syms.length);
  assert.ok(isHalalSymbol('BTCUSDT') && isHalalSymbol('avaxusdt'));
  assert.ok(!isHalalSymbol('USDTUSDT') && !isHalalSymbol('DOGEEUSDT'));
  assert.ok(isHalalSymbol('POLUSDT')); // MATIC was renamed to POL
});

test('halalMarket joins the list with live prices and reports unlisted pairs', async () => {
  const { halalMarket } = await import('../server/halal.js');
  const idx = new Map([
    ['BTCUSDT', { symbol: 'BTCUSDT', price: 1, quoteVolume: 5, name: 'BTC' }],
    ['ETHUSDT', { symbol: 'ETHUSDT', price: 1, quoteVolume: 9, name: 'ETH' }],
    ['SHIBUSDT', { symbol: 'SHIBUSDT', price: 1, quoteVolume: 99, name: 'SHIB' }], // not halal-listed
  ]);
  const r = halalMarket(idx);
  assert.deepEqual(r.tradable.map((c) => c.symbol), ['ETHUSDT', 'BTCUSDT']);
  assert.equal(r.tradable[0].halalRank, 1);
  assert.ok(r.unavailable.some((c) => c.symbol === 'AVAXUSDT'));
});
