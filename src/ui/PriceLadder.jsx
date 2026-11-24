import React, { useEffect, useRef, useState } from 'react';

const PRESETS_USD = [100, 500, 1000, 5000];
const fmtPx = (p, prec) => (p < 0.01 ? p.toFixed(6) : p.toLocaleString(undefined, { minimumFractionDigits: prec, maximumFractionDigits: prec }));

/**
 * Click ladder. Guards, all of them on by default:
 *  - Nothing happens until you press Arm. Armed state is shown in the live colour and clears when you
 *    switch pair or account, press Esc, or leave the screen.
 *  - Clicking only requests an order. On live accounts the parent always opens the confirm sheet first.
 *  - Sizes are fixed dollar presets (keys 1-4), so a click never needs typing.
 *  - Click bid = buy limit, click ask = sell limit, Ctrl/Cmd-click = market. B / S = market buy / sell at the chosen size.
 */
export default function PriceLadder({ depth, price, precision = 2, isLive = false, onOrder, className = '' }) {
  const [armed, setArmed] = useState(false);
  const [presetIdx, setPresetIdx] = useState(1);
  const armedRef = useRef(false);
  armedRef.current = armed;
  const priceRef = useRef(price);
  priceRef.current = price;

  const sizeFor = (px) => {
    const raw = PRESETS_USD[presetIdx] / px;
    return Number(raw.toFixed(raw < 1 ? 5 : 2));
  };
  const send = (side, orderType, px) => {
    if (!armedRef.current || !px) return;
    onOrder({ side, orderType, price: px, size: sizeFor(orderType === 'MARKET' ? priceRef.current : px) });
  };

  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (e.key === 'Escape') { setArmed(false); return; }
      if (!armedRef.current || e.metaKey || e.ctrlKey || e.altKey) return;
      if (['1', '2', '3', '4'].includes(e.key)) { setPresetIdx(Number(e.key) - 1); return; }
      const k = e.key.toLowerCase();
      if (k === 'b') send('BUY', 'MARKET', priceRef.current);
      if (k === 's') send('SELL', 'MARKET', priceRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetIdx]);

  const asks = (depth.asks || []).slice(0, 6).slice().reverse();
  const bids = (depth.bids || []).slice(0, 6);
  const maxQty = Math.max(1e-9, ...asks.map((a) => a.size), ...bids.map((b) => b.size));
  const armTone = isLive ? 'bg-live text-canvas' : 'bg-paper text-canvas';

  const row = (lvl, ask) => {
    const w = `${Math.min((lvl.size / maxQty) * 100, 100)}%`;
    const cell = (active, label) => (
      <button
        type="button"
        disabled={!armed}
        onClick={(e) => send(ask ? 'SELL' : 'BUY', e.ctrlKey || e.metaKey ? 'MARKET' : 'LIMIT', lvl.price)}
        aria-label={`${ask ? 'Sell' : 'Buy'} limit at ${lvl.price}`}
        className={`relative h-7 text-xs ${active ? (armed ? 'cursor-pointer hover:ring-1 hover:ring-accent' : 'cursor-not-allowed') : 'pointer-events-none'} rounded`}
      >
        {active && <span aria-hidden className={`absolute inset-y-0 ${ask ? 'right-0 bg-down/15' : 'left-0 bg-up/15'} rounded`} style={{ width: w }} />}
        {active && <span className={`relative px-2 ${ask ? 'text-down' : 'text-up'}`}>{label}</span>}
      </button>
    );
    return (
      <div key={`${ask ? 'a' : 'b'}-${lvl.price}`} className="grid grid-cols-[1fr_7rem_1fr] items-center font-mono tabular-nums">
        {cell(!ask, lvl.size.toFixed(4))}
        <span className="text-center text-xs text-ink">{fmtPx(lvl.price, precision)}</span>
        {cell(ask, lvl.size.toFixed(4))}
      </div>
    );
  };

  return (
    <section className={`rounded-xl border bg-surface p-4 ${armed ? (isLive ? 'border-live' : 'border-paper') : 'border-line'} ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">Click ladder</h2>
        <div role="group" aria-label="Size presets" className="flex gap-1">
          {PRESETS_USD.map((v, i) => (
            <button key={v} type="button" aria-pressed={presetIdx === i} onClick={() => setPresetIdx(i)} className={`rounded-lg px-2.5 py-1 font-mono text-xs ${presetIdx === i ? 'bg-raised text-ink ring-1 ring-accent' : 'text-muted hover:text-ink'}`}>
              {i + 1} · ${v}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setArmed((a) => !a)}
          aria-pressed={armed}
          className={`ml-auto rounded-lg px-3 py-1.5 text-xs font-bold ${armed ? armTone : 'border border-line bg-raised text-ink'}`}
        >
          {armed ? `ARMED · ${isLive ? 'LIVE' : 'PAPER'} (Esc)` : 'Arm ladder'}
        </button>
      </div>
      <div className="mt-3 flex flex-col gap-0.5">
        <div className="grid grid-cols-[1fr_7rem_1fr] text-[11px] text-muted"><span className="px-2">Bid size</span><span className="text-center">Price</span><span className="px-2 text-right">Ask size</span></div>
        {asks.map((l) => row(l, true))}
        <div className="my-1 h-px bg-accent" aria-hidden />
        {bids.map((l) => row(l, false))}
      </div>
      <p className="mt-3 text-xs text-muted">
        {armed
          ? `Click a bid to buy, an ask to sell (limit). Ctrl-click for market. B or S for market at $${PRESETS_USD[presetIdx]}.${isLive ? ' Live orders still open a confirm sheet.' : ''}`
          : 'Press Arm to enable clicks and hotkeys. Nothing is sent while the ladder is disarmed.'}
      </p>
    </section>
  );
}
