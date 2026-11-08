import {createRoot} from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import './index.css';

// If the server runs with API_TOKEN, set it once in the browser console:
//   localStorage.setItem('apiToken', '<token>')
// and every /api request will carry it.
try {
  const token = localStorage.getItem('apiToken');
  if (token) {
    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.startsWith('/api')) {
        const headers = new Headers(init.headers || {});
        headers.set('Authorization', `Bearer ${token}`);
        init = { ...init, headers };
      }
      return origFetch(input, init);
    };
  }
} catch {
  /* storage unavailable */
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
