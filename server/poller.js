// Order poller: polls CoinSwitch for order changes on master accounts
// and replicates create / modify / cancel operations to all mirror accounts.
import { accounts, orders, mirrorConfig } from './state.js';
import { checkMargin, releaseOrder, reserveOrder } from './positions.js';
import { executionCost } from './costs.js';
import { uid } from './util.js';
import { CoinSwitchAdapter } from './execution/coinswitch.js';
import { getLivePriceIndex } from './binance.js';

const POLL_INTERVAL_MS = 8000;
let timer = null;
let cycleRunning = false;
const adapters = new Map();      // accountId -> CoinSwitchAdapter
const lastPolled = new Map();    // accountId -> Map<exchangeOrderId, snapshot>

function getAdapter(account) {
  let adapter = adapters.get(account.id);
  if (!adapter) {
    adapter = new CoinSwitchAdapter({
      id: account.id,
      broker: account.broker,
      apiKey: account.apiKey || '',
      apiSecret: account.apiSecret || '',
      segment: account.segment,
      exchange: account.exchange,
    });
    adapters.set(account.id, adapter);
  }
  return adapter;
}

function isMasterAccount(a) {
  return Boolean(a.isMaster && a.mode === 'REAL' && a.broker === 'coinswitch' && a.status === 'ACTIVE');
}

export function getMasterAccounts() {
  return accounts.filter(isMasterAccount);
}

function getReplicaAccounts(masterAccountId) {
  return mirrorConfig.replicas
    .filter((r) => r.active && r.accountId !== masterAccountId)
    .map((r) => accounts.find((a) => a.id === r.accountId))
    .filter(Boolean);
}

function replicaFor(replicas, accountId) {
  return replicas.find((r) => r.accountId === accountId);
}

function normalizeStatus(s) {
  switch (String(s).toUpperCase()) {
    case 'NEW': return 'OPEN';
    case 'CANCELED': case 'CANCELLED': return 'CANCELLED';
    default: return s;
  }
}

function snap(eo) {
  return {
    status: normalizeStatus(eo.status),
    price: eo.price,
    size: eo.size,
    side: eo.side,
    orderType: eo.type,
    timestamp: eo.timestamp,
  };
}

function isPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function capList(list, max) {
  if (list.length > max) list.length = max;
}

/** Resolve a finite reference price for a mirror order. MARKET orders adapted to LIMIT
 *  use the live price as a marketable limit so reserveMirror accepts them. */
function resolveRefPrice(masterOrder, liveIndex) {
  if (masterOrder.orderType === 'LIMIT' && masterOrder.price != null) {
    return Number(masterOrder.price);
  }
  if (liveIndex) {
    const coin = liveIndex.get(masterOrder.symbol);
    if (coin && Number.isFinite(coin.price)) return coin.price;
  }
  return undefined;
}

/** Build a mirror order object for a replica, without filling it. */
function buildMirrorOrder(replicaAcc, masterOrder, multiplier, refPrice) {
  const replicaSize = Number((Number(masterOrder.size) * multiplier).toFixed(8));
  let repOrderType = masterOrder.orderType;
  let adaptationNote = '';
  if (replicaAcc.broker === 'coinswitch' && replicaAcc.segment === 'SPOT' && masterOrder.orderType === 'MARKET') {
    repOrderType = 'LIMIT';
    adaptationNote = 'Adapted MARKET order to LIMIT for CoinSwitch Spot compliance.';
  }
  const masterOrderId = masterOrder.exchangeOrderId || masterOrder.orderId || masterOrder.id;
  return {
    id: uid('ord-rep'),
    accountId: replicaAcc.id,
    broker: replicaAcc.broker,
    symbol: masterOrder.symbol,
    side: masterOrder.side,
    orderType: repOrderType,
    price: refPrice,
    size: replicaSize,
    filledSize: 0,
    status: 'OPEN',
    timeInForce: 'GTC',
    leverage: 1,
    timestamp: new Date().toISOString(),
    fee: 0,
    mode: 'REAL',
    notes: `Mirror of ${masterOrderId}${adaptationNote ? ' | ' + adaptationNote : ''}`.trim(),
    mirrorsMasterOrderId: masterOrderId,
  };
}

