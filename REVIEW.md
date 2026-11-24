# Quanta Crypto: review notes

Baseline: 107 tests passed, `tsc` clean, build OK, `npm audit` 0 vulns, but `npm run lint` FAILED (4 errors).
After fixes: 113 tests pass, lint/tsc/build all green.

## Fixed in this zip
| # | Severity | Problem | Fix |
|---|---|---|---|
| 1 | Critical | `runOpenOrders` (bots.js) paper-filled REAL resting limit orders when Binance price crossed them: local balances changed, funds "released", order marked FILLED and even mirrored, while the real order was still live. Reproduced. | Skip `mode === 'REAL'` orders |
| 2 | High | Bots could be created on REAL accounts and booked simulated trades into a live account's local state | `POST /api/bots` returns 400 for REAL accounts |
| 3 | High | REAL pre-trade guard required USDT >= notional for SELLs too, so you could not sell coins without USDT | Guard applies to BUY only |
| 4 | High | Reconciliation marked a live order CANCELLED (and released funds) on ANY lookup error, e.g. a timeout | Needs 3 consecutive failed lookups |
| 5 | High | Exchange-side cancel/expire/reject events (zero new fill) were ignored; order stayed OPEN | `applyRealFill` now applies terminal status |
| 6 | Medium | `POST /api/accounts/:id/sync-balance` always failed: it called `syncAccountBalances`, which was nested inside `startServer()` | Hoisted to module scope; also works for all brokers with an adapter; PAPER gives a clear 400 |
| 7 | Medium | Balance sync only ran for CoinSwitch, so Binance/Delta/CoinDCX REAL accounts kept the fake 10,000 USDT seed and the margin guard checked it | Sync now covers every broker with an adapter |
| 8 | Medium | `stopPriceFeed` used in shutdown but never imported (ReferenceError hidden by `try{}catch{}`) | Imported |
| 9 | Medium | REAL orders accepted tpPrice/slPrice but nothing enforces them; timeInForce unvalidated | Rejected with a clear message / validated |
| 10 | Medium | Binance adapter retried every request on all 5 hosts even for 4xx rejections; numbers like 1e-7 were sent in exponent form (rejected) | No retry on 4xx (except 403/451); plain decimal strings |
| 11 | Low | `/api/mirror/toggle` changed `enabled` before validating master (rejected call still mutated config) | Validate first |
| 12 | Low | Deleting a REAL account left its adapter and user stream alive and allowed deletion with live open orders | Blocked with 409 / adapter disconnected |
| 13 | Low | Non-loopback + no `API_TOKEN` check ran after streams/pollers started | Moved to the start of `startServer` (also allows `::1`) |
| 14 | Low | Seed loader rejected `binance` although the API and adapters support it | Added |
| 15 | Low | Lint: 4 errors (missing globals, unknown `react-hooks` rule) failed CI | Fixed |
| 16 | Low | Vite dev proxy did not proxy `/ws` and hard-coded port 6001 (.env.example says 6000) | `/ws` proxied, port follows `PORT` |
| 17 | Docs | README and test-connection said "nothing is sent to any exchange" but REAL mode trades for real; wrong default port | Updated |

## Round 2 (follow-up request)
| Area | Change |
|---|---|
| **Live fills were broken** | Removing `@ts-nocheck` exposed that `applyRealFill` called two undefined functions (`syncUsdtHolding`, `syncBaseHolding`). Every live fill threw midway and never wrote a trade record. Fixed, with a regression test. |
| `@ts-nocheck` | Removed from `server.ts`; the 9 type errors it hid are fixed. `tsc` now really checks the server entry file. |
| Crash handler | `uncaughtException` now logs and exits(1) so Docker/Render restarts clean (`CRASH_ON_UNCAUGHT=false` to opt out; tests never exit). |
| Reconciliation | Runs for every REAL account on any supported exchange, not only CoinSwitch masters. |
| Mirroring | Master can be on any supported exchange (CoinSwitch, Binance, Delta, CoinDCX); replicas must be on the same exchange as the master. One shared adapter per account (was two). |
| Binance rounding | Quantity floored to LOT_SIZE/MARKET_LOT_SIZE step, price rounded to PRICE_FILTER tick, min qty and min notional checked with a clear error. Rules come from public `exchangeInfo`, cached 6h. |
| Real fees | Live fills use the commission the exchange reports (USDT, or the base coin, which also reduces coins received); falls back to the estimate otherwise (e.g. paid in BNB). |
| **Chart not live** | It connected straight from the browser to Binance's websocket (blocked in India and other regions) and only polled after a failure; 1W/1M candles used the wrong bucket time. Rewritten: history plus a 2s re-sync from the server, and the forming candle follows the app's own live tick stream. Verified in a browser: a pushed tick moves the last candle at once. |
| **Dashboard showed the wrong coin** | If the selected pair was not in the top-100 momentum list, it silently showed the first ticker (or a hard-coded fake BTC 76,000 price) and re-created the chart. It now always follows the selected symbol, and the server streams it. |
| **UI blinking** | (1) every websocket message re-rendered the whole app, now batched every 400 ms; (2) the 3s REST poll overwrote newer websocket prices with older ones, making prices jump and flash, now merged by timestamp; (3) accounts/holdings were replaced every 3s even when unchanged, now only when they differ; (4) the price flash ignores moves under 0.005%. |
| Pollers | All 12 interval pollers skip work while the tab is hidden (`visibleInterval`). |
| Bundle | Entry chunk 647 kB to 289 kB; tabs other than the dashboard, plus charts and React, are separate chunks. |
| **Fonts blocked in production** | The CSP blocked the Google Fonts stylesheet, so the UI fell back to system fonts. CSP now allows `fonts.googleapis.com` / `fonts.gstatic.com`. |

## Not changed, needs your decision
1. **Mirroring is on by default and auto-wires real money.** `mirrorConfig.enabled = true` and at startup every REAL CoinSwitch account becomes a replica at 1x of the master. Consider default off plus explicit opt-in.
3. **No auth by default** (loopback only). No Host/Origin check, so DNS rebinding could reach the API on localhost; add a Host allow-list when REAL mode is used.
4. **Plaintext API keys** in `data/accounts.json`; comments mention "decrypted in-memory" but nothing is encrypted. Prefer env vars or an OS keychain.
8. **WS `unsubscribe` from one browser removes the symbol for all clients**, and subscriptions never expire, so after 50 distinct symbols new ones are silently ignored.
10. `/api/logs` returns raw console args (no redaction) and `DELETE /api/logs` needs no extra auth; WS token travels in the query string (shows in proxy logs).
11. UI: ~12 independent `setInterval` pollers run even when the tab is hidden; pause on `document.hidden` or move to the WS stream. JS bundle is 647 kB (single chunk): lazy-load Backtesting/AlgoBots/charts.
12. CSV export of mirror logs is not protected against formula injection (prefix cells starting with `= + - @`).
13. Dockerfile runs `tsx` in production; fine, but add `engines` to package.json and pin Node 20/22 to match CI.
