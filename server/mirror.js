// Mirror trading: replicate a filled master order onto the configured replica accounts.
import { accounts, orders, mirrorConfig } from './state.js';
import { BROKERS } from './brokers/index.js';
import { checkMargin, settleOrderFill } from './positions.js';
import { uid, isPositiveNumber, capList } from './util.js';

const feePctFor = (broker) => BROKERS[broker]?.capabilities?.feeEstimatePercent ?? 0.1;

/** Only manual orders mirror: not bot/rule fills and not mirror orders themselves. */
export function shouldMirror(account, order) {
  return Boolean(account?.isMaster && mirrorConfig.enabled && order.status === 'FILLED' && !order.source && !String(order.notes || '').startsWith('Mirror of'));
}

/** Replicate `order` (already FILLED on the master) at `refPrice`. */
export function mirrorFilledOrder(masterAccount, order, refPrice) {
  const { symbol, side, orderType, size } = order;
  const leverage = order.leverage || 1;
  for (const replica of mirrorConfig.replicas) {
    if (!replica.active || replica.accountId === masterAccount.id) continue;
    const replicaAcc = accounts.find((a) => a.id === replica.accountId);
    if (!replicaAcc) continue;

    const replicaSize = Number((size * replica.multiplier).toFixed(8));
    const logBase = { id: uid('mlog'), timestamp: new Date().toISOString(), masterOrder: `${order.id} (${symbol} ${side} ${size})`, targetAccount: replicaAcc.accountName };
    if (!isPositiveNumber(replicaSize)) {
      mirrorConfig.logs.unshift({ ...logBase, status: 'SKIPPED', details: 'Replica size rounded to zero.' });
      continue;
    }

    let replicaOrderType = orderType;
    let adaptationNote = '';
    if (replicaAcc.broker === 'coinswitch' && replicaAcc.segment === 'SPOT' && orderType === 'MARKET') {
      replicaOrderType = 'LIMIT';
      adaptationNote = 'Adapted MARKET order to LIMIT for CoinSwitch Spot compliance.';
    }
    const repOrder = {
      id: uid('ord-rep'), accountId: replicaAcc.id, broker: replicaAcc.broker, symbol, side,
      orderType: replicaOrderType, price: refPrice, size: replicaSize, filledSize: 0, status: 'OPEN',
      timeInForce: 'GTC', leverage: Math.min(leverage, replicaAcc.broker === 'delta' ? 100 : 20),
      timestamp: new Date().toISOString(), fee: 0, notes: `Mirror of ${order.id}`,
    };
    // Replicas fill at the same reference price as the master, so there is no slippage to enforce.
    const feePct = feePctFor(replicaAcc.broker);
    const check = checkMargin(replicaAcc, repOrder, refPrice, feePct);
    if (!check.ok) {
      mirrorConfig.logs.unshift({ ...logBase, status: 'REJECTED', details: check.reason });
      continue;
    }
    settleOrderFill(replicaAcc, repOrder, refPrice, feePct);
    orders.unshift(repOrder);
    mirrorConfig.logs.unshift({
      ...logBase,
      status: adaptationNote ? 'ADAPTED' : 'EXECUTED',
      details: `${adaptationNote} Mirrored ${replicaSize} ${symbol} @ ${refPrice} (${replica.multiplier}x).`.trim(),
    });
  }
  capList(mirrorConfig.logs, 500);
}
