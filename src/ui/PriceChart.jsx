import React, { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, CrosshairMode } from 'lightweight-charts';

const FRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1W', '1M'];
const BINANCE_INTERVAL = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '1d': '1d', '1W': '1w', '1M': '1M' };
const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000,
  '1W': 604_800_000, '1M': null, // months have no fixed length: the next candle comes from the server
};
const HISTORY = 500;
const SYNC_MS = 2000;      // re-sync the forming candle (volume, true OHLC) from the server
const STALE_AFTER_MS = 8000;
const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * Live candlestick chart.
 *  - History and a 2s re-sync come from our own server (/api/market/klines), which works where Binance is blocked.
 *  - Between syncs the forming candle follows `livePrice`, the tick stream the app already receives over its websocket,
 *    so the last candle moves in real time.
 */
export default function PriceChart({ symbol, livePrice, className = '', height = 380 }) {
  const box = useRef(null);
  const [frame, setFrame] = useState('1h');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('connecting'); // connecting | live | stale
  const candlesRef = useRef(null);
  const volumeRef = useRef(null);
  const lastRef = useRef(null);      // the forming candle { time, open, high, low, close, volume }
  const lastOkRef = useRef(0);
  const colorsRef = useRef({ up: '#35d6a0', down: '#ff5d73' });

  const paint = (bar) => {
    const { up, down } = colorsRef.current;
    candlesRef.current?.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    volumeRef.current?.update({ time: bar.time, value: bar.volume ?? 0, color: (bar.close >= bar.open ? up : down) + '66' });
  };

  useEffect(() => {
    if (!box.current) return undefined;
    let alive = true;
    lastRef.current = null;
    setStatus('connecting');

    const up = css('--c-up', '#35d6a0');
    const down = css('--c-down', '#ff5d73');
    const ink = css('--c-muted', '#8e97a8');
    const grid = css('--c-line', '#232a3a');
    colorsRef.current = { up, down };

    const chart = createChart(box.current, {
      height,
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: ink, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 6, minBarSpacing: 2 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: ink, width: 1, style: 2 }, horzLine: { color: ink, width: 1, style: 2, labelVisible: true } },
    });
    chart.applyOptions({ localization: { priceFormatter: (price) => price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 }) } });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
      priceFormat: { type: 'price', minMove: 0.000001 },
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.7, bottom: 0 }, borderVisible: false });
    candlesRef.current = candles;
    volumeRef.current = volume;

    const fetchKlines = async (limit) => {
      const res = await fetch(`/api/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${BINANCE_INTERVAL[frame]}&limit=${limit}`);
      if (!res.ok) throw new Error('Candles unavailable');
      const rows = await res.json();
      return rows.map((k) => ({ time: Math.floor(k.openTime / 1000), open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
    };
    const markOk = () => { lastOkRef.current = Date.now(); setStatus((s) => (s === 'live' ? s : 'live')); setError(''); };

    const loadHistory = async () => {
      try {
        const bars = await fetchKlines(HISTORY);
        if (!alive || !bars.length) return;
        candles.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
        volume.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: (b.close >= b.open ? up : down) + '66' })));
        chart.timeScale().fitContent();
        lastRef.current = { ...bars[bars.length - 1] };
        markOk();
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };

    // Re-sync the last two candles from the server (never touches older bars, so it cannot rewind the series)
    const sync = async () => {
      if (document.hidden || !lastRef.current) return;
      try {
        const bars = await fetchKlines(10);
        if (!alive) return;
        for (const bar of bars.slice(-2)) {
          if (bar.time < lastRef.current.time) continue;
          paint(bar);
          if (bar.time >= lastRef.current.time) lastRef.current = { ...bar };
        }
        markOk();
      } catch { /* keep the previous candle; the status turns stale if this keeps failing */ }
    };

    loadHistory();
    const syncTimer = setInterval(sync, SYNC_MS);
    const staleTimer = setInterval(() => {
      if (lastOkRef.current && Date.now() - lastOkRef.current > STALE_AFTER_MS) setStatus((s) => (s === 'stale' ? s : 'stale'));
    }, 2000);

    return () => {
      alive = false;
      clearInterval(syncTimer);
      clearInterval(staleTimer);
      candlesRef.current = null;
      volumeRef.current = null;
      chart.remove();
    };
  }, [symbol, frame, height]);

  // Real-time tick: move the forming candle with the latest price
  useEffect(() => {
    const price = Number(livePrice);
    const bar = lastRef.current;
    if (!bar || !Number.isFinite(price) || price <= 0) return;
    const ms = INTERVAL_MS[frame];
    const now = Date.now();
    if (ms && now >= bar.time * 1000 + ms) {
      // A new period has started: open the next candle at this price (the server confirms it on the next sync)
      const periods = Math.floor((now - bar.time * 1000) / ms);
      const time = bar.time + (periods * ms) / 1000;
      lastRef.current = { time, open: price, high: price, low: price, close: price, volume: 0 };
    } else {
      bar.close = price;
      bar.high = Math.max(bar.high, price);
      bar.low = Math.min(bar.low, price);
    }
    paint(lastRef.current);
    lastOkRef.current = now;
    setStatus((s) => (s === 'live' ? s : 'live'));
  }, [livePrice, frame]);

  return (
    <div className={`rounded-xl border border-line bg-surface ${className}`}>
      <div className="flex flex-wrap items-center gap-1 px-3 py-2">
        {FRAMES.map((f) => (
          <button
            key={f}
            onClick={() => setFrame(f)}
            aria-pressed={frame === f}
            className={`rounded-lg px-2.5 py-1 font-mono text-xs transition ${frame === f ? 'bg-raised text-ink border border-emerald-500/40' : 'text-muted hover:text-ink border border-border/40'}`}
          >
            {f}
          </button>
        ))}
        <span className={`ml-auto text-xs font-mono ${status === 'live' ? 'text-emerald-400' : status === 'connecting' ? 'text-amber-400' : 'text-live'}`} role="status">
          {status === 'live' ? '● live' : status === 'connecting' ? '○ loading…' : '● stale, retrying'}
        </span>
        {error && <span className="ml-2 text-xs text-live">{error}</span>}
      </div>
      <div ref={box} style={{ height }} role="img" aria-label={`${symbol} live candlestick chart`} />
    </div>
  );
}
