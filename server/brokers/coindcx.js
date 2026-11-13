import crypto from 'node:crypto';

export const COINDCX_META = {
  id: 'coindcx',
  displayName: 'CoinDCX Trading API',
  category: 'crypto',
  baseUrl: 'https://api.coindcx.com',
  publicBaseUrl: 'https://public.coindcx.com',
  wsUrl: 'wss://stream.coindcx.com',
  formFields: [
    { name: 'accountName', label: 'Account Nickname', type: 'text', placeholder: 'e.g. CoinDCX Pro', required: true },
    { name: 'apiKey', label: 'API Key', type: 'text', placeholder: 'Enter your CoinDCX API Key', required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', placeholder: 'Enter your CoinDCX API Secret', required: true },
  ],
  capabilities: {
    supportsMarketOrder: true,
    supportsLimitOrder: true,
    supportsStopOrder: true,
    supportsBracketOrders: true, // Target & SL edit
    supportsModifyOrder: true, // Edit price supported
    supportsCancelOrder: true,
    supportsPositions: true, // Margin / Futures positions
    supportsHoldings: true, // Balances
    supportsGTT: true, // Bracket TP/SL mapping
    supportsLeverage: true, // Margin leverage up to 20x
    supportsWebSocket: true,
    supportsOrderBook: true,
    supportsDepth: true,
    feeEstimatePercent: 0.1,
    makerFeePercent: 0.08, // estimate; adjust to your fee tier
    takerFeePercent: 0.1,
  },
};

/**
 * Sign CoinDCX requests with HMAC-SHA256
 * Signature: HMAC_SHA256(JSON.stringify(body), secret)
 */
export function signCoinDCXRequest(body = {}, apiSecret = '', apiKey = '') {
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = crypto
    .createHmac('sha256', apiSecret || 'demo-coindcx-secret')
    .update(bodyString)
    .digest('hex');

  return {
    'X-AUTH-APIKEY': apiKey || 'demo-coindcx-key',
    'X-AUTH-SIGNATURE': signature,
    'Content-Type': 'application/json',
  };
}

export function validateCoinDCXOrder(orderParams) {
  if (orderParams.orderType === 'LIMIT' && !orderParams.price) {
    throw new Error('Price is required for CoinDCX limit orders.');
  }
  return true;
}
