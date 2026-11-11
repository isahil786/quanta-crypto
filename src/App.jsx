import React, { useState, useEffect, useRef, useCallback } from 'react';
import Layout from './components/Layout.jsx';
import Dashboard from './components/Dashboard.jsx';
import Trades from './components/Trades.jsx';
import Positions from './components/Positions.jsx';
import GttRules from './components/GttRules.jsx';
import MirrorTrading from './components/MirrorTrading.jsx';
import Accounts from './components/Accounts.jsx';
import Screener from './components/Screener.jsx';
import TestApi from './components/TestApi.jsx';
import AlgoBots from './components/AlgoBots.jsx';
import Backtesting from './components/Backtesting.jsx';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [accounts, setAccounts] = useState([]);
  const [activeAccountId, setActiveAccountId] = useState('');
  const [tickers, setTickers] = useState([]);
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT');
  const [orderRefreshCount, setOrderRefreshCount] = useState(0);
  const [feedOk, setFeedOk] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsError, setWsError] = useState(null);

  const wsUrl = useRef(null);
  const symbolsRef = useRef([]);

  // Keep latest symbols in a ref so connectWebSocket doesn't need tickers as a dep
  useEffect(() => {
    symbolsRef.current = tickers.map((t) => t.symbol);
  }, [tickers]);

  // Build WebSocket URL from current host (same server as HTTP API)
  const getWsUrl = useCallback(() => {
    const { protocol, host } = window.location;
    const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${host}/ws`;
  }, []);

  // Merge a WebSocket ticker update into the tickers list
  const applyTickerUpdate = useCallback((update) => {
    setTickers((prev) => {
      const idx = prev.findIndex((t) => t.symbol === update.symbol);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          price: update.price,
          change24h: update.change24h ?? next[idx].change24h,
          high24h: update.high24h ?? next[idx].high24h,
          low24h: update.low24h ?? next[idx].low24h,
          volume: update.volume ?? next[idx].volume,
          quoteVolume: update.quoteVolume ?? next[idx].quoteVolume,
          bidPrice: update.bidPrice ?? next[idx].bidPrice,
          askPrice: update.askPrice ?? next[idx].askPrice,
          lastUpdate: update.timestamp,
          source: 'ws',
        };
        return next;
      }
      return [...prev, { ...update, source: 'ws', momentumRank: prev.length + 1 }];
    });
  }, []);

  // Connect to WebSocket and subscribe to all current tickers
  const connectWebSocket = useCallback(() => {
    if (wsUrl.current) {
      wsUrl.current.close();
    }
    const url = getWsUrl();
    const ws = new WebSocket(url);
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
  }, [getWsUrl, applyTickerUpdate]);

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
        // Functional update: the polling interval holds a stale closure, so reading
        // activeAccountId directly here used to reset the user's selection every 3s.
        if (data.length > 0) {
          setActiveAccountId((cur) => (cur && data.some((a) => a.id === cur) ? cur : data[0].id));
        }
      }
    } catch (err) {
      console.error('Failed to load accounts', err);
    }
  };

  // Fetch tickers on interval
  const loadTickers = async () => {
    try {
      const res = await fetch('/api/market/tickers');
      setFeedOk(res.ok);
      if (res.ok) {
        const data = await res.json();
        setTickers(data);
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
    loadTickers();
    const interval = setInterval(() => {
      if (!isMounted || document.hidden) return; // don't poll from background tabs
      loadTickers();
      loadAccounts();
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
      >
      {activeTab === 'dashboard' && (
        <Dashboard
          accounts={accounts}
          activeAccountId={activeAccountId}
          tickers={tickers}
          selectedSymbol={selectedSymbol}
          setSelectedSymbol={setSelectedSymbol}
          onOrderPlaced={handleOrderPlaced}
        />
      )}

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

      {activeTab === 'gtt' && (
        <GttRules
          accounts={accounts}
          activeAccountId={activeAccountId}
        />
      )}

      {activeTab === 'mirror' && (
        <MirrorTrading
          accounts={accounts}
        />
      )}

      {activeTab === 'accounts' && (
        <Accounts
          accounts={accounts}
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
    </Layout>
  );
}
