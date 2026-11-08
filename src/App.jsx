import React, { useState, useEffect } from 'react';
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

  // Fetch accounts on load
  const loadAccounts = async () => {
    try {
      const res = await fetch('/api/accounts');
      if (res.ok) {
        const data = await res.json();
        setAccounts(data);
        if (data.length > 0 && !activeAccountId) {
          setActiveAccountId(data[0].id);
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
      if (res.ok) {
        const data = await res.json();
        setTickers(data);
        if (data.length > 0 && !selectedSymbol) {
          setSelectedSymbol(data[0].symbol);
        }
      }
    } catch (err) {
      console.error('Failed to load tickers', err);
    }
  };

  useEffect(() => {
    loadAccounts();
    loadTickers();
    const interval = setInterval(loadTickers, 3000);
    return () => clearInterval(interval);
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
          key={orderRefreshCount}
          accounts={accounts}
          activeAccountId={activeAccountId}
        />
      )}

      {activeTab === 'positions' && (
        <Positions
          key={orderRefreshCount}
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
