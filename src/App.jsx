import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import RiskCockpit from './components/RiskCockpit.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './components/Dashboard.jsx';
// Everything except the landing tab is split into its own chunk and loaded on first visit
const Trades = lazy(() => import('./components/Trades.jsx'));
const Positions = lazy(() => import('./components/Positions.jsx'));
const MirrorTrading = lazy(() => import('./components/MirrorTrading.jsx'));
const Accounts = lazy(() => import('./components/Accounts.jsx'));
const Screener = lazy(() => import('./components/Screener.jsx'));
const TestApi = lazy(() => import('./components/TestApi.jsx'));
const AlgoBots = lazy(() => import('./components/AlgoBots.jsx'));
const Backtesting = lazy(() => import('./components/Backtesting.jsx'));
const PnLDashboard = lazy(() => import('./components/PnLDashboard.jsx'));

/** setState that keeps the old reference when the new data is identical, so polling does not re-render the whole tree. */
function useStableState(initial) {
  const [value, setValue] = useState(initial);
  const set = useCallback((next) => {
    setValue((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);
  return [value, set];
}

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [accounts, setAccounts] = useStableState([]);
  const [holdings, setHoldings] = useStableState([]);
  const [activeAccountId, setActiveAccountId] = useState('');
  const [tickers, setTickers] = useState([]);
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT');
  const [candles, setCandles] = useState({});
  const [, setOrderRefreshCount] = useState(0);
  const [feedOk, setFeedOk] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [, setWsError] = useState(null);

  const wsUrl = useRef(null);
  const symbolsRef = useRef([]);

  // Keep latest symbols in a ref so connectWebSocket doesn't need tickers as a dep
  useEffect(() => {
    symbolsRef.current = tickers.map((t) => t.symbol);
  }, [tickers]);

  // Build WebSocket URL from current host (same server as HTTP API). The API token is sent as a
  // subprotocol (see getWsProtocols), never in the URL, so it can't end up in proxy/access logs.
  const getWsUrl = useCallback(() => {
    const { protocol, host } = window.location;
    const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${host}/ws`;
  }, []);

  const getWsProtocols = useCallback(() => {
    let token = '';
    try { token = localStorage.getItem('apiToken') || ''; } catch { /* storage unavailable */ }
    if (!token) return undefined;
    // Subprotocol values must be HTTP token chars, so base64url-encode the (UTF-8) token.
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(token))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return ['quanta.v1', `auth.${b64}`];
  }, []);

  // Merge WebSocket ticker updates into the tickers list. Updates (dozens per second across symbols) are buffered
  // and applied in one batch every 400ms, so the tree re-renders a couple of times per second instead of per message.
  const pendingTicks = useRef(new Map());
  const flushTimer = useRef(null);
  const flushTicks = useCallback(() => {
    flushTimer.current = null;
    const batch = pendingTicks.current;
    if (batch.size === 0) return;
    pendingTicks.current = new Map();
    setTickers((prev) => {
      const next = [...prev];
      const index = new Map(next.map((t, i) => [t.symbol, i]));
      for (const update of batch.values()) {
        const idx = index.get(update.symbol);
        if (idx !== undefined) {
          const cur = next[idx];
          next[idx] = {
            ...cur,
            price: update.price,
            change24h: update.change24h ?? cur.change24h,
            high24h: update.high24h ?? cur.high24h,
            low24h: update.low24h ?? cur.low24h,
            volume: update.volume ?? cur.volume,
            quoteVolume: update.quoteVolume ?? cur.quoteVolume,
            bidPrice: update.bidPrice ?? cur.bidPrice,
            askPrice: update.askPrice ?? cur.askPrice,
            lastUpdate: update.timestamp,
            source: 'ws',
          };
        } else {
          index.set(update.symbol, next.length);
          next.push({ ...update, base: update.symbol.replace(/USDT$/, ''), precision: update.price >= 1000 ? 2 : update.price >= 1 ? 4 : 6, source: 'ws', momentumRank: next.length + 1 });
        }
      }
      return next;
    });
  }, []);
  const applyTickerUpdate = useCallback((update) => {
    pendingTicks.current.set(update.symbol, update);
    if (!flushTimer.current) flushTimer.current = setTimeout(flushTicks, 400);
  }, [flushTicks]);
  useEffect(() => () => { if (flushTimer.current) clearTimeout(flushTimer.current); }, []);

  // Connect to WebSocket and subscribe to all current tickers
  const connectWebSocket = useCallback(() => {
    if (wsUrl.current) {
      wsUrl.current.close();
    }
    const url = getWsUrl();
    const ws = new WebSocket(url, getWsProtocols());
    wsUrl.current = ws;
    // The server streams at most 50 symbols; REST polling covers the rest
    const currentSymbols = symbolsRef.current.slice(0, 50);

    ws.onopen = () => {
      setWsConnected(true);
      setWsError(null);
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN && currentSymbols.length > 0) {
          ws.send(JSON.stringify({
            type: 'subscribe_batch',
            symbols: currentSymbols,
          }));
        }
      }, 50);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'snapshot') {
          // An empty snapshot (server cache not warm yet) must not wipe tickers already loaded over REST
          if (Array.isArray(msg.data) && msg.data.length > 0) {
            setTickers(msg.data);
            setFeedOk(true);
          }
        } else if (msg.type === 'ticker') {
          applyTickerUpdate(msg.data);
          setFeedOk(true);
        } else if (msg.type === 'candle') {
          setCandles((prev) => {
            const next = { ...prev };
            if (msg.data && msg.data.symbol) {
              next[msg.data.symbol] = msg.data;
            }
            return next;
          });
          setFeedOk(true);
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      // A replaced socket closing late must not clear the reference to its successor
      if (wsUrl.current === ws) {
        setWsConnected(false);
        wsUrl.current = null;
      }
    };

    ws.onerror = () => {
      if (wsUrl.current !== ws) return;
      setWsError('WebSocket connection failed');
      setWsConnected(false);
    };
  }, [getWsUrl, getWsProtocols, applyTickerUpdate]);

  // Make sure the server streams the symbol on screen even if it is not among the first 50 tickers
  useEffect(() => {
    const ws = wsUrl.current;
    const activeAccount = accounts.find((a) => a.id === activeAccountId);
    const isCsSpot = activeAccount?.broker === 'coinswitch' && activeAccount?.segment === 'SPOT';
    if (wsConnected && ws && ws.readyState === WebSocket.OPEN && selectedSymbol) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol: selectedSymbol }));
      if (isCsSpot) {
        ws.send(JSON.stringify({ type: 'subscribe_candle', symbol: selectedSymbol }));
      }
    }
  }, [selectedSymbol, wsConnected, accounts, activeAccountId]);

  // Maintain WebSocket connection with retry
  useEffect(() => {
    connectWebSocket();
    const retryTimer = setInterval(() => {
      if (!wsUrl.current || wsUrl.current.readyState === WebSocket.CLOSED) {
        connectWebSocket();
      }
    }, 5000);
    return () => {
      clearInterval(retryTimer);
      if (wsUrl.current) wsUrl.current.close();
    };
  }, [connectWebSocket]);

  // Fetch accounts on load and refresh periodically
  const loadAccounts = async () => {
    try {
      const res = await fetch('/api/accounts');
      if (res.ok) {
        const data = await res.json();
        setAccounts(data);
        if (data.length > 0) {
          setActiveAccountId((cur) => (cur && data.some((a) => a.id === cur) ? cur : data[0].id));
        }
      }
    } catch (err) {
      console.error('Failed to load accounts', err);
    }
  };

  const loadHoldings = async () => {
    try {
      const res = await fetch('/api/holdings');
      if (res.ok) {
        const data = await res.json();
        setHoldings(Array.isArray(data) ? data : data.holdings || []);
      }
    } catch (err) {
      console.error('Failed to load holdings', err);
    }
  };

  // Fetch tickers on interval
  const loadTickers = async () => {
    try {
      const res = await fetch('/api/market/tickers');
      setFeedOk(res.ok);
      if (res.ok) {
        const data = await res.json();
        // REST data is a few seconds old: never let it overwrite a fresher price the websocket already delivered
        // (that made prices jump back and forth and flash on every poll).
        setTickers((prev) => {
          const live = new Map(prev.map((t) => [t.symbol, t]));
          return data.map((t) => {
            const w = live.get(t.symbol);
            return w && w.source === 'ws' && Number(w.lastUpdate) > Number(t.lastUpdate || 0) ? { ...t, price: w.price, lastUpdate: w.lastUpdate, source: 'ws' } : t;
          });
        });
        if (data.length > 0 && !selectedSymbol) {
          setSelectedSymbol(data[0].symbol);
        }
      }
    } catch (err) {
      setFeedOk(false);
      console.error('Failed to load tickers', err);
    }
  };

  useEffect(() => {
    let isMounted = true;
    loadAccounts();
    loadHoldings();
    loadTickers();
    const interval = setInterval(() => {
      if (!isMounted || document.hidden) return;
      loadTickers();
      loadAccounts();
      loadHoldings();
    }, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleOrderPlaced = () => {
    setOrderRefreshCount((c) => c + 1);
  };

  const handleSelectPairFromScreener = (symbol) => {
    setSelectedSymbol(symbol);
    setActiveTab('dashboard');
  };

  return (
      <Layout
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        accounts={accounts}
        activeAccountId={activeAccountId}
        setActiveAccountId={setActiveAccountId}
        feedOk={feedOk}
        wsConnected={wsConnected}
        tickers={tickers}
        onSelectPair={setSelectedSymbol}
      >
      {activeTab === 'dashboard' && (
        <Dashboard
          accounts={accounts}
          activeAccountId={activeAccountId}
          tickers={tickers}
          selectedSymbol={selectedSymbol}
          candles={candles}
          setSelectedSymbol={setSelectedSymbol}
          onOrderPlaced={handleOrderPlaced}
        />
      )}

      <Suspense fallback={<div className="p-6 text-sm text-muted" role="status">Loading…</div>}>
      {activeTab === 'risk' && <RiskCockpit accounts={accounts} />}

      {activeTab === 'bots' && (
        <AlgoBots
          accounts={accounts}
          tickers={tickers}
        />
      )}

      {activeTab === 'backtest' && (
        <Backtesting
          tickers={tickers}
          onDeployToLiveBot={() => setActiveTab('bots')}
        />
      )}

      {activeTab === 'trades' && (
        <Trades
          accounts={accounts}
          activeAccountId={activeAccountId}
        />
      )}

      {activeTab === 'positions' && (
        <Positions
          accounts={accounts}
          activeAccountId={activeAccountId}
        />
      )}

      {activeTab === 'mirror' && (
        <MirrorTrading
          accounts={accounts}
        />
      )}

      {activeTab === 'pnl' && (
        <PnLDashboard
          accounts={accounts}
          activeAccountId={activeAccountId}
        />
      )}

      {activeTab === 'accounts' && (
        <Accounts
          accounts={accounts}
          holdings={holdings}
          onAccountsUpdated={loadAccounts}
          activeAccountId={activeAccountId}
          setActiveAccountId={setActiveAccountId}
        />
      )}

      {activeTab === 'screener' && (
        <Screener
          tickers={tickers}
          onSelectPair={handleSelectPairFromScreener}
        />
      )}

      {activeTab === 'test-api' && (
        <TestApi />
      )}
      </Suspense>
    </Layout>
  );
}
