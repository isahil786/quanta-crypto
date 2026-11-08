import crypto from 'node:crypto';

export const DELTA_META = {
  id: 'delta',
  displayName: 'Delta Exchange India',
  category: 'crypto',
  baseUrl: 'https://api.india.delta.exchange/v2',
  wsUrl: 'wss://socket.india.delta.exchange',
  formFields: [
    { name: 'accountName', label: 'Account Nickname', type: 'text', placeholder: 'e.g. Delta India Primary', required: true },
    { name: 'apiKey', label: 'API Key', type: 'text', placeholder: 'Enter your Delta Exchange API Key', required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', placeholder: 'Enter your Delta Exchange API Secret', required: true },
  ],
  capabilities: {
    supportsMarketOrder: true,
    supportsLimitOrder: true,
    supportsStopOrder: true,
    supportsBracketOrders: true, // Native TP/SL bracket
    supportsModifyOrder: true, // Native edit order
    supportsCancelOrder: true,
    supportsPositions: true, // Futures contracts & margin
    supportsHoldings: true, // Wallet balances
    supportsGTT: true, // Mapped via bracket orders / conditional stops
    supportsLeverage: true, // Up to 100x
    supportsWebSocket: true,
    supportsOrderBook: true,
    supportsDepth: true,
    feeEstimatePercent: 0.05,
  },
};

/**
 * Sign Delta Exchange requests with HMAC-SHA256
 * Signature: HMAC_SHA256(method + timestamp + path + query_string + body, secret)
 */
export function signDeltaRequest(method, path, query = '', body = '', apiSecret = '', apiKey = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = `${method.toUpperCase()}${timestamp}${path}${query ? '?' + query : ''}${body ? (typeof body === 'string' ? body : JSON.stringify(body)) : ''}`;
  const signature = crypto
    .createHmac('sha256', apiSecret || 'demo-delta-secret')
    .update(payload)
    .digest('hex');

  return {
    'api-key': apiKey || 'demo-delta-key',
    'signature': signature,
    'timestamp': timestamp,
    'Content-Type': 'application/json',
  };
}

export function validateDeltaOrder(orderParams) {
  if (!orderParams.size || Number(orderParams.size) <= 0) {
    throw new Error('Valid order size/quantity is required for Delta Exchange.');
  }
  return true;
}
