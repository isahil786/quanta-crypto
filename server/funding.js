// Perpetual-futures funding for the paper engine.
// Every 8 hours (00:00, 08:00, 16:00 UTC) each open futures position pays or receives
// size * mark price * funding rate. Positive rate: longs pay shorts.
import { accounts, positions, fundingLog } from './state.js';
import { uid, capList } from './util.js';

export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const MAX_CATCH_UP_INTERVALS = 3; // after a long outage, don't charge a week of funding at once
export const fundingBoundary = (t) => Math.floor(t / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
export const defaultFundingRate = () => (Number.isFinite(Number(process.env.FUNDING_DEFAULT_RATE)) && process.env.FUNDING_DEFAULT_RATE !== undefined && process.env.FUNDING_DEFAULT_RATE !== '' ? Number(process.env.FUNDING_DEFAULT_RATE) : 0.0001);

/** True when some futures position has a funding boundary behind it (cheap check before fetching rates). */
export function fundingDue(now = Date.now()) {
  const b = fundingBoundary(now);
  return positions.some((p) => accounts.find((a) => a.id === p.accountId)?.segment === 'FUTURES' && (p.fundingSettledAt ?? b) < b);
}

/**
 * Settle funding for every position that has crossed a boundary since it was last settled.
 * `rateFor(symbol)` returns the per-interval rate as a fraction (0.0001 = 0.01%).
 * `markFor(symbol)` returns the mark price (falls back to the position's last mark).
 */
export function settleFunding({ now = Date.now(), rateFor, markFor }) {
  const boundary = fundingBoundary(now);
  const events = [];
  for (const pos of positions) {
    const account = accounts.find((a) => a.id === pos.accountId);
    if (!account || account.segment !== 'FUTURES') continue;
    if (pos.fundingSettledAt === undefined) { pos.fundingSettledAt = boundary; pos.fundingPaidUSDT = pos.fundingPaidUSDT || 0; continue; } // no retroactive charge
    if (pos.fundingSettledAt >= boundary) continue;
    const intervals = Math.min(Math.round((boundary - pos.fundingSettledAt) / FUNDING_INTERVAL_MS), MAX_CATCH_UP_INTERVALS);
    pos.fundingSettledAt = boundary;
    const rate = rateFor ? rateFor(pos.symbol) : defaultFundingRate();
    const mark = (markFor && markFor(pos.symbol)) || pos.markPrice || pos.entryPrice;
    const payment = Number((pos.size * mark * rate * (pos.side === 'LONG' ? 1 : -1) * intervals).toFixed(6)); // + = account pays
    account.availableMarginUSDT = Number((account.availableMarginUSDT - payment).toFixed(6));
    account.totalEquityUSDT = Number((account.totalEquityUSDT - payment).toFixed(6));
    if (account.availableMarginUSDT < 0) { // wallet empty: funding eats the position's own margin
      const take = Math.min(-account.availableMarginUSDT, pos.margin);
      pos.margin = Number((pos.margin - take).toFixed(8));
      account.availableMarginUSDT = Number((account.availableMarginUSDT + take).toFixed(6));
    }
    pos.fundingPaidUSDT = Number(((pos.fundingPaidUSDT || 0) + payment).toFixed(6));
    const evt = { id: uid('fund'), timestamp: new Date(now).toISOString(), accountId: account.id, positionId: pos.id, symbol: pos.symbol, side: pos.side, size: pos.size, markPrice: mark, rate, intervals, paymentUSDT: payment };
    fundingLog.unshift(evt);
    events.push(evt);
  }
  capList(fundingLog, 2000);
  return events;
}
