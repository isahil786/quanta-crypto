import crypto from 'node:crypto';

export const COINSWITCH_META = {
  id: 'coinswitch',
  displayName: 'CoinSwitch PRO',
  category: 'crypto',
  spotBaseUrl: 'https://coinswitch.co/trade/api/v2',
  futuresBaseUrl: 'https://coinswitch.co/trade/api/v2/futures',
  hftBaseUrl: 'https://dma.coinswitch.co',
  wsUrl: 'wss://ws.coinswitch.co',
  formFields: [
    { name: 'accountName', label: 'Account Nickname', type: 'text', placeholder: 'e.g. CoinSwitch Main', required: true },
    { name: 'apiKey', label: 'API Key', type: 'text', placeholder: 'Enter your CoinSwitch API Key', required: true },
    { name: 'apiSecret', label: 'Ed25519 Secret Key', type: 'password', placeholder: '64-hex char seed or PEM private key', required: true },
    { name: 'accountType', label: 'Segment', type: 'select', options: ['SPOT', 'FUTURES'], defaultValue: 'SPOT', required: true },
  ],
  capabilities: {
    supportsMarketOrder: false, // Spot is LIMIT-only, Futures supports market
    supportsFuturesMarketOrder: true,
    supportsModifyOrder: false, // Cancel + replace
    supportsCancelOrder: true,
    supportsPositions: false, // Futures only
    supportsFuturesPositions: true,
    supportsHoldings: true,
    supportsGTT: false, // Native GTT not supported
    supportsBracketOrders: false,
    supportsLeverage: false, // Only on futures
    supportsFuturesLeverage: true,
    supportsWebSocket: true,
    supportsOrderBook: true,
    supportsDepth: true,
    feeEstimatePercent: 0.1,
    makerFeePercent: 0.1, // estimate: no maker discount on spot; adjust to your tier
    takerFeePercent: 0.1,
  },
};

/**
 * Sign CoinSwitch requests with Ed25519
 * Payload is typically: method + endpoint + (body or query) + epoch
 */
export function signCoinSwitchRequest(method, endpoint, payload, secretKeyHex) {
  const epoch = Date.now().toString();
  const message = `${method}${endpoint}${payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : ''}${epoch}`;
  
  try {
    // If the user provides a raw 32-byte or 64-byte hex seed, create an Ed25519 private key
    let signature = '';
    if (secretKeyHex && secretKeyHex.length >= 64) {
      try {
        const rawKey = Buffer.from(secretKeyHex.slice(0, 64), 'hex');
        // Node.js crypto Ed25519 PKCS8 format wrapper for raw 32-byte seed:
        const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
        const der = Buffer.concat([pkcs8Prefix, rawKey.slice(0, 32)]);
        const privateKey = crypto.createPrivateKey({
          key: der,
          format: 'der',
          type: 'pkcs8',
        });
        signature = crypto.sign(null, Buffer.from(message), privateKey).toString('hex');
      } catch (err) {
        // Fallback HMAC representation for sandbox/testing if not standard DER
        signature = crypto.createHmac('sha256', secretKeyHex).update(message).digest('hex');
      }
    } else {
      signature = crypto.createHmac('sha256', secretKeyHex || 'demo-secret').update(message).digest('hex');
    }

    return {
      'X-AUTH-APIKEY': secretKeyHex ? 'configured' : 'demo-key',
      'X-AUTH-SIGNATURE': signature,
      'X-AUTH-EPOCH': epoch,
      'Content-Type': 'application/json',
    };
  } catch (err) {
    return {
      'X-AUTH-APIKEY': 'demo-key',
      'X-AUTH-SIGNATURE': 'simulated-signature',
      'X-AUTH-EPOCH': epoch,
      'Content-Type': 'application/json',
    };
  }
}

export function validateCoinSwitchOrder(orderParams, accountSegment = 'SPOT') {
  if (accountSegment === 'SPOT' && orderParams.orderType === 'MARKET') {
    throw new Error('CoinSwitch Spot only supports LIMIT orders. Switch to FUTURES segment for MARKET orders.');
  }
  if (!orderParams.price && orderParams.orderType === 'LIMIT') {
    throw new Error('Limit price is required for CoinSwitch Limit orders.');
  }
  return true;
}
