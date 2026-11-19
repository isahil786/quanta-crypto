export const BINANCE_META = {
  id: 'binance',
  displayName: 'Binance Spot',
  category: 'crypto',
  spotBaseUrl: 'https://api.binance.com',
  wsUrl: 'wss://stream.binance.com:9443',
  formFields: [
    { name: 'accountName', label: 'Account Nickname', type: 'text', placeholder: 'e.g. Binance Main', required: true },
    { name: 'apiKey', label: 'API Key', type: 'text', placeholder: 'Enter your Binance API Key', required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', placeholder: 'Enter your Binance API Secret', required: true },
    { name: 'segment', label: 'Segment', type: 'select', options: ['SPOT'], defaultValue: 'SPOT', required: true },
  ],
  capabilities: {
    supportsMarketOrder: true,
    supportsFuturesMarketOrder: false,
    supportsModifyOrder: false,
    supportsCancelOrder: true,
    supportsPositions: false,
    supportsFuturesPositions: false,
    supportsHoldings: true,
    supportsGTT: false,
    supportsBracketOrders: false,
    supportsLeverage: false,
    supportsFuturesLeverage: false,
    supportsWebSocket: true,
    supportsOrderBook: true,
    supportsDepth: true,
    feeEstimatePercent: 0.1,
    makerFeePercent: 0.1,
    takerFeePercent: 0.1,
  },
};

export function validateBinanceOrder(orderParams, accountSegment = 'SPOT') {
  if (!orderParams.symbol || typeof orderParams.symbol !== 'string') {
    throw new Error('symbol is required');
  }
  if (orderParams.orderType === 'LIMIT' && !orderParams.price) {
    throw new Error('Limit price is required for Binance Limit orders.');
  }
  return true;
}
