// Mirror trading: replicate a filled master order onto the configured replica accounts.
import { accounts, orders, mirrorConfig } from './state.js';
import { checkMargin, settleOrderFill } from './positions.js';
import { executionCost } from './costs.js';
import { uid, isPositiveNumber, capList } from './util.js';


/** Only manual orders mirror: not bot/rule fills and not mirror orders themselves. */
export function shouldMirror(account, order) {
  return Boolean(account?.isMaster && mirrorConfig.enabled && order.status === 'FILLED' && !order.source && !String(order.notes || '').startsWith('Mirror of'));
}

/** Replicate `order` (already FILLED on the master) at `refPrice`. */
export function mirrorFilledOrder(masterAccount, order, refPrice, ctx = {}) {
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
    // Replicas are taker orders: they slip with their own size, and are refused if that exceeds maxSlippagePercent
    const ex = executionCost({ broker: replicaAcc.broker, side, refPrice, size: replicaSize, quoteVolume: ctx.quoteVolume });
    if (Number.isFinite(replica.maxSlippagePercent) && ex.slippagePct > replica.maxSlippagePercent) {
      mirrorConfig.logs.unshift({ ...logBase, status: 'REJECTED', details: `Expected slippage ${ex.slippagePct}% exceeds the replica limit of ${replica.maxSlippagePercent}%.` });
      continue;
    }
    const check = checkMargin(replicaAcc, repOrder, ex.price, ex.feePct);
    if (!check.ok) {
      mirrorConfig.logs.unshift({ ...logBase, status: 'REJECTED', details: check.reason });
      continue;
    }
    settleOrderFill(replicaAcc, repOrder, ex.price, ex.feePct, { liquidity: 'TAKER', slippagePct: ex.slippagePct, refPrice });
    orders.unshift(repOrder);
    mirrorConfig.logs.unshift({
      ...logBase,
      status: adaptationNote ? 'ADAPTED' : 'EXECUTED',
      details: `${adaptationNote} Mirrored ${replicaSize} ${symbol} @ ${refPrice} (${replica.multiplier}x).`.trim(),
    });
  }
  capList(mirrorConfig.logs, 500);
}
