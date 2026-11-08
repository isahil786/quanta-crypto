import React, { useState } from 'react';
import {
  Server,
  Play,
  CheckCircle2,
  AlertCircle,
  Key,
  Shield,
  Clock,
  Code,
} from 'lucide-react';

export default function TestApi() {
  const [broker, setBroker] = useState('coinswitch');
  const [endpoint, setEndpoint] = useState('/trade/api/v2/user/profile');
  const [method, setMethod] = useState('GET');
  const [requestBody, setRequestBody] = useState('{}');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);

  const endpointPresets = {
    coinswitch: [
      { label: 'User Profile & Fee Tier', method: 'GET', endpoint: '/trade/api/v2/user/profile', body: '' },
      { label: 'Spot Portfolio Holdings', method: 'GET', endpoint: '/trade/api/v2/user/portfolio', body: '' },
      { label: 'Active Open Orders', method: 'GET', endpoint: '/trade/api/v2/orders', body: '' },
      { label: 'Order Book Depth (BTCUSDT)', method: 'GET', endpoint: '/trade/api/v2/depth?symbol=BTCUSDT', body: '' },
      { label: 'Place Limit Order (Test)', method: 'POST', endpoint: '/trade/api/v2/order', body: '{"symbol":"BTCUSDT","side":"BUY","type":"LIMIT","price":90500,"quantity":0.1}' },
    ],
    delta: [
      { label: 'User Profile & KYC', method: 'GET', endpoint: '/v2/profile', body: '' },
      { label: 'Margin Wallet Balances', method: 'GET', endpoint: '/v2/wallet/balances', body: '' },
      { label: 'Open Futures Orders', method: 'GET', endpoint: '/v2/orders', body: '' },
      { label: 'Active Perpetual Positions', method: 'GET', endpoint: '/v2/positions', body: '' },
      { label: 'Place Bracket Order (Test)', method: 'POST', endpoint: '/v2/orders', body: '{"product_id":12,"size":10,"limit_price":91000,"bracket_stop_loss_price":89500}' },
    ],
    coindcx: [
      { label: 'User Profile Info', method: 'POST', endpoint: '/exchange/v1/users/info', body: '{"timestamp":1731050000}' },
      { label: 'Asset Balances', method: 'POST', endpoint: '/exchange/v1/users/balances', body: '{"timestamp":1731050000}' },
      { label: 'Active Orders', method: 'POST', endpoint: '/exchange/v1/orders/active_orders', body: '{"timestamp":1731050000}' },
      { label: 'Futures Positions', method: 'POST', endpoint: '/exchange/v1/derivatives/futures/positions', body: '{"timestamp":1731050000}' },
    ],
  };

  const handleSelectPreset = (preset) => {
    setMethod(preset.method);
    setEndpoint(preset.endpoint);
    setRequestBody(preset.body || '{}');
  };

  const handleBrokerChange = (newBroker) => {
    setBroker(newBroker);
    const firstPreset = endpointPresets[newBroker][0];
    handleSelectPreset(firstPreset);
  };

  const handleSendTest = async (e) => {
    e.preventDefault();
    setLoading(true);
    setResponse(null);
    setError(null);

    let parsedBody = {};
    try {
      if (requestBody && requestBody.trim() !== '') {
        parsedBody = JSON.parse(requestBody);
      }
    } catch (parseErr) {
      setError(`Invalid JSON in request payload: ${parseErr.message}`);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/test-endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broker,
          endpoint,
          method,
          body: parsedBody,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setResponse(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-slate-900/60 border border-slate-800/80 rounded-xl px-5 py-4">
        <div>
          <h1 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
            <Server className="w-5 h-5 text-emerald-400" />
            <span>Interactive Exchange API Console</span>
          </h1>
          <p className="text-xs text-slate-400">
            Preview request signing (Ed25519 for CoinSwitch, HMAC for Delta & CoinDCX), headers, and JSON payloads.
          </p>
          <p className="text-[11px] text-amber-300 mt-1">
            Simulated: nothing is sent to the exchange. Signatures use built-in sample keys and responses are generated from this app's paper-trading state.
          </p>
        </div>

        {/* Exchange Selector */}
        <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
          <button
            onClick={() => handleBrokerChange('coinswitch')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              broker === 'coinswitch' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            CoinSwitch PRO
          </button>
          <button
            onClick={() => handleBrokerChange('delta')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              broker === 'delta' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Delta Exchange India
          </button>
          <button
            onClick={() => handleBrokerChange('coindcx')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              broker === 'coindcx' ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            CoinDCX Prime
          </button>
        </div>
      </div>

      {/* Preset Chips */}
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-none pb-1">
        <span className="text-xs text-slate-500 font-medium shrink-0">Sample Endpoints:</span>
        {endpointPresets[broker]?.map((preset, idx) => (
          <button
            key={idx}
            onClick={() => handleSelectPreset(preset)}
            className={`px-3 py-1 text-xs rounded-lg border whitespace-nowrap transition-colors ${
              endpoint === preset.endpoint
                ? 'bg-slate-800 text-emerald-400 border-slate-700 font-semibold'
                : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Request and Response Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left: Request Form (5 Cols) */}
        <div className="lg:col-span-5 bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
          <form onSubmit={handleSendTest} className="flex flex-col gap-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <span className="text-xs font-semibold text-white">Endpoint Request Parameters</span>
              <span className="text-[10px] font-mono text-slate-400">
                Signing: {broker === 'coinswitch' ? 'Ed25519' : 'HMAC-SHA256'}
              </span>
            </div>

            {/* Method & Endpoint */}
            <div className="grid grid-cols-4 gap-2">
              <div className="col-span-1">
                <label className="text-[11px] text-slate-400">Method</label>
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-2 text-xs font-mono font-bold text-emerald-400 mt-1 focus:outline-none"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="DELETE">DELETE</option>
                </select>
              </div>

              <div className="col-span-3">
                <label className="text-[11px] text-slate-400">Target Path</label>
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-white mt-1 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            {/* Payload editor if POST */}
            <div>
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Request Body (JSON)</span>
                <span className="font-mono text-slate-500">application/json</span>
              </div>
              <textarea
                rows={5}
                value={requestBody}
                onChange={(e) => setRequestBody(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 mt-1 focus:outline-none focus:border-emerald-500"
                placeholder="{}"
              />
            </div>

            {/* Security Explanation Box */}
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-[11px] text-slate-400 space-y-1.5 font-sans">
              <div className="flex items-center gap-1.5 font-semibold text-slate-300">
                <Shield className="w-3.5 h-3.5 text-cyan-400" />
                <span>Protocol Verification</span>
              </div>
              {broker === 'coinswitch' && (
                <p>
                  CoinSwitch requires <strong>X-AUTH-SIGNATURE</strong> generated using an Ed25519 private seed over the concatenation of HTTP method, endpoint, payload, and millisecond epoch.
                </p>
              )}
              {broker === 'delta' && (
                <p>
                  Delta Exchange requires <strong>signature</strong> computed using HMAC-SHA256 over METHOD + TIMESTAMP + PATH + QUERY + BODY with your secret key.
                </p>
              )}
              {broker === 'coindcx' && (
                <p>
                  CoinDCX requires <strong>X-AUTH-SIGNATURE</strong> computed via HMAC-SHA256 over the exact JSON string body with your secret key.
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors flex items-center justify-center gap-2 shadow-sm"
            >
              {loading ? (
                <span>Executing RPC Request...</span>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>Send Request & Compute Headers</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Right: Response Inspector (7 Cols) */}
        <div className="lg:col-span-7 bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <span className="text-xs font-semibold text-white">Live Execution Inspector</span>
              {response && (
                <div className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-emerald-400 font-bold">Status: {response.responseStatus} OK</span>
                </div>
              )}
            </div>

            {error && (
              <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-xs text-rose-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {!response && !error && (
              <div className="py-24 text-center text-slate-500 text-xs">
                Select an endpoint and click &quot;Send Request&quot; to inspect signed exchange headers and returned data.
              </div>
            )}

            {response && (
              <div className="mt-4 space-y-4">
                {/* Headers Output */}
                <div>
                  <span className="text-[11px] font-semibold text-slate-400">Generated Auth Headers:</span>
                  <pre className="mt-1 p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-cyan-300 overflow-x-auto">
                    {JSON.stringify(response.requestHeaders, null, 2)}
                  </pre>
                  <p className="text-[10px] text-slate-500 mt-1">{response.signatureInfo}</p>
                </div>

                {/* Response Body Output */}
                <div>
                  <span className="text-[11px] font-semibold text-slate-400">Response Data:</span>
                  <pre className="mt-1 p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-emerald-300 overflow-x-auto max-h-72">
                    {JSON.stringify(response.responseData, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
