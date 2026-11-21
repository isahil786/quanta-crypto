// Order poller: polls CoinSwitch for order changes on master accounts
// and replicates create / modify / cancel operations to all mirror accounts
// by placing real orders on replica accounts via the CoinSwitch adapter.
import { accounts, orders, mirrorConfig } from './state.js';
import { checkMargin, releaseOrder, reserveOrder } from './positions.js';
import { executionCost } from './costs.js';
import { uid } from './util.js';
import { CoinSwitchAdapter } from './execution/coinswitch.js';
import { getLivePriceIndex } from './binance.js';
import { isEmergencyStopActive } from './safety.js';

const POLL_INTERVAL_MS = 8000;
let timer = null;
let cycleRunning = false;
const adapters = new Map();      // accountId -> CoinSwitchAdapter
const lastPolled = new Map();    // accountId -> Map<exchangeOrderId, snapshot>
const lastPriceBySymbol = new Map(); // symbol -> last known price (fallback for MARKET->LIMIT)
const inflightMirror = new Set();  // `${replicaId}:${masterOrderId}` currently being placed

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
    case 'PARTIALLY_FILLED': return 'PARTIALLY_FILLED';
    case 'FILLED': return 'FILLED';
    case 'REJECTED': return 'REJECTED';
    case 'EXPIRED': return 'EXPIRED';
    default: return s;
  }
}

