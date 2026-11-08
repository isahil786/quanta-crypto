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
- TP/SL on orders and breakout bots are recorded, not auto-executed (use GTT rules).
- Backtest optimizer picks ranges on the first 60% of candles and scores on the last 40%.
