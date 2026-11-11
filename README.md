# QuantaCrypto Terminal (paper trading)

A trading-terminal UI and simulation engine for CoinSwitch PRO, Delta Exchange India and CoinDCX.
**Nothing is sent to any exchange.** Orders, positions, bots and mirror trades are simulated in memory
against live Binance public prices. State resets on restart.

## Run
    npm install
    npm run dev      # Vite dev middleware on http://127.0.0.1:3000
    npm run build && npm start   # production: serves dist/
    npm test

## Config (.env)
- `PORT` (3000), `HOST` (127.0.0.1 by default), `API_TOKEN` (optional bearer token for /api;
  in the browser run `localStorage.setItem('apiToken','<token>')`).

## Simulation notes
- One accounting path for manual orders, resting limits, GTT rules and bots: fees, margin (futures or
  leveraged orders), spot USDT/asset balances with average-cost PnL, and net positions (reduce/close/flip).
- Spot SELLs need the asset in the account; BUYs need USDT. Unfunded orders and bot fills are rejected.
- Grid bots buy their starting inventory at market when created (rejected if the account can't fund it).
- Resting LIMIT orders, GTT rules and bots are evaluated every 3s against Binance prices.
- TP/SL set on an order or breakout bot attaches to the resulting position (futures or leveraged accounts) and auto-closes it at market when reached; stop-loss wins if both are crossed in one cycle. Plain spot fills have no position, so use GTT rules there.
- Resting limit orders on the master account mirror to replicas when they fill (manual orders only, not bot or rule fills).
- Backtest optimizer picks ranges on the first 60% of candles and scores on the last 40%.
- Halal screening: `server/data/halal_coins.json` (coinranking halal list) is joined with live Binance/OKX prices at `GET /api/halal/coins`. The Algo Bots pair picker defaults to "Halal only" and lists every halal coin with a live USDT pair, not just the top movers. Bot creation rejects non-halal pairs when the client sends `halalOnly: true` or the server runs with `HALAL_ONLY=true`. This is a third-party screen, not a religious ruling.
- Binance blocked from your host (HTTP 451, common on Render)? Market data and websocket tickers fall back to Binance mirror hosts, then OKX. `GET /api/health` is the health-check route; in production the server binds 0.0.0.0.
