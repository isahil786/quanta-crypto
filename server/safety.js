// Safety module: emergency stop, order reconciliation, exposure limits.
import { accounts, orders, emergencyStop, exposureLimits } from './state.js';
import { getAdapter, getMasterAccounts } from './poller.js';
import { releaseOrder } from './positions.js';
import { uid } from './util.js';

/** Reduce an adapter error to a safe generic reason (no raw response bodies/headers)
 *  suitable for persisting in mirror logs. */
function sanitizeAdapterError(err) {
  const msg = String(err && err.message ? err.message : err);
  return msg.split(':')[0].trim() || 'Adapter error';
}

/** Normalize exchange order status strings to internal values. */
export function normalizeStatus(s) {
  switch (String(s).toUpperCase()) {
    case 'NEW': return 'OPEN';
    case 'CANCELED': case 'CANCELLED': case 'CANCELLATION_RAISED': return 'CANCELLED';
    case 'PARTIALLY_FILLED': case 'PARTIALLY_EXECUTED': return 'PARTIALLY_FILLED';
    case 'FILLED': case 'EXECUTED': return 'FILLED';
    case 'REJECTED': return 'REJECTED';
    case 'EXPIRED': case 'EXPIRATION_RAISED': return 'EXPIRED';
    default: return s;
  }
}

/* ================================================================
   EMERGENCY STOP / KILL-SWITCH
   ================================================================ */

export function isEmergencyStopActive() {
  return emergencyStop.active;
}

export function getEmergencyStopStatus() {
  return { ...emergencyStop };
}

export function activateEmergencyStop(reason, activatedBy = 'operator') {
  emergencyStop.active = true;
  emergencyStop.reason = reason;
  emergencyStop.activatedAt = new Date().toISOString();
  emergencyStop.activatedBy = activatedBy;
  emergencyStop.confirmNonce = uid('es');
  return { ...emergencyStop };
}

export function deactivateEmergencyStop() {
  emergencyStop.active = false;
  emergencyStop.reason = null;
  emergencyStop.activatedAt = null;
  emergencyStop.activatedBy = null;
  emergencyStop.confirmNonce = null;
  return { ...emergencyStop };
}

/** Cancel all OPEN orders across all accounts via their adapters.
 *  Requires a valid confirmation nonce returned by activateEmergencyStop().
 *  Returns { cancelled, failed }. */
/** `resolveAdapter(account)` returns the live exchange adapter for a REAL account (defaults to the poller's CoinSwitch adapter). */
export async function cancelAllOpenOrders(confirmNonce, resolveAdapter = getAdapter) {
  if (!emergencyStop.active) {
    return { cancelled: [], failed: [], error: 'Emergency stop is not active' };
  }
  if (!confirmNonce || confirmNonce !== emergencyStop.confirmNonce) {
    return { cancelled: [], failed: [], error: 'Confirmation nonce required. Call POST /api/safety/emergency-stop first and pass the returned nonce.' };
  }
  // Consume the nonce so cancel-all can only be executed once per activation.
  emergencyStop.confirmNonce = null;

  const cancelled = [];
  const failed = [];

  // Group open orders by account so we use one adapter per account.
  const byAccount = new Map();
  for (const o of orders) {
    if (o.status !== 'OPEN') continue;
    if (!byAccount.has(o.accountId)) byAccount.set(o.accountId, []);
    byAccount.get(o.accountId).push(o);
  }

  for (const [accountId, accountOrders] of byAccount) {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) {
      for (const o of accountOrders) failed.push({ orderId: o.id, reason: 'account not found' });
      continue;
    }

    // PAPER orders exist only locally, so cancel them locally. REAL orders must be cancelled on the exchange,
    // whatever the broker; marking them CANCELLED without telling the exchange would leave them live.
    if (acc.mode !== 'REAL') {
      for (const o of accountOrders) {
        releaseOrder(acc, o);
        o.status = 'CANCELLED';
        o.notes = (o.notes || '') + ' | Emergency stop cancelled';
        cancelled.push({ orderId: o.id, accountId: acc.id, broker: acc.broker });
      }
      continue;
    }

    const adapter = resolveAdapter(acc);
    if (!adapter) {
      for (const o of accountOrders) failed.push({ orderId: o.id, accountId: acc.id, reason: 'no exchange adapter / credentials for this account' });
      continue;
    }
    for (const o of accountOrders) {
      try {
        await adapter.cancelOrder(acc.id, o.exchangeOrderId || o.id, o.symbol);
        releaseOrder(acc, o);
        o.status = 'CANCELLED';
        o.notes = (o.notes || '') + ' | Emergency stop cancelled';
        cancelled.push({ orderId: o.id, accountId: acc.id, broker: acc.broker });
      } catch (err) {
        failed.push({ orderId: o.id, accountId: acc.id, reason: sanitizeAdapterError(err) });
      }
    }
  }

  return { cancelled, failed };
}

