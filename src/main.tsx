import {createRoot} from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import { ToastProvider } from './ui/Toast.jsx';
import { ConfirmProvider } from './ui/Confirm.jsx';
import './index.css';

// If the server runs with API_TOKEN, set it once in the browser console:
//   localStorage.setItem('apiToken', '<token>')
// and every same-origin /api request will carry it. The token is read per request, so setting it
// does not need a reload.
const origFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const token = localStorage.getItem('apiToken');
    // Only our own API: never leak the token to another origin
    if (token && url.origin === window.location.origin && url.pathname.startsWith('/api')) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('Authorization', `Bearer ${token}`);
      return origFetch(input, { ...init, headers });
    }
  } catch {
    /* storage unavailable or unparsable URL: send the request unchanged */
  }
  return origFetch(input, init);
};

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </ErrorBoundary>
);
