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


## Execution realism

The paper engine models the costs that decide whether a strategy actually makes money.

| Feature | Behaviour |
| --- | --- |
| **Margin reservation** | A resting limit order locks what it needs: USDT for a spot BUY, margin for futures, coins for a spot SELL. Funds come back on fill, cancel, edit or account removal. An order you can't fund is refused at placement, not at fill time. The wallet shows the locked amount. |
| **Maker / taker fees** | Resting limit orders that get hit pay the **maker** fee; market orders, marketable limits, TWAP/breakout fills, GTT triggers and TP/SL exits pay the **taker** fee. Grid/QSL rung fills are maker fills. Rates live in `server/brokers/*.js` (`makerFeePercent` / `takerFeePercent`) and are estimates: set them to your own fee tier. |
| **Slippage** | Taker fills move against the order by `base spread + coef * sqrt(order value / 24h volume)` (capped). Bigger orders and thinner coins slip more. Maker fills have none. A marketable limit never fills worse than its limit price. Mirror replicas are refused if expected slippage exceeds their `maxSlippagePercent`. Tune with `SLIPPAGE=off`, `SLIPPAGE_BASE_BPS` (1), `SLIPPAGE_IMPACT_COEF` (0.03), `SLIPPAGE_MAX_PERCENT` (5). |
| **Funding** | Futures positions held through 00:00 / 08:00 / 16:00 UTC pay or receive `size * mark * rate` (longs pay when the rate is positive). Rates come from the Binance USDT-M premium index when reachable, otherwise `FUNDING_DEFAULT_RATE` (default 0.0001 = 0.01%). A position opened after a boundary pays nothing for it, and catch-up after downtime is capped at 3 intervals. If the wallet is empty, funding is taken from the position's margin. |

`GET /api/costs` shows the active fee/slippage/funding settings, `GET /api/funding` the funding payments. Trades record `liquidity` (MAKER/TAKER), `slippagePct` and `refPrice`.

Known limits: funding does not move a position's liquidation price; bots' internal rung orders and GTT rules do not reserve funds (only resting limit orders placed through the order API do).
