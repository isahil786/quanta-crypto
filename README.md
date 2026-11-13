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

## Grid Bot — Ladder & Trailing TP/SL

### How the ladder works
Each grid bot creates a price ladder between `lowerPrice` and `upperPrice` split into `gridCount` rungs:

- **ARITHMETIC** — evenly spaced prices from lower to upper.
- **GEOMETRIC** — exponentially spaced prices from lower to upper.
- Rungs **below** the live price at creation are `BUY` side with a sell target above them.
- Rungs **above** the live price at creation are `SELL` side with a buy target below them.
- When a buy rung fills at `price`, it flips to a `SELL` limit at `targetPrice`. When a sell rung fills, it flips back to a `BUY` limit at `targetPrice`. Rungs cycle buy → sell → buy on each round trip.

### Ladder options (per `server/bots.js:generateGridRungs`)
| Option | Behavior |
|--------|----------|
| Uneven split | The number of buy rungs below market vs sell rungs above is determined by where `lowerPrice`/`upperPrice` sit relative to the live price; you can set `lowerPrice` closer to market for more buys above, or wider for fewer buys. |
| Asymmetric spacing | GEOMETRIC mode spaces rungs multiplicatively (wider gaps higher up, tighter lower down) instead of ARITHMETIC's equal steps. |
| No flipping | Not supported — every rung always flips side after a fill so it can harvest the next spread in the opposite direction. |
| Trailing ladder | Not supported — ladders are fixed at creation; QSL bots recentre square levels on trigger instead (`server/bots.js:recenterQSL`). |
| Size allocation | Every rung uses the same `sizePerGrid`; total seed inventory = sellRungCount × sizePerGrid, bought at market on creation. |

### Trailing TP / SL per rung
Pass `trailingTpSlPercent` (e.g. `1.0` for 1%) when creating a GRID_BOT:

- On each buy fill, the rung records `entryPrice`, `peakPrice`, `tpPrice = entry × (1 + pct)`, `slPrice = entry × (1 - pct)`.
- While the rung holds a sell side, `peakPrice` trails upward as live price rises and `slPrice` is recomputed as `peak × (1 - pct)`.
- The rung sells at market on the first of: grid target hit, trailing take-profit hit, or trailing stop-loss hit.
- After the sell, the rung flips back to BUY and TP/SL tracking is cleared.

Grid realized profit (`/api/bots` stats) sums the net of each filled sell (`gross - fees`) across all rungs.
