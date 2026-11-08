import { COINSWITCH_META, signCoinSwitchRequest, validateCoinSwitchOrder } from './coinswitch.js';
import { DELTA_META, signDeltaRequest, validateDeltaOrder } from './delta.js';
import { COINDCX_META, signCoinDCXRequest, validateCoinDCXOrder } from './coindcx.js';

export const BROKERS = {
  coinswitch: COINSWITCH_META,
  delta: DELTA_META,
  coindcx: COINDCX_META,
};

export const BROKER_NAMES = Object.keys(BROKERS);
export const DEFAULT_BROKER = 'coinswitch';

export const MARKET_DATA_BROKERS = ['coinswitch', 'delta', 'coindcx'];

export function getBrokerMeta(brokerId) {
  return BROKERS[brokerId] || BROKERS[DEFAULT_BROKER];
}

export function validateBrokerOrder(brokerId, orderParams, account) {
  if (brokerId === 'coinswitch') {
    return validateCoinSwitchOrder(orderParams, account?.segment || 'SPOT');
  }
  if (brokerId === 'delta') {
    return validateDeltaOrder(orderParams);
  }
  if (brokerId === 'coindcx') {
    return validateCoinDCXOrder(orderParams);
  }
  return true;
}

export {
  COINSWITCH_META,
  DELTA_META,
  COINDCX_META,
  signCoinSwitchRequest,
  signDeltaRequest,
  signCoinDCXRequest,
};
