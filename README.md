# QuantaCrypto Terminal (paper trading)

A full-stack crypto trading-terminal UI and simulation engine for **CoinSwitch PRO**, **Delta Exchange India**, and **CoinDCX Prime**. Paper accounts are simulated in memory against live Binance public prices. Real accounts can send live spot orders only when `LIVE_TRADING=true` is set (capped by `LIVE_MAX_ORDER_USDT`, default 50 USDT per order).

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Folder Structure](#folder-structure)
- [Backend API Routes](#backend-api-routes)
- [Run & Develop](#run--develop)
- [Configuration (.env)](#configuration-env)
- [Accounts & Modes](#accounts--modes)
- [Simulation Engine](#simulation-engine)
- [Real Accounts & Balances](#real-accounts--balances)
- [Execution Realism (Fees, Slippage, Funding)](#execution-realism-fees-slippage-funding)
- [Algorithmic Bots](#algorithmic-bots)
- [Backtesting & Optimization](#backtesting--optimization)
- [Mirror Trading](#mirror-trading)
- [Safety: Emergency Stop, Reconciliation, Exposure Limits](#safety-emergency-stop-reconciliation-exposure-limits)
- [Halal Screening](#halal-screening)
- [Frontend UI](#frontend-ui)
- [Testing](#testing)
- [Lint & Typecheck](#lint--typecheck)
- [Deployment (Render/Docker)](#deployment-renderdocker)
- [Known Limits](#known-limits)
- [Security Notes](#security-notes)

---

## Overview

QuantaCrypto Terminal is a spot-only paper-trading terminal that routes orders through broker-specific adapters (CoinSwitch, Delta India, CoinDCX) and prices everything against live Binance public market data. It combines:

- A **React + Vite + Tailwind** frontend with 10 tabs (Terminal, Algo Bots, Backtesting, Orders & Trades, Positions & Balances, Mirror Trading, P&L Dashboard, Exchange Accounts, Screener, API Console).
- An **Express + Node.js** backend with a WebSocket price feed, background bot engine (3s cycle), mirror trading poller (8s cycle), reconciliation loop (60s), and state persistence to disk.
- A **paper-trading execution engine** that models margin reservation, maker/taker fees, square-root slippage, TP/SL brackets, grid/QSL/TWAP/DCA bots, halal coin filtering, and exposure limits.
- Optional **REAL mode** per account that reads real wallets from CoinSwitch / Delta / CoinDCX / Binance and (when `LIVE_TRADING=true`) sends live spot orders to the exchange.

---

## Architecture

```
quanta-crypto/
├── server.ts              # Express app, all /api routes, WebSocket server, bot loop entry
├── server/
│   ├── state.js           # In-memory state: accounts, orders, trades, positions, holdings,
│   │                       mirrorConfig, emergencyStop, exposureLimits
│   ├── binance.js         # Live Binance market data (Top 100 momentum, depth, trades, klines,
│   │                       WebSocket feed, OKX fallback on HTTP 451)
│   ├── okx.js             # OKX fallback market data client
│   ├── bots.js            # Algo bots: TWAP_SLICER, BREAKOUT_CHASER, GRID_BOT, QSL, DCA_ACCUMULATOR
│   │                       + risk management (drawdown, profit target, trailing stop)
│   ├── backtest.js        # Grid-bot backtester + multi-strategy optimizer (walk-forward)
│   ├── costs.js           # Maker/taker fees, square-root slippage model, executionCost()
│   ├── positions.js       # Spot fill accounting, margin reservation, average-cost PnL
│   ├── persist.js         # Atomic state persistence to data/state.json (every 5s)
│   ├── poller.js          # CoinSwitch open-order poller (8s) for mirror trading create/modify/cancel
│   ├── mirror.js          # Mirror trading: replicate master fills onto replicas
│   ├── safety.js          # Emergency stop, order reconciliation, exposure limits
│   ├── halal.js           # Halal coin screening (joined with live Binance prices)
│   ├── balances.js        # Wallet balance normalization, USDT/INR rate
│   ├── funding.js         # Futures funding (inactive in spot-only mode)
│   ├── util.js            # uid, mask, capList, isPositiveNumber helpers
│   ├── brokers/           # Broker metadata + request signing (Ed25519 / HMAC-SHA256)
│   ├── execution/         # Execution adapters: Binance, CoinSwitch, Delta, CoinDCX (TypeScript)
│   ├── security/accounts.js  # Seed-account loader/validator for data/accounts.json
│   └── data/halal_coins.json # Third-party halal coin list (coinranking)
├── src/
│   ├── main.tsx           # React entry point
│   ├── App.jsx            # Tab router + WebSocket client + polling
│   ├── index.css          # Tailwind base styles
│   └── components/        # 13 React components (Dashboard, AlgoBots, Backtesting, etc.)
├── data/
│   ├── accounts.json      # User-editable account seed file (gitignored, plaintext keys)
│   ├── accounts.json.example  # Example accounts file
│   └── state.json         # Persisted runtime state (gitignored)
├── tests/                 # 15 Node test files (supertest + tsx)
├── scripts/smoke-test-live.mjs  # Live CoinSwitch poller smoke test
├── package.json           # Scripts + dependencies
├── vite.config.ts         # Vite + React + Tailwind, /api proxy to :3000
├── tsconfig.json          # TypeScript config
├── eslint.config.js       # ESLint config
├── Dockerfile             # Container build
├── RENDER.md              # Render single-service deploy instructions
├── .env.example           # Environment variable reference
└── README.md
```

---

## Backend API Routes

All routes are prefixed with `/api`. Optional bearer token auth (`Authorization: Bearer <token>` or `x-api-token`) is enforced when `API_TOKEN` is set.

### Meta
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check (no auth). Returns `{ status: 'ok', service: 'quanta-crypto', time }`. |
| `GET` | `/api/meta/brokers` | Broker metadata, default broker, live crypto pairs (top 20 momentum), total momentum coin count, feed staleness. |
| `GET` | `/api/costs` | Active fee rates per broker (maker/taker) and slippage config. |
| `GET` | `/api/halal/coins` | Halal-screened coins with live USDT pairs (tradable + unavailable lists). |

### Accounts
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/accounts` | List accounts (credentials masked). |
| `POST` | `/api/accounts` | Create an account (broker, accountName, segment, mode, apiKey, apiSecret, isMaster). REAL requires credentials. |
| `PATCH` | `/api/accounts/:id/mode` | Switch account mode between PAPER and REAL. |
| `DELETE` | `/api/accounts/:id` | Delete an account (master cannot be removed while mirroring references it). |
| `POST` | `/api/accounts/test-connection` | Read-only ping + authenticated wallet fetch; reports reachability, latency, and wallet summary. |
| `POST` | `/api/accounts/:id/sync-balance` | Force sync a REAL account's wallet from the exchange. |
| `GET` | `/api/accounts/:id/balance-debug` | Raw wallet payload as returned by the exchange (no credentials). |

### Live Market Data (Binance, OKX fallback)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/market/tickers` | Top 100 momentum coins from live Binance 24hr ticker. |
| `GET` | `/api/market/depth` | Live order book depth for a symbol (bids/asks, spread). |
| `GET` | `/api/market/trades` | Live recent trades for a symbol. |
| `GET` | `/api/market/klines` | Live historical candles (intervals: 15m, 30m, 1h, 2h, 4h, 1d). |

### Orders & Execution
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/orders` | List orders with filtering (accountId, broker, status) and pagination. |
| `POST` | `/api/orders` | Place a MARKET or LIMIT order (PAPER simulated against live price; REAL sent to exchange when `LIVE_TRADING=true`). |
| `PUT` | `/api/orders/:id` | Edit an OPEN resting LIMIT order (CoinSwitch uses cancel-and-replace). |
| `DELETE` | `/api/orders/:id` | Cancel an OPEN order (REAL orders cancelled on the exchange first). |

### Trades, Positions & Holdings
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trades` | List trade records with pagination. |
| `GET` | `/api/positions` | List positions with live mark price and unrealized PnL from Binance. |
| `POST` | `/api/positions/:id/close` | Close a PAPER position with a market IOC order (realizes PnL). |
| `GET` | `/api/holdings` | List holdings with live USDT valuation per asset. |

### Algorithmic Bots
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bots` | List bots with aggregate stats (active count, realized profit, volume). |
| `POST` | `/api/bots` | Create a bot (TWAP_SLICER, BREAKOUT_CHASER, GRID_BOT, QSL, DCA_ACCUMULATOR). |
| `POST` | `/api/bots/:id/pause` | Pause/resume a bot. |
| `POST` | `/api/bots/:id/stop` | Stop (cancel) a bot. |
| `DELETE` | `/api/bots/:id` | Delete a bot. |
| `GET` | `/api/bots/optimize-grid` | Calculate optimal grid params for a symbol from live 24h range. |

### Mirror Trading
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mirror` | Mirror config, master account, and all accounts. |
| `POST` | `/api/mirror/toggle` | Enable/disable mirroring and set the master account. |
| `POST` | `/api/mirror/update-replica` | Add/update a replica (multiplier 0–100, active flag). |
| `GET` | `/api/mirror/logs/export` | Export mirror audit log as CSV. |

### Safety
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/safety/status` | Emergency stop status, exposure limits, per-account exposure and open-order counts. |
| `POST` | `/api/safety/emergency-stop` | Activate the kill-switch (blocks all new order placement). |
| `POST` | `/api/safety/emergency-stop/cancel-all` | Cancel all open orders (requires confirmation nonce). |
| `POST` | `/api/safety/emergency-stop/reset` | Deactivate the kill-switch. |
| `POST` | `/api/safety/reconcile` | Reconcile local orders against exchange open orders. |
| `GET` | `/api/safety/exposure-limits` | Get current exposure limits. |
| `POST` | `/api/safety/exposure-limits` | Set per-account / per-symbol USDT caps and per-account order caps. |

### Backtesting
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/backtest/grid` | Simulate a grid bot against live Binance klines. |
| `POST` | `/api/backtest/optimize` | Run the multi-strategy grid optimizer (walk-forward, 60% train / 40% test). |

### Test Console
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/test-endpoints` | Simulated API console: computes broker signatures (CoinSwitch Ed25519, Delta/CoinDCX HMAC) and returns mock responses. No requests leave the server. |

### WebSocket
- `WS /ws` — Real-time ticker stream. Clients can `subscribe`/`subscribe_batch`/`unsubscribe` symbols. Server broadcasts `{ type: 'ticker', data }` and an initial `{ type: 'snapshot' }`.

---

## Run & Develop

### Prerequisites
- Node.js 20+
- npm

### Install
```bash
npm install
```

### Development (server + client together)
```bash
npm run dev:all          # concurrently: server on :3000, Vite dev on :5173 (proxied)
# or separately:
npm run dev:server       # tsx watch server.ts
npm run dev:client       # vite
```

### Production
```bash
npm run build            # Vite build to dist/
npm start                # tsx server.ts (serves dist/ + API + WS)
npm preview              # Vite preview of dist/
```

### Other scripts
| Script | Purpose |
|--------|---------|
| `npm run dev` | `tsx server.ts --dev` (Vite dev middleware on :3000) |
| `npm run clean` | Remove the `dist/` directory |
| `npm run lint` | `tsc --noEmit && eslint server src tests --quiet` |
| `npm test` | `QUANTA_TEST=1 node --import tsx --test "tests/*.test.js"` |

---

## Configuration (.env)

Copy `.env.example` to `.env` and edit:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only in production with `API_TOKEN` set. |
| `API_TOKEN` | (none) | Optional bearer token required on every `/api` request and WS connection (`?token=`). Set this when exposing the server beyond loopback. |
| `TRUST_PROXY` | `0` (dev) / `1` (prod) | Number of proxy hops for `X-Forwarded-For` rate-limiting. |
| `RATE_LIMIT_PER_MIN` | `600` | Per-IP `/api` rate limit (requests per minute). |
| `ACCOUNTS_FILE` | `./data/accounts.json` | Seed accounts file (user-editable plaintext JSON). |
| `STATE_FILE` | `./data/state.json` | Persisted state file (API keys are never written). |
| `LIVE_TRADING` | (unset) | Must be `true` for REAL-mode accounts to send live orders. |
| `LIVE_MAX_ORDER_USDT` | `50` | Per-order notional cap for live orders (USDT). |
| `SLIPPAGE` | `on` | Slippage model on/off. |
| `SLIPPAGE_BASE_BPS` | `1` | Base spread slippage in basis points. |
| `SLIPPAGE_IMPACT_COEF` | `0.03` | Square-root impact coefficient. |
| `SLIPPAGE_MAX_PERCENT` | `5` | Maximum slippage percent. |
| `FUNDING_DEFAULT_RATE` | `0.0001` | Default futures funding rate per 8h interval (0.01%). |
| `USDT_INR_RATE` | (none) | Fixed USDT/INR rate for INR wallet display (otherwise fetched from CoinDCX). |
| `HALAL_ONLY` | (unset) | Force all bots onto the halal coin list regardless of UI toggle. |
| `AUTO_POSITION_EXITS` | (unset) | Set to `false` to disable auto TP/SL position closes. |
| `MAX_WS_CLIENTS` | `100` | Max concurrent WebSocket clients. |
| `ENABLE_RECONCILIATION_LOOP` | (unset) | Set to `false` to disable the 60s reconciliation loop. |
| `DISABLE_HMR` | (unset) | Set to `true` to disable Vite HMR/file watching (AI Studio). |
| `QUANTA_TEST` | (unset) | Test mode: skips price-feed caching and WebSocket, seeds accounts for tests. |

---

## Accounts & Modes

Accounts live in `data/accounts.json` (seed file) and are loaded on startup. Each account has:

- `broker`: `coinswitch`, `delta`, `coindcx`, or `binance`
- `segment`: `SPOT` (only segment supported)
- `mode`: `PAPER` (simulated, 10,000 USDT starting balance) or `REAL` (reads live wallet from exchange)
- `isMaster`: whether the account is the mirror-trading master
- `apiKey` / `apiSecret`: stored plaintext (local-only use; never commit real keys)

**PAPER mode:** Every order is simulated against the live Binance price. The account starts with 10,000 USDT. No funds leave your machine.

**REAL mode:** On startup and every 60s (plus via the Sync button), the server reads the live wallet from the exchange:
- CoinSwitch: `GET /user/portfolio`
- Delta India: `GET /v2/wallet/balances` (India keys, separate from global Delta keys; server IP must be whitelisted; wallet reported in USD, counted as USDT)
- CoinDCX: `POST /users/balances`
- Binance: `GET /api/v3/account`

INR balances are listed but not converted for trading (CoinSwitch/CoinDCX wallets are often INR-funded). Convert INR to USDT on the exchange first.

A `"mode"` in `accounts.json` overrides any mode restored from `state.json`. REAL accounts start with 0 USDT until the first balance sync.

**Test Connection** (`POST /api/accounts/test-connection`) makes a real read-only authenticated call and reports the wallet or the exchange's rejection reason (e.g., un-whitelisted IP). A 0 USDT balance comes with a reason: INR-only wallet, funds in USD/USDC, empty wallet, or an API error.

---

## Simulation Engine

The paper engine has one accounting path for manual orders, resting limits, GTT rules, and bots:

- **Fees:** maker fee for resting-limit fills, taker fee for market orders, marketable limits, TWAP/breakout fills, GTT triggers, and TP/SL exits. Grid/QSL rung fills are maker fills. Rates live in `server/brokers/*.js` (`makerFeePercent` / `takerFeePercent`) — set them to your own fee tier.
- **Margin reservation:** A resting limit order locks what it needs (USDT for a spot BUY, base coins for a spot SELL). Funds return on fill, cancel, edit, or account removal. An order you can't fund is refused at placement, not at fill time. The wallet shows the locked amount.
- **Spot balances:** SELLs need the asset in the account; BUYs need USDT. Unfunded orders and bot fills are rejected. Average-cost accounting tracks `avgCost` per holding.
- **Positions:** Spot SELLs reduce the holding and realize PnL `(fillPrice - avgCost) * size`. BUYs increase the holding and update average cost.
- **TP/SL brackets:** Set on an order, they attach to the resulting position and auto-close it at market when reached. Stop-loss wins if both are crossed in one cycle. Plain spot fills have no position — use GTT rules there.
- **Resting limit orders** are evaluated every 3s against Binance prices. A resting LIMIT that gets hit is a maker fill (no slippage).
- **Mirroring:** Resting limit orders on the master account mirror to replicas when they fill (manual orders only, not bot or rule fills).
- **Backtest optimizer:** Picks grid ranges on the first 60% of candles and scores on the last 40% (out-of-sample).
- **Binance blocked (HTTP 451):** Market data and WebSocket tickers fall back through Binance mirror hosts (`api1`–`api4.binance.com`), then OKX. `GET /api/health` is the health-check route; in production the server binds `0.0.0.0`.

---

## Execution Realism

| Feature | Behaviour |
|---------|-----------|
| **Margin reservation** | Resting limit order locks what it needs: USDT for a spot BUY, margin for futures, coins for a spot SELL. Funds come back on fill, cancel, edit, or account removal. An order you can't fund is refused at placement. The wallet shows the locked amount. |
| **Maker / taker fees** | Resting limit orders that get hit pay the **maker** fee; market orders, marketable limits, TWAP/breakout fills, GTT triggers and TP/SL exits pay the **taker** fee. Grid/QSL rung fills are maker fills. Rates in `server/brokers/*.js`; set to your fee tier. |
| **Slippage** | Taker fills move against the order by `base spread + coef * sqrt(order value / 24h volume)` (capped at `SLIPPAGE_MAX_PERCENT`). Bigger orders and thinner coins slip more. Maker fills have none. A marketable limit never fills worse than its limit price. Mirror replicas are refused if expected slippage exceeds their `maxSlippagePercent`. Tune via `SLIPPAGE=off`, `SLIPPAGE_BASE_BPS`, `SLIPPAGE_IMPACT_COEF`, `SLIPPAGE_MAX_PERCENT`. |
| **Funding** | Futures positions held through 00:00 / 08:00 / 16:00 UTC pay or receive `size * mark * rate` (longs pay when the rate is positive). Rates from Binance USDT-M premium index, otherwise `FUNDING_DEFAULT_RATE` (0.0001 = 0.01%). Catch-up after downtime capped at 3 intervals. If the wallet is empty, funding is taken from the position's margin. |

`GET /api/costs` shows the active fee/slippage settings; `GET /api/funding` shows funding payments. Trades record `liquidity` (MAKER/TAKER), `slippagePct`, and `refPrice`.

**Known limits:** Funding does not move a position's liquidation price. Bots' internal rung orders and GTT rules do not reserve funds (only resting limit orders placed through the order API do).

---

## Algorithmic Bots

Five bot types are supported via `POST /api/bots`:

### TWAP_SLICER (Time-Weighted Average Price)
Slices a total size into `slicesCount` equal slices executed every `intervalSeconds`. The last slice takes any remainder. Supports daily drawdown pause, profit-target stop, and trailing-stop exit. Reports average execution price.

### BREAKOUT_CHASER
Waits for the live price to cross a `triggerPrice` (BUY: price goes above; SELL: price goes below), then executes a single market order. Validates that the trigger lies ahead of the market. Supports TP/SL brackets.

### GRID_BOT
Places one resting limit order per grid interval between `lowerPrice` and `upperPrice` (arithmetic or geometric spacing). Buy rungs below the market, sell rungs above. When a buy rung fills, it flips to a sell at the target price (and vice versa), harvesting the spread. Seed inventory for sell rungs is bought at market on creation (rejected if the account can't fund it). Supports `maxInventory`, `stopLossPrice`, `takeProfitPrice`, drawdown, profit target, and trailing stop. Grid spacing is validated to cover the round-trip fee (`checkGridSpacing`).

### QSL (MRS Quant Square Levels)
Price levels derived from square numbers (`level(n) = square(n) / 10^decimals`). Auto-recenters when price reaches `triggerLevel` above/below the center number. BUY levels below the market, SELL levels above. Same flip-to-opposite-side mechanics as the grid bot.

### DCA_ACCUMULATOR
Buys a fixed `dcaAmountPerInterval` of USDT worth of a symbol every `dcaIntervalSeconds` (minimum 60s) until `dcaTotalAmount` is reached. Reports average execution price.

### Risk management (all bot types)
- `maxDailyDrawdownPercent` — pauses the bot when account equity drops X% from its 24h high-water mark (resets every 24h).
- `dailyProfitTargetPercent` — stops the bot when realized + unrealized PnL % hits the target.
- `trailingStopPercent` — sells inventory and stops when price drops X% from its peak since bot start.
- `timeExitHours` — stops the bot after N hours.

### Correlation filter
Concurrent bots on highly correlated pairs (BTC/ETH/BNB/SOL/XRP/ADA/DOGE/AVAX/DOT/LINK) are blocked on the same account.

### Optimal grid params
`GET /api/bots/optimize-grid` suggests grid bounds, count, step, and mode from the live 24h high/low, with a recommended size based on price magnitude.

---

## Backtesting & Optimization

`POST /api/backtest/grid` simulates a grid bot against live Binance klines (walk-forward, candle by candle). Returns: net profit, return %, annualized APR, max drawdown, trade counts, win rate, profit factor, Sharpe ratio, equity history, and per-rung trade logs.

`POST /api/backtest/optimize` runs six strategy presets (tight scalp, balanced geometric, wide swing, high-density arithmetic, asymmetric momentum) with out-of-sample testing: ranges chosen from the first 60% of candles, scored on the last 40%. Results are ranked by Sharpe ratio, then net return, then drawdown. The winner is marked `isWinner: true`.

---

## Mirror Trading

Replicate a master account's filled orders onto replica accounts:

1. Mark one account as `isMaster` with `mode: REAL` and `broker: coinswitch`.
2. `POST /api/mirror/toggle` with `{ enabled: true, masterAccountId }`.
3. `POST /api/mirror/update-replica` for each replica account with a `multiplier` (0–100, e.g. `0.5` = half size).

**Behaviour:**
- Only manual orders mirror (not bot/rule fills, not mirror orders themselves).
- Replicas are taker orders at the live price; they slip with their own size and are refused if expected slippage exceeds `maxSlippagePercent` (default 0.2%).
- MARKET orders on PAPER replicas are adapted to marketable LIMIT orders. REAL replicas keep the master's exact order type.
- Cancel-and-replace is used for modifications (CoinSwitch doesn't support in-place modify).
- Full audit log via `GET /api/mirror/logs/export` (CSV).

Two mirroring paths operate:
- **Fill-stream mirroring** (`server.ts`): when a master fill WS event arrives, the exact order is copied to replicas immediately.
- **Poller** (`server/poller.js`): every 8s, polls CoinSwitch open orders on master accounts and mirrors creates/modifies/cancels. This catches orders placed outside the app (phone/portal).

---

## Safety: Emergency Stop, Reconciliation, Exposure Limits

### Emergency stop (kill-switch)
`POST /api/safety/emergency-stop` activates the stop, blocking all new order placement. It returns a confirmation nonce. `POST /api/safety/emergency-stop/cancel-all` with that nonce cancels all open orders (PAPER locally; REAL on the exchange via adapters). `POST /api/safety/emergency-stop/reset` deactivates it. The nonce is single-use.

### Reconciliation
Every 60s (when `ENABLE_RECONCILIATION_LOOP !== 'false'`), local OPEN orders are compared against exchange open orders for master accounts:
- Local OPEN but missing from exchange → checked via `getOrder`; marked FILLED, PARTIALLY_FILLED, or CANCELLED accordingly.
- Exchange order not tracked locally → a local record is created (best effort).
- Also runs on WS disconnect to catch missed fills.

### Exposure limits
`GET/POST /api/safety/exposure-limits` configure per-account max USDT, per-symbol max USDT, and per-account max open orders. Checked before every order placement (manual, mirror, bot).

---

## Halal Screening

`server/data/halal_coins.json` (third-party list from coinranking) is joined with live Binance/OKX prices at `GET /api/halal/coins`. The Algo Bots pair picker defaults to "Halal only" and lists every halal coin with a live USDT pair, not just the top movers. Bot creation rejects non-halal pairs when the client sends `halalOnly: true` or the server runs with `HALAL_ONLY=true`.

This is a third-party screen, **not a religious ruling**. Verify with a scholar you trust before trading. Pegged assets (USDT, USDC, DAI, BUSD) are excluded. Renamed tickers are mapped (MATIC → POL, KLAY → KAIA).

---

## Frontend UI

Built with **React 19 + Vite 6 + Tailwind CSS 4 + Lucide React**. The dev server proxies `/api` to `http://127.0.0.1:3000`.

Tabs (via `Layout.jsx`):

| Tab | Component | Purpose |
|-----|-----------|---------|
| Terminal | `Dashboard.jsx` | Live Top 100 momentum ribbon, order book depth, recent trades, fast order ticket with TP/SL brackets |
| Algo Bots | `AlgoBots.jsx` | Create/pause/stop TWAP, breakout, grid, QSL, DCA bots; view logs and realized PnL |
| Backtesting | `Backtesting.jsx` | Run grid backtests and strategy optimization on live Binance data; deploy winners to live bots |
| Orders & Trades | `Trades.jsx` | Order history and trade records with pagination |
| Positions & Balances | `Positions.jsx` | Positions with live mark price/unrealized PnL; close positions |
| Mirror Trading | `MirrorTrading.jsx` | Configure master/replica mirroring; view audit logs |
| P&L Dashboard | `PnLDashboard.jsx` | Aggregate PnL across accounts |
| Exchange Accounts | `Accounts.jsx` | Add/edit accounts, switch PAPER↔REAL mode, test connection, sync balances |
| Screener | `Screener.jsx` | Scan momentum coins; open TradingView charts |
| API Console | `TestApi.jsx` | Simulated endpoint inspector with broker signature computation |

The frontend connects to `WS /ws` for real-time ticker updates and polls REST endpoints every 3s. The header shows the active account's broker badge and LIVE/Paper status indicator.

---

## Testing

```bash
npm test
```

Runs 15 test files under `tests/` with `QUANTA_TEST=1` (skips price-feed caching and WebSocket, seeds accounts from `data/accounts.json.example`):

| Test file | Coverage |
|-----------|----------|
| `balances.test.js` | Balance normalization, USDT/INR rate |
| `binance.test.js` | Binance market data client |
| `binance-adapter.test.js` | Binance execution adapter |
| `bots-logic.test.js` | Bot runners (TWAP, breakout, grid, QSL, DCA) with scripted prices |
| `cancel-real.test.js` | Real order cancellation |
| `costs.test.js` | Fee/slippage/execution-cost calculations |
| `engine.test.js` | Core order/fill/position engine |
| `fill-matching.test.js` | Fill matching logic |
| `fuzz.test.js` | Fuzz testing |
| `mirror-exact.test.js` | Exact mirror trading behaviour |
| `mirror.test.js` | Mirror trading |
| `persist.test.js` | State persistence |
| `poller.test.js` | CoinSwitch order poller |
| `routes.test.js` | HTTP API routes (supertest) |
| `safety.test.js` | Emergency stop, reconciliation, exposure limits |

---

## Lint & Typecheck

```bash
npm run lint
```

Runs `tsc --noEmit` followed by `eslint server src tests --quiet`.

---

## Deployment (Render/Docker)

`RENDER.md` documents the single-service setup:

- **Build Command:** `npm ci && npm run build`
- **Start Command:** `npm start`
- **Health Check Path:** `/api/health` (or root)

The `Dockerfile` builds the Vite app and serves it from the same Express container. In production the server binds `0.0.0.0` and requires `API_TOKEN` (the startup refuses to bind a non-loopback host without a token).

Docker image is built from the repo root; `.dockerignore` excludes `node_modules`, `dist`, `data`, and `.git`.

---

## Known Limits

- Funding does not move a position's liquidation price.
- Bots' internal rung orders and GTT rules do not reserve funds (only resting limit orders placed through the order API do).
- Prices are raw, unadjusted NSE/Binance data — no corporate-action adjustment.
- APR extrapolated from short backtest windows is unreliable (flagged via `aprReliable`).
- REAL-mode accounts require valid API credentials; the server refuses to start if any REAL account has placeholder keys.
- Spot trading only — `leverage` must be 1; no futures positions are opened by the paper engine (futures funding module exists but is inactive in spot mode).

---

## Security Notes

- API keys are stored **plaintext** in `data/accounts.json` (local-only use). `data/accounts.json` and `data/state.json` are gitignored — never commit them.
- `API_TOKEN` is strongly recommended whenever `HOST` is not loopback. It protects all `/api` routes and WebSocket connections.
- Credentials are never returned to the UI (only masked via `sanitizeAccount`).
- The Test API Console (`/api/test-endpoints`) uses built-in sample keys and simulates responses — nothing is sent to a real exchange.
- Live trading is off by default (`LIVE_TRADING` unset). REAL accounts cannot send orders until it is explicitly enabled, and per-order notional is capped at `LIVE_MAX_ORDER_USDT` (default 50 USDT).
- The emergency stop nonce is single-use and consumed on cancel-all.
