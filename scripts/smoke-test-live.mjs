// Live smoke test for the master-to-replica order poller.
// YOU must edit the ACCOUNT_IDS below with your real account IDs from data/accounts.json.
// This script places REAL LIMIT orders on CoinSwitch — only run with funds you can afford to lose.
// Run: QUANTA_TEST=1 node scripts/smoke-test-live.mjs

import { accounts } from './server/state.js';
import { CoinSwitchAdapter } from './server/execution/coinswitch.js';

// ==================== EDIT THESE ====================
const MASTER_ACCOUNT_ID = 'YOUR_MASTER_ACCOUNT_ID';   // acc-cs-xxx (mode: REAL, isMaster: true)
const REPLICA_ACCOUNT_IDS = ['YOUR_REPLICA_ACCOUNT_ID']; // acc-cs-yyy (mode: REAL or PAPER)
const SYMBOL = 'TESTUSDT';                            // must be a live Binance USDT pair
const ORDER_SIZE = 0.001;                             // TINY — smallest size you're comfortable losing
const LIMIT_PRICE = 50;                               // set far from market so it won't fill accidentally
// ====================================================

const placedOrderIds = [];   // master order ids placed by this script
const cleanup = async () => {
  console.log('\n[cleanup] cancelling all orders placed by this test...');
  for (const orderId of placedOrderIds) {
    try {
      const adapter = new CoinSwitchAdapter({
        id: MASTER_ACCOUNT_ID,
        broker: 'coinswitch',
        apiKey: process.env.MASTER_API_KEY || '',
        apiSecret: process.env.MASTER_API_SECRET || '',
        segment: 'SPOT',
        exchange: 'c2c1',
      });
      await adapter.cancelOrder(MASTER_ACCOUNT_ID, orderId, SYMBOL);
      console.log(`  cancelled ${orderId}`);
    } catch (e) {
      console.log(`  could not cancel ${orderId}: ${e.message}`);
    }
  }
};
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(143); });

const assert = (cond, msg) => {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  console.log(`  ok: ${msg}`);
};

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  PASS: ${name}`); }
  else { console.error(`  FAIL: ${name} ${detail}`); failures++; }
};

(async () => {
  console.log('=== Live Poller Smoke Test ===\n');

  // 1. Load accounts from seed file
  console.log('[1/6] Loading accounts from data/accounts.json...');
  const master = accounts.find((a) => a.id === MASTER_ACCOUNT_ID);
  assert(!!master, `master account ${MASTER_ACCOUNT_ID} found in accounts`);
  assert(master.mode === 'REAL', `master mode is REAL (got ${master.mode})`);
  assert(master.isMaster === true, `master isMaster is true`);
  assert(!!master.apiKey && !!master.apiSecret, 'master has apiKey and apiSecret');

  for (const rid of REPLICA_ACCOUNT_IDS) {
    const rep = accounts.find((a) => a.id === rid);
    assert(!!rep, `replica account ${rid} found in accounts`);
    assert(rep.broker === 'coinswitch', `replica ${rid} broker is coinswitch`);
    assert(!!rep.apiKey && !!rep.apiSecret, `replica ${rid} has apiKey and apiSecret`);
  }

  // 2. Verify master credentials work (getAccountInfo / getOpenOrders)
  console.log('\n[2/6] Verifying master API credentials...');
  const masterAdapter = new CoinSwitchAdapter({
    id: master.id, broker: master.broker, apiKey: master.apiKey, apiSecret: master.apiSecret,
    segment: master.segment, exchange: master.exchange,
  });
  try {
    const info = await masterAdapter.getAccountInfo(master.id);
    assert(info.balances.length > 0, 'master getAccountInfo returned balances');
  } catch (e) {
    console.error(`  FAIL: master API call failed: ${e.message}`);
    failures++;
  }

  // 3. Place a small LIMIT order on master
  console.log(`\n[3/6] Placing small LIMIT BUY ${ORDER_SIZE} ${SYMBOL} @ ${LIMIT_PRICE} on master...`);
  let masterOrder;
  try {
    masterOrder = await masterAdapter.placeOrder({
      accountId: master.id, symbol: SYMBOL, side: 'BUY', type: 'LIMIT',
      size: ORDER_SIZE, price: LIMIT_PRICE, timeInForce: 'GTC',
    });
    placedOrderIds.push(masterOrder.orderId);
    assert(!!masterOrder.orderId, 'master order placed and returned an orderId');
    assert(masterOrder.status === 'OPEN' || masterOrder.status === 'NEW', `master order status OPEN/NEW (got ${masterOrder.status})`);
  } catch (e) {
    console.error(`  FAIL: master placeOrder failed: ${e.message}`);
    failures++;
  }

  // 4. Wait briefly for poller to detect and mirror (poller runs server-side; here we just verify the order exists on exchange)
  console.log('\n[4/6] Verifying master order is live on exchange...');
  try {
    const openOrders = await masterAdapter.getOpenOrders(master.id);
    const found = openOrders.find((o) => o.orderId === masterOrder.orderId);
    assert(!!found, 'master order appears in getOpenOrders');
  } catch (e) {
    console.error(`  FAIL: getOpenOrders failed: ${e.message}`);
    failures++;
  }

  // 5. Verify replica credential validity (getAccountInfo on each replica)
  console.log('\n[5/6] Verifying replica API credentials...');
  for (const rid of REPLICA_ACCOUNT_IDS) {
    const rep = accounts.find((a) => a.id === rid);
    const repAdapter = new CoinSwitchAdapter({
      id: rep.id, broker: rep.broker, apiKey: rep.apiKey, apiSecret: rep.apiSecret,
      segment: rep.segment, exchange: rep.exchange,
    });
    try {
      const info = await repAdapter.getAccountInfo(rep.id);
      assert(info.balances.length > 0, `replica ${rid} getAccountInfo returned balances`);
    } catch (e) {
      console.error(`  FAIL: replica ${rid} API call failed: ${e.message}`);
      failures++;
    }
  }

  // 6. Cancel the master order (cleanup)
  console.log(`\n[6/6] Cancelling master order ${masterOrder?.orderId}...`);
  try {
    await masterAdapter.cancelOrder(master.id, masterOrder.orderId, SYMBOL);
    assert(true, 'master order cancel request sent');
  } catch (e) {
    console.error(`  FAIL: master cancelOrder failed: ${e.message}`);
    failures++;
  }

  // Summary
  console.log('\n=== Smoke Test Summary ===');
  if (failures === 0) {
    console.log('ALL CHECKS PASSED — credentials and order placement work on the live exchange.');
    console.log('Note: This test did NOT verify server-side poller mirroring (that requires the server running with the poller active).');
    console.log('To test full mirroring: start the server, place an order via the mobile app, and confirm it appears on replicas.');
  } else {
    console.error(`${failures} check(s) failed — do NOT proceed to live trading until resolved.`);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