/* ================================================================
   ORDER RECONCILIATION
   ================================================================ */

/** Compare local order state vs exchange open orders for all master accounts.
 *  Auto-corrects drift:
 *   - Local OPEN but missing from exchange -> mark CANCELLED (assume filled/cancelled externally)
 *   - Exchange has order but local missing -> create local record (best effort)
 *  Returns a summary of actions taken.
 */
export async function reconcileOrders() {
  const actions = [];
  const errors = [];

  const masters = getMasterAccounts();
  for (const master of masters) {
    const adapter = getAdapter(master);
    let exchangeOrders;
    try {
      exchangeOrders = await adapter.getOpenOrders(master.id);
    } catch (err) {
      errors.push({ accountId: master.id, reason: sanitizeAdapterError(err) });
      continue;
    }

    const exchangeIds = new Set(exchangeOrders.map((o) => o.orderId));

    // Local OPEN orders for this master
    const localOpen = orders.filter((o) => o.accountId === master.id && o.status === 'OPEN');

    for (const local of localOpen) {
      const exId = local.exchangeOrderId || local.id;
      if (!exchangeIds.has(exId)) {
        // Local says OPEN but exchange doesn't have it in open orders.
        // It may have been filled externally (removed from open orders) or cancelled.
        // Query the exchange order directly to determine its true status before marking CANCELLED.
        let exOrderStatus;
        let exOrder = null;
        try {
          exOrder = await adapter.getOrder(master.id, exId);
          exOrderStatus = normalizeStatus(exOrder.status);
        } catch {
          // Order not found on exchange at all — treat as cancelled.
          exOrderStatus = 'CANCELLED';
        }

        if (exOrderStatus === 'PARTIALLY_FILLED') {
          // Partially filled but the exchange still reports it as live: keep the remainder
          // OPEN and only release the reservation for the part that has already filled.
          const prevFilled = Number(local.filledSize || 0);
          const filled = Math.min(Number(exOrder.filledSize || 0), Number(local.size));
          const prevRemaining = Number(local.size) - prevFilled;
          const remaining = Number(local.size) - filled;
          if (filled > prevFilled && prevRemaining > 0) {
            const keep = remaining / prevRemaining;
            local.reservedUSDT = Number(((local.reservedUSDT || 0) * keep).toFixed(6));
            local.reservedBase = Number(((local.reservedBase || 0) * keep).toFixed(10));
            local.filledSize = filled;
            local.fillPrice = exOrder.fillPrice ?? local.price;
            local.notes = (local.notes || '') + ' | Reconciled: partially filled on exchange';
            actions.push({
              type: 'PARTIALLY_FILLED_EXTERNALLY',
              orderId: local.id,
              accountId: master.id,
              details: `Order ${exId} partially filled (${filled}/${local.size}); remainder kept OPEN`,
            });
          }
        } else if (exOrderStatus === 'FILLED') {
          // Order filled externally — mark FILLED and emit a trade record.
          const fillPrice = exOrder.fillPrice ?? local.price;
          const fillSize = Number(exOrder.filledSize || local.size);
          releaseOrder(master, local);
          local.status = 'FILLED';
          local.filledSize = fillSize;
          local.fillPrice = fillPrice;
          local.notes = (local.notes || '') + ' | Reconciled: filled externally on exchange';
          actions.push({
            type: 'FILLED_EXTERNALLY',
            orderId: local.id,
            accountId: master.id,
            details: `Order ${exId} filled externally on exchange; marked FILLED`,
          });
        } else {
          // Cancelled or not found — mark CANCELLED.
          releaseOrder(master, local);
          local.status = 'CANCELLED';
          local.notes = (local.notes || '') + ' | Reconciled: absent from exchange open orders';
          actions.push({ type: 'CANCELLED_LOCALLY', orderId: local.id, accountId: master.id, details: 'Order absent from exchange; marked CANCELLED' });
        }
      }
    }

    // Exchange orders not tracked locally — create a local record (best effort).
    // Check ALL orders (any status) for a matching exchangeOrderId to avoid duplicates.
    const allLocalExchangeIds = new Set();
    for (const o of orders) {
      if (o.exchangeOrderId) allLocalExchangeIds.add(o.exchangeOrderId);
    }
    for (const eo of exchangeOrders) {
      if (!allLocalExchangeIds.has(eo.orderId)) {
        const repOrder = {
          id: uid('ord-rec'),
          accountId: master.id,
          broker: master.broker,
          symbol: eo.symbol,
          side: eo.side,
          orderType: eo.type,
          price: eo.price,
          size: eo.size,
          filledSize: Number(eo.filledSize || 0),
          status: 'OPEN',
          timeInForce: 'GTC',
          leverage: 1,
          timestamp: new Date().toISOString(),
          fee: 0,
          exchangeOrderId: eo.orderId,
          notes: 'Reconciled from exchange open orders',
        };
        orders.unshift(repOrder);
        actions.push({ type: 'CREATED_LOCALLY', orderId: repOrder.id, accountId: master.id, details: `Order ${eo.orderId} found on exchange, not tracked locally` });
      }
    }
  }

  return { actions, errors };
}