function snap(eo) {
  return {
    status: normalizeStatus(eo.status),
    price: eo.price,
    size: eo.size,
    side: eo.side,
    symbol: eo.symbol,
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

/** Strip control characters/newlines from an exchange-controlled order id so it
 *  cannot inject line breaks into persisted notes/log strings. */
function sanitizeOrderId(id) {
  return String(id ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Reduce an adapter error to a safe generic reason (no raw response bodies/headers)
 *  suitable for persisting in mirror logs. */
function sanitizeAdapterError(err) {
  const msg = String(err && err.message ? err.message : err);
  // Strip anything after a colon that typically carries the raw HTTP response body.
  return msg.split(':')[0].trim() || 'Adapter error';
}

/** Resolve a finite reference price for a mirror order. MARKET orders adapted to LIMIT
 *  use the live price as a marketable limit, falling back to the last known price. */
function resolveRefPrice(masterOrder, liveIndex) {
  const orderType = masterOrder.type || masterOrder.orderType;
  if (orderType === 'LIMIT' && masterOrder.price != null) {
    return Number(masterOrder.price);
  }
  if (liveIndex) {
    const coin = liveIndex.get(masterOrder.symbol);
    if (coin && Number.isFinite(coin.price)) {
      lastPriceBySymbol.set(masterOrder.symbol, coin.price);
      return coin.price;
    }
  }
  const fallback = lastPriceBySymbol.get(masterOrder.symbol);
  if (Number.isFinite(fallback)) return fallback;
  return undefined;
}

/** Build a mirror order object for a replica, without filling it. */
function buildMirrorOrder(replicaAcc, masterOrder, multiplier, refPrice) {
  const replicaSize = Number((Number(masterOrder.size) * multiplier).toFixed(8));
  let repOrderType = masterOrder.type || masterOrder.orderType;
  let adaptationNote = '';
  // REAL replicas get the master's exact order type (a MARKET stays a MARKET). Only a PAPER replica,
  // which has no exchange to execute a market order, simulates it as a marketable LIMIT at the live price.
  if (replicaAcc.mode !== 'REAL' && repOrderType === 'MARKET') {
    repOrderType = 'LIMIT';
    adaptationNote = 'Adapted MARKET order to LIMIT (paper simulation at the live price).';
  }
  const masterOrderId = sanitizeOrderId(masterOrder.exchangeOrderId || masterOrder.orderId || masterOrder.id);
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
    mode: replicaAcc.mode || 'PAPER',
    notes: `Mirror of ${masterOrderId}${adaptationNote ? ' | ' + adaptationNote : ''}`.trim(),
    mirrorsMasterOrderId: masterOrderId,
  };
}

/** Reserve funds for a resting mirror order (local PAPER-mode simulation only). */
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

/** Place a real order on a replica account via the adapter, or simulate for PAPER mode. */
async function placeReplicaOrder(replicaAcc, repOrder) {
  if (replicaAcc.mode !== 'REAL') {
    // PAPER mode: simulate locally without touching the exchange.
    const reserved = reserveMirror(replicaAcc, repOrder);
    if (!reserved.ok) return { ok: false, reason: reserved.reason, result: null };
    orders.unshift(repOrder);
    capList(orders, 10000);
    return { ok: true, reason: null, result: { orderId: repOrder.id, status: 'OPEN', filledSize: 0, fillPrice: undefined, fee: undefined, raw: null } };
  }

  // Cross-broker guard: only place on CoinSwitch replicas; never send another
  // broker's credentials to the CoinSwitch adapter.
  if (replicaAcc.broker !== 'coinswitch' || replicaAcc.isMaster) {
    return { ok: false, reason: 'Replica is not a CoinSwitch non-master account', result: null };
  }

  const adapter = getAdapter(replicaAcc);
  let placed;
  try {
    placed = await adapter.placeOrder({
      accountId: replicaAcc.id,
      symbol: repOrder.symbol,
      side: repOrder.side,
      type: repOrder.orderType,
      size: repOrder.size,
      price: repOrder.price,
      timeInForce: repOrder.timeInForce,
    });
  } catch (err) {
    return { ok: false, reason: sanitizeAdapterError(err), result: null };
  }

  // Map adapter result to local mirror order state.
  repOrder.exchangeOrderId = placed.orderId;
  repOrder.status = normalizeStatus(placed.status);
  repOrder.filledSize = Number(placed.filledSize || 0);
  repOrder.fillPrice = placed.fillPrice ?? undefined;
  repOrder.fee = placed.fee ?? 0;
  repOrder.timestamp = placed.timestamp ?? new Date().toISOString();
  orders.unshift(repOrder);
  capList(orders, 10000);
  return { ok: true, reason: null, result: placed };
}

/** Cancel a real order on a replica account via the adapter, or simulate for PAPER mode. */
async function cancelReplicaOrder(replicaAcc, repOrder) {
  if (replicaAcc.mode !== 'REAL') {
    releaseMirror(replicaAcc, repOrder);
    repOrder.status = 'CANCELLED';
    repOrder.notes = (repOrder.notes || '') + ' | Mirrored cancel from master (paper)';
    return { ok: true, reason: null };
  }

  // Cross-broker guard: only cancel on CoinSwitch replicas.
  if (replicaAcc.broker !== 'coinswitch' || replicaAcc.isMaster) {
    releaseMirror(replicaAcc, repOrder);
    repOrder.status = 'CANCELLED';
    repOrder.notes = (repOrder.notes || '') + ' | Mirrored cancel from master (skipped non-CoinSwitch replica)';
    return { ok: true, reason: null };
  }

  const adapter = getAdapter(replicaAcc);
  try {
    await adapter.cancelOrder(replicaAcc.id, repOrder.exchangeOrderId || repOrder.id, repOrder.symbol);
  } catch (err) {
    return { ok: false, reason: sanitizeAdapterError(err) };
  }

  releaseMirror(replicaAcc, repOrder);
  repOrder.status = 'CANCELLED';
  repOrder.notes = (repOrder.notes || '') + ' | Mirrored cancel from master';
  return { ok: true, reason: null };
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
      // Dedupe: skip if a mirror already exists for this master order on this replica, or one is being placed right now
      // (the poller, the order form and the fill stream can all report the same master order).
      const lockKey = `${replicaAcc.id}:${masterOrderId}`;
      if (inflightMirror.has(lockKey)) return;
      const existing = orders.find((o) => o.accountId === replicaAcc.id && o.mirrorsMasterOrderId === masterOrderId);
      if (existing) return;
      inflightMirror.add(lockKey);
      try {
        const repOrder = buildMirrorOrder(replicaAcc, eo, multiplier, refPrice);
        const placed = await placeReplicaOrder(replicaAcc, repOrder);
        if (!placed.ok) {
          pushMirrorLog({
            id: uid('mlog'), timestamp: new Date().toISOString(),
            masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side} ${eo.size})`,
            targetAccount: replicaAcc.accountName,
            status: 'REJECTED', details: placed.reason,
          });
          return;
        }
        pushMirrorLog({
          id: uid('mlog'), timestamp: new Date().toISOString(),
          masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side} ${eo.size})`,
          targetAccount: replicaAcc.accountName,
          status: 'EXECUTED',
          details: `Mirrored new ${repOrder.orderType} ${eo.side} ${repOrder.size} ${eo.symbol} @ ${repOrder.orderType === 'MARKET' ? 'market' : repOrder.price} (${multiplier}x) on ${replicaAcc.accountName}.`,
        });
      } finally {
        inflightMirror.delete(lockKey);
      }
    } else if (action === 'modify') {
      const repOrder = orders.find((o) => o.accountId === replicaAcc.id && o.mirrorsMasterOrderId === masterOrderId);
      if (!repOrder) return;
      const masterStatus = normalizeStatus(eo.status);

      // Propagate fill / partial-fill status from master to replica.
      // For REAL replicas cancel the order on the exchange so exchange and local state stay in sync.
      if (masterStatus === 'FILLED' || masterStatus === 'PARTIALLY_FILLED') {
        releaseMirror(replicaAcc, repOrder);
        repOrder.status = masterStatus;
        repOrder.filledSize = Number(eo.filledSize || 0);
        repOrder.fillPrice = eo.price != null ? Number(eo.price) : repOrder.price;
        repOrder.timestamp = new Date().toISOString();
        if (replicaAcc.mode === 'REAL' && repOrder.exchangeOrderId) {
          const cancelled = await cancelReplicaOrder(replicaAcc, repOrder);
          if (!cancelled.ok) {
            pushMirrorLog({
              id: uid('mlog'), timestamp: new Date().toISOString(),
              masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side} ${eo.size})`,
              targetAccount: replicaAcc.accountName,
              status: 'REJECTED', details: `fill cancel failed: ${cancelled.reason}`,
            });
          }
        }
        pushMirrorLog({
          id: uid('mlog'), timestamp: new Date().toISOString(),
          masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side} ${eo.size})`,
          targetAccount: replicaAcc.accountName,
          status: 'EXECUTED',
          details: `Mirrored ${masterStatus} of ${masterOrderId} (filled ${repOrder.filledSize}) on ${replicaAcc.accountName}.`,
        });
        return;
      }

      // Resting order price/size change: CoinSwitch does not support in-place modify,
      // so cancel the existing replica order and place a replacement.
      const cancelled = await cancelReplicaOrder(replicaAcc, repOrder);
      if (!cancelled.ok) {
        pushMirrorLog({
          id: uid('mlog'), timestamp: new Date().toISOString(),
          masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side})`,
          targetAccount: replicaAcc.accountName,
          status: 'REJECTED', details: `cancel failed: ${cancelled.reason}`,
        });
        return;
      }

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

      const replacement = buildMirrorOrder(replicaAcc, eo, multiplier, newPrice);
      replacement.id = uid('ord-replace');
      replacement.timestamp = new Date().toISOString();
      replacement.notes = `Replaced from ${repOrder.id} via cancel-and-replace on ${replicaAcc.accountName}`;
      const placed = await placeReplicaOrder(replicaAcc, replacement);
      if (!placed.ok) {
        // Rollback: re-place the original order so the replica is not left order-less.
        // repOrder is already tracked in `orders`, so do not unshift again.
        repOrder.status = 'OPEN';
        let rePlacedOk = false;
        let rePlacedReason = '';
        if (replicaAcc.mode !== 'REAL') {
          const reserved = reserveMirror(replicaAcc, repOrder);
          if (reserved.ok) rePlacedOk = true;
          else rePlacedReason = reserved.reason;
        } else {
          const adapter2 = getAdapter(replicaAcc);
          try {
            const r2 = await adapter2.placeOrder({
              accountId: replicaAcc.id,
              symbol: repOrder.symbol,
              side: repOrder.side,
              type: repOrder.orderType,
              size: repOrder.size,
              price: repOrder.price,
              timeInForce: repOrder.timeInForce,
            });
            repOrder.exchangeOrderId = r2.orderId;
            repOrder.status = normalizeStatus(r2.status);
            repOrder.filledSize = Number(r2.filledSize || 0);
            repOrder.fillPrice = r2.fillPrice ?? undefined;
            repOrder.fee = r2.fee ?? 0;
            repOrder.timestamp = r2.timestamp ?? new Date().toISOString();
            rePlacedOk = true;
          } catch (err) {
            rePlacedReason = sanitizeAdapterError(err);
          }
        }
        pushMirrorLog({
          id: uid('mlog'), timestamp: new Date().toISOString(),
          masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side})`,
          targetAccount: replicaAcc.accountName,
          status: rePlacedOk ? 'EXECUTED' : 'REJECTED',
          details: `replace failed: ${placed.reason}; ${rePlacedOk ? 'original re-placed' : 'original re-place failed: ' + rePlacedReason}`,
        });
        return;
      }
      pushMirrorLog({
        id: uid('mlog'), timestamp: new Date().toISOString(),
        masterOrder: `${masterOrderId} (${eo.symbol} ${eo.side} ${eo.size})`,
        targetAccount: replicaAcc.accountName,
        status: 'EXECUTED',
        details: `Mirrored modify ${eo.orderType} ${eo.side} ${eo.size} ${eo.symbol} @ ${eo.price ?? 'market'} (${multiplier}x) via cancel-and-replace on ${replicaAcc.accountName}.`,
      });
    } else if (action === 'cancel') {
      const repOrder = orders.find((o) => o.accountId === replicaAcc.id && o.mirrorsMasterOrderId === masterOrderId);
      if (!repOrder) return;
      const cancelled = await cancelReplicaOrder(replicaAcc, repOrder);
      if (!cancelled.ok) {
        pushMirrorLog({
          id: uid('mlog'), timestamp: new Date().toISOString(),
          masterOrder: `${masterOrderId} (${prevSnap.symbol ?? ''} ${prevSnap.side ?? ''})`,
          targetAccount: replicaAcc.accountName,
          status: 'REJECTED', details: `cancel failed: ${cancelled.reason}`,
        });
        return;
      }
      pushMirrorLog({
        id: uid('mlog'), timestamp: new Date().toISOString(),
        masterOrder: `${masterOrderId} (${prevSnap.symbol ?? ''} ${prevSnap.side ?? ''})`,
        targetAccount: replicaAcc.accountName,
        status: 'EXECUTED',
        details: `Mirrored cancel of ${masterOrderId} on ${replicaAcc.accountName}.`,
      });
    }
  }));
}

