import React, { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, CrosshairMode } from 'lightweight-charts';

const FRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1W', '1M'];
const BINANCE_INTERVAL = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '1d': '1d', '1W': '1w', '1M': '1M' };
const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000,
  '1W': 604_800_000, '1M': 2_592_000_000,
};
const LIMITS = { '1m': 500, '3m': 500, '5m': 500, '15m': 500, '30m': 500, '1h': 500, '2h': 500, '4h': 500, '1d': 500, '1W': 500, '1M': 500 };
const POLL_INTERVAL = 5000;
const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function bucketStart(ts, ms) {
  return Math.floor(ts / ms) * ms;
}

function binanceWsUrl(symbol, interval) {
  const sym = String(symbol).toUpperCase().replace('/', '');
  return `wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@kline_${interval}`;
}

/** TradingView-style live candlestick chart. Connects directly to Binance's kline websocket for the selected interval, with REST polling fallback. */
export default function PriceChart({ symbol, className = '', height = 380 }) {
  const box = useRef(null);
  const [frame, setFrame] = useState('1h');
  const [error, setError] = useState('');
  const [wsStatus, setWsStatus] = useState('connecting');
  const chartRef = useRef(null);
  const candlesRef = useRef(null);
  const volumeRef = useRef(null);
  const bucketRef = useRef(null);
  const wsRef = useRef(null);
  const pollRef = useRef(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    if (!box.current) return undefined;
    aliveRef.current = true;

    const up = css('--c-up', '#35d6a0');
    const down = css('--c-down', '#ff5d73');
    const ink = css('--c-muted', '#8e97a8');
    const grid = css('--c-line', '#232a3a');

    const chart = createChart(box.current, {
      height,
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: ink, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid, scaleMargins: { top: 0.1, bottom: 0.1 } },
      leftPriceScale: { borderColor: grid, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 6, minBarSpacing: 2 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: ink, width: 1, style: 2 }, horzLine: { color: ink, width: 1, style: 2, labelVisible: true } },
      handleScroll: { vertTouchDrag: true },
      handlePinch: { vertTouchDrag: true },
    });
    chart.applyOptions({ localization: { priceFormatter: (price) => price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 }) } });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
      priceFormat: { type: 'price', minMove: 0.000001 },
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.7, bottom: 0 }, borderVisible: false });

    chartRef.current = chart;
    candlesRef.current = candles;
    volumeRef.current = volume;

    let restoreTimer;

    const loadHistory = async () => {
      try {
        const limit = LIMITS[frame] ?? 500;
        const res = await fetch(`/api/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${frame}&limit=${limit}`);
        if (!res.ok) throw new Error('Candles unavailable');
        const rows = await res.json();
        if (!aliveRef.current) return;
        candles.setData(rows.map((k) => ({ time: Math.floor(k.openTime / 1000), open: k.open, high: k.high, low: k.low, close: k.close })));
        volume.setData(rows.map((k) => ({ time: Math.floor(k.openTime / 1000), value: k.volume, color: (k.close >= k.open ? up : down) + '66' })));
        chart.timeScale().fitContent();
        chart.resize();
        setError('');

        const last = rows[rows.length - 1];
        if (last) {
          const ms = INTERVAL_MS[frame] ?? 3_600_000;
          const start = bucketStart(last.openTime, ms);
          bucketRef.current = {
            time: Math.floor(start / 1000),
            open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume,
          };
        }
      } catch (e) {
        if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
      }
    };

    const applyKline = (k) => {
      if (!candlesRef.current || !volumeRef.current) return;
      const time = Math.floor(k.t / 1000);
      const closed = k.x === true;

      if (closed) {
        // Closed candle: append as a new bar
        candlesRef.current.update({ time, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c) });
        volumeRef.current.update({ time, value: parseFloat(k.v), color: (parseFloat(k.c) >= parseFloat(k.o) ? up : down) + '66' });
        bucketRef.current = null; // next tick will start a fresh forming candle
      } else {
        // Forming candle: update in place
        const bucket = bucketRef.current;
        if (!bucket || bucket.time !== time) {
          if (bucket) {
            candlesRef.current.update({ time: bucket.time, open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close });
            volumeRef.current.update({ time: bucket.time, value: bucket.volume, color: (bucket.close >= bucket.open ? up : down) + '66' });
          }
          bucketRef.current = { time, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v) };
          candlesRef.current.update({ time, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c) });
          volumeRef.current.update({ time, value: parseFloat(k.v), color: up + '66' });
        } else {
          bucket.high = Math.max(bucket.high, parseFloat(k.h));
          bucket.low = Math.min(bucket.low, parseFloat(k.l));
          bucket.close = parseFloat(k.c);
          bucket.volume = parseFloat(k.v);
          candlesRef.current.update({ time: bucket.time, open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close });
          volumeRef.current.update({ time: bucket.time, value: bucket.volume, color: (bucket.close >= bucket.open ? up : down) + '66' });
        }
      }
    };

    const connectWs = () => {
      if (wsRef.current) wsRef.current.close();
      const interval = BINANCE_INTERVAL[frame] ?? '1h';
      const ws = new WebSocket(binanceWsUrl(symbol, interval));
      wsRef.current = ws;
      setWsStatus('connecting');
      ws.onopen = () => {
        setWsStatus('live');
        stopPoll();
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.e === 'kline' && msg.k && msg.k.s === String(symbol).toUpperCase()) {
            applyKline(msg.k);
          }
        } catch { /* ignore malformed messages */ }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
          setWsStatus('disconnected');
          startPoll();
        }
        if (aliveRef.current) restoreTimer = setTimeout(connectWs, 3000);
      };
      ws.onerror = () => {
        if (wsRef.current === ws) ws.close();
      };
    };

    const startPoll = () => {
      if (pollRef.current) return;
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${frame}&limit=3`);
          if (!res.ok) return;
          const rows = await res.json();
          if (!aliveRef.current || !rows.length) return;
          const last = rows[rows.length - 1];
          if (!last) return;
          const ms = INTERVAL_MS[frame] ?? 3_600_000;
          const start = bucketStart(last.openTime, ms);
          const time = Math.floor(start / 1000);
          const bucket = bucketRef.current;
          if (!bucket || bucket.time !== time) {
            if (bucket) {
              candlesRef.current.update({ time: bucket.time, open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close });
              volumeRef.current.update({ time: bucket.time, value: bucket.volume, color: (bucket.close >= bucket.open ? up : down) + '66' });
            }
            bucketRef.current = { time, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume };
            candlesRef.current.update({ time, open: last.open, high: last.high, low: last.low, close: last.close });
            volumeRef.current.update({ time, value: last.volume, color: (last.close >= last.open ? up : down) + '66' });
          } else {
            bucket.close = last.close;
            bucket.high = Math.max(bucket.high, last.high);
            bucket.low = Math.min(bucket.low, last.low);
            bucket.volume = last.volume;
            candlesRef.current.update({ time: bucket.time, open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close });
            volumeRef.current.update({ time: bucket.time, value: bucket.volume, color: (bucket.close >= bucket.open ? up : down) + '66' });
          }
        } catch { /* polling failed, retry next tick */ }
      }, POLL_INTERVAL);
    };

    const stopPoll = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const WS_SYMBOL_RE = /^[A-Z0-9]{5,12}$/;

    loadHistory();
    if (WS_SYMBOL_RE.test(String(symbol).toUpperCase().replace('/', ''))) {
      connectWs();
    }

    return () => {
      aliveRef.current = false;
      if (restoreTimer) clearTimeout(restoreTimer);
      stopPoll();
      if (wsRef.current) wsRef.current.close();
      chart.remove();
    };
  }, [symbol, frame, height]);

  return (
    <div className={`rounded-xl border border-line bg-surface ${className}`}>
      <div className="flex flex-wrap items-center gap-1 px-3 py-2">
        {FRAMES.map((f) => (
          <button
            key={f}
            onClick={() => setFrame(f)}
            aria-pressed={frame === f}
            className={`rounded-lg px-2.5 py-1 font-mono text-xs transition ${frame === f ? 'bg-raised text-ink border border-emerald-500/40' : 'text-muted hover:text-ink border-transparent hover:border-border/40 border border-border/40'}`}
          >
            {f}
          </button>
        ))}
        <span className={`ml-auto text-xs font-mono ${wsStatus === 'live' ? 'text-emerald-400' : wsStatus === 'connecting' ? 'text-amber-400' : 'text-live'}`}>
          {wsStatus === 'live' ? '● live (binance ws)' : wsStatus === 'connecting' ? '○ connecting…' : '● poll fallback'}
        </span>
        {error && <span className="ml-2 text-xs text-live">{error}</span>}
      </div>
      <div ref={box} style={{ height }} role="img" aria-label={`${symbol} live candlestick chart`} />
    </div>
  );
}