/* ================================================================
   EXPOSURE LIMITS
   ================================================================ */

/** Current USDT exposure for an account (sum of open order notionals). */
export function accountExposureUSDT(accountId) {
  let sum = 0;
  for (const o of orders) {
    if (o.accountId !== accountId || o.status !== 'OPEN') continue;
    sum += Number(o.price || 0) * Number(o.size || 0);
  }
  return sum;
}

/** Current USDT exposure for a symbol across all accounts. */
export function symbolExposureUSDT(symbol) {
  let sum = 0;
  for (const o of orders) {
    if (o.symbol !== symbol || o.status !== 'OPEN') continue;
    sum += Number(o.price || 0) * Number(o.size || 0);
  }
  return sum;
}

/** Open order count for an account. */
export function accountOpenOrderCount(accountId) {
  return orders.filter((o) => o.accountId === accountId && o.status === 'OPEN').length;
}

/** Check if placing an order would breach exposure limits.
 *  Returns { ok: true } or { ok: false, reason }. */
export function checkExposureLimits(accountId, symbol, price, size, orderValueOverride = null) {
  if (!exposureLimits.enabled) return { ok: true };

  const orderValue = orderValueOverride ?? Number(price || 0) * Number(size || 0);
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return { ok: false, reason: 'Account not found' };

  if (exposureLimits.perAccountMaxUSDT != null) {
    const current = accountExposureUSDT(accountId);
    if (current + orderValue > exposureLimits.perAccountMaxUSDT) {
      return {
        ok: false,
        reason: `Per-account exposure cap exceeded: current ${current.toFixed(2)} + new ${orderValue.toFixed(2)} > ${exposureLimits.perAccountMaxUSDT} USDT`,
      };
    }
  }

  if (exposureLimits.perSymbolMaxUSDT != null) {
    const current = symbolExposureUSDT(symbol);
    if (current + orderValue > exposureLimits.perSymbolMaxUSDT) {
      return {
        ok: false,
        reason: `Per-symbol exposure cap exceeded for ${symbol}: current ${current.toFixed(2)} + new ${orderValue.toFixed(2)} > ${exposureLimits.perSymbolMaxUSDT} USDT`,
      };
    }
  }

  if (exposureLimits.perAccountMaxOrders != null) {
    const count = accountOpenOrderCount(accountId);
    if (count + 1 > exposureLimits.perAccountMaxOrders) {
      return {
        ok: false,
        reason: `Per-account order cap exceeded: ${count} open + 1 new > ${exposureLimits.perAccountMaxOrders}`,
      };
    }
  }

  return { ok: true };
}

export function getExposureLimits() {
  return { ...exposureLimits };
}

export function setExposureLimits(updates) {
  if (updates.enabled !== undefined) exposureLimits.enabled = Boolean(updates.enabled);
  if (updates.perAccountMaxUSDT !== undefined) {
    const v = Number(updates.perAccountMaxUSDT);
    if (updates.perAccountMaxUSDT === null) exposureLimits.perAccountMaxUSDT = null;
    else if (!Number.isFinite(v) || v < 0) throw new Error('perAccountMaxUSDT must be a non-negative number or null');
    else exposureLimits.perAccountMaxUSDT = v;
  }
  if (updates.perSymbolMaxUSDT !== undefined) {
    const v = Number(updates.perSymbolMaxUSDT);
    if (updates.perSymbolMaxUSDT === null) exposureLimits.perSymbolMaxUSDT = null;
    else if (!Number.isFinite(v) || v < 0) throw new Error('perSymbolMaxUSDT must be a non-negative number or null');
    else exposureLimits.perSymbolMaxUSDT = v;
  }
  if (updates.perAccountMaxOrders !== undefined) {
    const v = Number(updates.perAccountMaxOrders);
    if (updates.perAccountMaxOrders === null) exposureLimits.perAccountMaxOrders = null;
    else if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) throw new Error('perAccountMaxOrders must be a non-negative integer or null');
    else exposureLimits.perAccountMaxOrders = v;
  }
  return { ...exposureLimits };
}