/** Build O(1) index: orders by exchange id per account. */
function buildOrdersByExchangeId() {
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

/** Mirror one master order onto all replicas right now, with the master's exact order type
 *  (MARKET -> MARKET, LIMIT -> LIMIT at the same price). Safe to call from several places for the same
 *  order: replicas that already have a copy (or are being placed) are skipped.
 *  `eo` = { orderId, symbol, side, type, size, price?, status }. */
export async function mirrorMasterOrder(master, eo) {
  if (isEmergencyStopActive()) return { skipped: true, reason: 'Emergency stop is active' };
  if (!mirrorConfig.enabled) return { skipped: true, reason: 'Mirroring is disabled' };
  if (!isMasterAccount(master)) return { skipped: true, reason: 'Not an active REAL CoinSwitch master account' };
  const status = normalizeStatus(eo.status || 'NEW');
  if (status === 'CANCELLED' || status === 'REJECTED' || status === 'EXPIRED') return { skipped: true, reason: `Master order is ${status}` };
  let liveIndex; try { liveIndex = await getLivePriceIndex(); } catch { liveIndex = null; }
  const order = { ...eo, type: eo.type || eo.orderType, orderType: eo.type || eo.orderType };
  await mirrorAction(master, order, 'new', null, liveIndex);
  return { skipped: false };
}

/** Poll once: detect new/modified/cancelled orders on master CoinSwitch accounts and mirror. */
export async function pollOnce() {
  // Emergency stop: skip all mirroring while active
  if (isEmergencyStopActive()) return { skipped: true, reason: 'Emergency stop is active' };

  const ordersByExchangeId = buildOrdersByExchangeId();

  let liveIndex;
  try { liveIndex = await getLivePriceIndex(); } catch { liveIndex = null; }

  // While mirroring is switched off we still refresh the snapshots (so turning it back on doesn't copy
  // stale orders) but never place or cancel anything on replicas.
  const act = mirrorConfig.enabled;
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
        if (!act) continue;
        const p = prev.get(eo.orderId);
        const local = ordersByExchangeId.get(master.id)?.get(eo.orderId);
        if (!p && !local) {
          await mirrorAction(master, eo, 'new', null, liveIndex);
        } else if (p && (p.status !== normalizeStatus(eo.status) || p.price !== eo.price || p.size !== eo.size)) {
          await mirrorAction(master, eo, 'modify', p, liveIndex);
        }
      } catch (err) {
        console.warn(`[poller] order mirror failed for ${eo.orderId} on ${master.accountName}:`, err.message);
      }
    }

    // Cancelled / deleted orders (was tracked on exchange, now gone).
    for (const [orderId, p] of prev) {
      try {
        if (curr.has(orderId) || !act) continue;
        // An order leaving the open list was either cancelled/expired OR filled. A fill must not cancel the
        // replicas' copies (they are meant to fill too), so look up how it ended; if that fails, assume cancelled.
        let finalStatus;
        try { finalStatus = normalizeStatus((await adapter.getOrder(master.id, orderId, p.symbol)).status); } catch { /* unknown */ }
        if (finalStatus === 'FILLED') {
          pushMirrorLog({
            id: uid('mlog'), timestamp: new Date().toISOString(),
            masterOrder: `${orderId} (${p.symbol ?? ''} ${p.side ?? ''})`,
            targetAccount: 'all replicas',
            status: 'EXECUTED', details: `Master order ${orderId} filled; replica copies were left in place to fill on their own.`,
          });
          continue;
        }
        await mirrorAction(master, { orderId, ...p }, 'cancel', p, liveIndex);
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

// Exported for testing: inject mock adapters and reset poll state between tests.
export { getAdapter, lastPolled, adapters };