/** Reserve funds for a resting mirror order. Returns {ok, reason?}. */
function reserveMirror(replicaAcc, repOrder) {
  const refPrice = repOrder.price;
  if (!refPrice || !Number.isFinite(refPrice)) return { ok: false, reason: 'No reference price for mirror order' };
  const feePct = Number((executionCost({ broker: replicaAcc.broker, side: repOrder.side, refPrice, size: repOrder.size, quoteVolume: 0 }).feePct || 0.1));
  const check = checkMargin(replicaAcc, repOrder, refPrice, feePct);
  if (!check.ok) return { ok: false, reason: check.reason };
  reserveOrder(replicaAcc, repOrder, refPrice, feePct);
  return { ok: true };
}

function releaseMirror(replicaAcc, repOrder) {
  releaseOrder(replicaAcc, repOrder);
}

/** Push a mirror log entry, keeping the log capped. */
function pushMirrorLog(entry) {
  mirrorConfig.logs.unshift(entry);
  capList(mirrorConfig.logs, 500);
}

/** Mirror one create/modify/cancel action onto all replicas of a master, concurrently. */
async function mirrorAction(master, eo, action, prevSnap, liveIndex) {
  const masterOrderId = eo.exchangeOrderId || eo.orderId || eo.id;
  const replicas = getReplicaAccounts(master.id);
  const refPrice = resolveRefPrice(eo, liveIndex);

  await Promise.allSettled(replicas.map(async (replicaAcc) => {
    const replica = replicaFor(mirrorConfig.replicas, replicaAcc.id);
    if (!replica) return;
    const multiplier = Number(replica.multiplier || 1);

    if (action === 'new') {
      // Dedupe: skip if a mirror already exists for this master order on this replica.
      const existing = orders.find((o) => o.accountId === replicaAcc.id && o.mirrorsMasterOrderId === masterOrderId);
      if (existing) return;
      const repOrder = buildMirrorOrder(replicaAcc, eo, multiplier, refPrice);
      const reserved = reserveMirror(replicaAcc, repOrder);
      if (!reserved.ok) {
        pushMirrorLog({
          id: uid('mlog'), timestamp: new Date().toISOString(),
          masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side} ${eo.size})`,
          targetAccount: replicaAcc.accountName,
          status: 'REJECTED', details: reserved.reason,
        });
        return;
      }
      orders.unshift(repOrder);
      capList(orders, 10000);
      pushMirrorLog({
        id: uid('mlog'), timestamp: new Date().toISOString(),
        masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side} ${eo.size})`,
        targetAccount: replicaAcc.accountName,
        status: 'EXECUTED',
        details: `Mirrored new ${eo.orderType} ${eo.side} ${eo.size} ${eo.symbol} @ ${eo.price ?? 'market'} (${multiplier}x).`,
      });
    } else if (action === 'modify') {
      const repOrder = orders.find((o) => o.accountId === replicaAcc.id && o.mirrorsMasterOrderId === masterOrderId);
      if (!repOrder) return;
      const masterStatus = normalizeStatus(eo.status);

      // Propagate fill / partial-fill status from master to replica.
      if (masterStatus === 'FILLED' || masterStatus === 'PARTIALLY_FILLED') {
        releaseMirror(replicaAcc, repOrder);
        repOrder.status = masterStatus;
        repOrder.filledSize = Number(eo.filledSize || 0);
        repOrder.fillPrice = eo.price != null ? Number(eo.price) : repOrder.price;
        repOrder.timestamp = new Date().toISOString();
        pushMirrorLog({
          id: uid('mlog'), timestamp: new Date().toISOString(),
          masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side} ${eo.size})`,
          targetAccount: replicaAcc.accountName,
          status: 'EXECUTED',
          details: `Mirrored ${masterStatus} of ${masterOrderId} (filled ${repOrder.filledSize}) on ${replicaAcc.accountName}.`,
        });
        return;
      }

      // Resting order price/size change: release old reservation, re-check margin, re-reserve.
      releaseMirror(replicaAcc, repOrder);
      const newPrice = repOrder.orderType === 'LIMIT' && refPrice != null ? refPrice : repOrder.price;
      const newSize = Number((Number(eo.size) * multiplier).toFixed(8));
      if (!isPositiveNumber(newSize)) {
        pushMirrorLog({
          id: uid('mlog'), timestamp: new Date().toISOString(),
          masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side})`,
          targetAccount: replicaAcc.accountName,
          status: 'SKIPPED', details: 'Replica size rounded to zero.',
        });
        return;
      }
      repOrder.price = newPrice;
      repOrder.size = newSize;
      repOrder.timestamp = new Date().toISOString();
      const reserved = reserveMirror(replicaAcc, repOrder);
      if (!reserved.ok) {
        repOrder.status = 'CANCELLED';
        pushMirrorLog({
          id: uid('mlog'), timestamp: new Date().toISOString(),
          masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side})`,
          targetAccount: replicaAcc.accountName,
          status: 'REJECTED', details: reserved.reason,
        });
        return;
      }
      pushMirrorLog({
        id: uid('mlog'), timestamp: new Date().toISOString(),
        masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side} ${eo.size})`,
        targetAccount: replicaAcc.accountName,
        status: 'EXECUTED',
        details: `Mirrored modify ${eo.orderType} ${eo.side} ${eo.size} ${eo.symbol} @ ${eo.price ?? 'market'} (${multiplier}x).`,
      });
    } else if (action === 'cancel') {
      const repOrder = orders.find((o) => o.accountId === replicaAcc.id && o.mirrorsMasterOrderId === masterOrderId);
      if (!repOrder) return;
      releaseMirror(replicaAcc, repOrder);
      repOrder.status = 'CANCELLED';
      repOrder.notes = (repOrder.notes || '') + ' | Mirrored cancel from master';
      pushMirrorLog({
        id: uid('mlog'), timestamp: new Date().toISOString(),
        masterOrder: `${masterOrderId} (${prevSnap.symbol ?? ''} ${prevSnap.side ?? ''})`,
        targetAccount: replicaAcc.accountName,
        status: 'EXECUTED',
        details: `Mirrored cancel of ${masterOrderId}.`,
      });
    }
  }));
}

