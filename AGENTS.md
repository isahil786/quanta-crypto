# QuantaCrypto — AGENTS.md

## Project Overview

**QuantaCrypto Terminal** is a paper-trading terminal with optional live (REAL) trading support for CoinSwitch PRO Spot, Delta Exchange India, CoinDCX, and Binance Spot.

- **Backend**: Express + TypeScript/JS (`server.ts`, ~2534 lines), single monolithic entry point
- **Frontend**: React + Vite SPA (`src/`), served via Vite in dev, static in prod
- **Market data**: Binance Spot public API via REST + WebSocket (`wss://stream.binance.com:9443`), OKX fallback on HTTP 451
- **State**: In-memory only (`server/state.js`), resets on restart unless `STATE_FILE` configured

## Key Directories

| Path | Purpose |
|---|---|
| `server.ts` | Main entry: Express app, routes, WebSocket server, adapter wiring, startup/shutdown |
| `server/binance.js` | Binance Spot market data (tickers, depth, trades, klines, INR/USDT rate) |
| `server/poller.js` | Order poller (8s cycle), adapter factory, mirror order replication |
| `server/execution/types.ts` | Shared `ExecutionAdapter` interface + all types |
| `server/execution/coinswitch.ts` | CoinSwitch Spot adapter: order WS + market-data WS (order book, candle, trade) + balance WS |
| `server/execution/binance.ts` | Binance execution adapter |
| `server/execution/delta.ts` | Delta Exchange adapter |
| `server/execution/coindcx.ts` | CoinDCX adapter |
| `server/brokers/coinswitch.js` | CoinSwitch signing (`signCoinSwitchRequest`) + metadata |
| `server/brokers/index.js` | Broker registry + `signCoinSwitchRequest`, `signDeltaRequest`, `signCoinDCXRequest` exports |
| `server/positions.js` | Position/margin engine |
| `server/safety.js` | Emergency stop, exposure limits, reconciliation |
| `server/mirror.js` | Master/replica mirror trading |
| `server/bots.js` | Algo bot engine (TWAP, Breakout, Grid, QSL, DCA — PAPER only) |
| `src/App.jsx` | Root app, WebSocket client, ticker/candle state |
| `src/components/Dashboard.jsx` | Main Terminal dashboard |
| `src/components/Layout.jsx` | App shell (sidebar, header, tabs) |
| `src/ui/PriceChart.jsx` | Lightweight-charts candlestick chart (Binance REST + CoinSwitch WS overlay) |
| `tests/` | Node test runner tests (`QUANTA_TEST=1`) |

## Critical Implementation Notes

### CoinSwitch Authentication (Ed25519)

**Single source of truth**: `server/brokers/coinswitch.js:signCoinSwitchRequest(apiKey, apiSecretHex, method, endpoint, query)`

- Signed message: `METHOD + decodedPath + epoch` (payload/query NOT included)
- Headers: `X-AUTH-APIKEY` (actual apiKey), `X-AUTH-SIGNATURE`, `X-AUTH-EPOCH`, `Content-Type`
- Re-exported as `signCoinSwitchAuth` from `server/execution/coinswitch.ts`

**BUG HISTORY**: The old `signCoinSwitchRequest` sent `'configured'` (literal string) as `X-AUTH-APIKEY` instead of the actual apiKey, and signed `method + endpoint + payload + epoch` (wrong format). Fixed to match the actual CoinSwitch spec.

### PAPER vs REAL Mode

- **PAPER**: Simulated orders against live Binance prices. Bots, GTT, TP/SL allowed.
- **REAL**: Live orders via exchange adapters. Bots/GTT/TP/SL are refused on REAL accounts.
- `server/state.js:4`: "Pure spot trading only — no futures, no leverage, no funding."

### WebSocket Architecture

| Socket | Purpose | Namespace | Auth |
|---|---|---|---|
| Binance ticker | Live prices for all symbols | Direct `wss://stream.binance.com:9443/ws/{sym}@ticker` | None |
| CoinSwitch order-updates | User fills/orders | `/orderupdates` | API key (Socket.IO auth) |
| CoinSwitch market-data | Order book, candle, trades (shared) | `/coinswitchx` | None |
| CoinSwitch balance-updates | Per-account balance changes | `/balanceupdates` | API key |

### Key Files Modified in Recent Work

1. `server/execution/coinswitch.ts` — Added Order Book, Candlestick, Trades websockets; Balance Updates websocket; exported `signCoinSwitchAuth`
2. `server/binance.js` — Fixed INR/USDT rate fetch to use signed CoinSwitch auth (was returning 401)
3. `server/brokers/coinswitch.js` — Fixed `signCoinSwitchRequest`: correct signing format, actual apiKey header
4. `server.ts` — Added candle subscription WS handlers; fixed `signCoinSwitchRequest` callers to pass `apiKey`
5. `src/ui/PriceChart.jsx` — Rewritten: always loads REST history, CoinSwitch WS overlay, all intervals clickable
6. `src/App.jsx` — Candle subscription + candle message handling
7. `src/components/Dashboard.jsx` — Passes broker/segment/candleData to PriceChart
8. `src/components/Layout.jsx` — Removed `LogPanel` (server logs print to stdout only)

## Testing

- `npm test` — `QUANTA_TEST=1 node --import tsx --test "tests/*.test.js"`
- `npm run lint` — `tsc --noEmit && eslint server src tests --quiet`
- 4 pre-existing test failures in `tests/routes.test.js` (unrelated to websocket work)

## No AGENTS.md existed before — this file is new

## Common Gotchas

- `server.ts` is monolithic (2534 lines). Consider splitting into `routes.ts`, `websocket.ts`, `adapters.ts`, `startup.ts` for maintainability.
- CoinSwitch spot symbol format: `BASE,QUOTE` (comma-separated) for websockets, `BASE/QUOTE` for REST.
- Binance futures endpoints (`fapi.binance.com`, `fstream.binance.com`) are NOT used anywhere — spot only.
- Vite dev proxy (`/ws` → backend) can log `write EPIPE` on reconnect — benign, doesn't affect functionality.
- `DISABLE_HMR=true` disables Vite Hot Module Replacement (used in AI Studio).