/** Build O(1) indexes: orders by exchange id per account, and mirrors by master order id. */
function buildIndexes() {
  const ordersByExchangeId = new Map(); // accountId -> Map<exchangeOrderId, order>
  for (const o of orders) {
    if (o.exchangeOrderId) {
      let m = ordersByExchangeId.get(o.accountId);
      if (!m) { m = new Map(); ordersByExchangeId.set(o.accountId, m); }
      m.set(o.exchangeOrderId, o);
    }
  }
  return ordersByExchangeId;
}

/** Poll once: detect new/modified/cancelled orders on master CoinSwitch accounts and mirror. */
export async function pollOnce() {
  const ordersByExchangeId = buildIndexes();

  let liveIndex;
  try { liveIndex = await getLivePriceIndex(); } catch { liveIndex = null; }

  const masters = getMasterAccounts();
  await Promise.all(masters.map(async (master) => {
    const adapter = getAdapter(master);
    let exchangeOrders;
    try {
      exchangeOrders = await adapter.getOpenOrders(master.id);
    } catch (err) {
      console.warn(`[poller] failed to fetch open orders for ${master.accountName}:`, err.message);
      return;
    }

    const prev = lastPolled.get(master.id) || new Map();
    const curr = new Map();
    for (const eo of exchangeOrders) curr.set(eo.orderId, snap(eo));

    // New or modified orders (each order handled independently; one failure does not block others or the snapshot).
    for (const eo of exchangeOrders) {
      try {
        const p = prev.get(eo.orderId);
        const local = ordersByExchangeId.get(master.id)?.get(eo.orderId);
        if (!p && !local) {
          await mirrorAction(master, eo, 'new', null, liveIndex);
        } else if (p && (p.status !== eo.status || p.price !== eo.price || p.size !== eo.size)) {
          await mirrorAction(master, eo, 'modify', p, liveIndex);
        }
      } catch (err) {
        console.warn(`[poller] order mirror failed for ${eo.orderId} on ${master.accountName}:`, err.message);
      }
    }

    // Cancelled / deleted orders (was tracked on exchange, now gone).
    for (const [orderId, p] of prev) {
      try {
        if (!curr.has(orderId)) {
          await mirrorAction(master, { orderId, ...p }, 'cancel', p, liveIndex);
        }
      } catch (err) {
        console.warn(`[poller] cancel mirror failed for ${orderId} on ${master.accountName}:`, err.message);
      }
    }

    // Always save the snapshot for this master, even if some orders failed to mirror.
    lastPolled.set(master.id, curr);
  }));
}

/** Start the poller loop. Safe to call multiple times. */
export function startPoller(intervalMs = POLL_INTERVAL_MS) {
  if (timer) return timer;
  timer = setInterval(() => {
    if (cycleRunning) return; // skip tick if a cycle is still running (no overlapping cycles)
    cycleRunning = true;
    pollOnce().finally(() => { cycleRunning = false; });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/** Stop the poller loop. */
export function stopPoller() {
  if (timer) { clearInterval(timer); timer = null; }
  cycleRunning = false;
}

export { pollOnce as pollOrders };
