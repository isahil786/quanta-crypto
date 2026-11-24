import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ToastContext = createContext({ toast: () => {} });
const TONE = { success: 'border-l-up', error: 'border-l-down', warn: 'border-l-live', info: 'border-l-accent' };

/** Order results and alerts appear bottom-right and fade, instead of pushing page content down. */
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const dismiss = useCallback((id) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback((tone, title, detail, ms = 6000) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setItems((xs) => [...xs.slice(-3), { id, tone, title, detail }]);
    if (ms) setTimeout(() => dismiss(id), ms);
  }, [dismiss]);
  const api = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-20 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 md:bottom-12">
        {items.map((t) => (
          <div key={t.id} className={`pointer-events-auto flex items-start gap-3 rounded-xl border border-line border-l-4 bg-raised p-3 shadow-lg ${TONE[t.tone] || TONE.info}`}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-ink">{t.title}</div>
              {t.detail && <div className="mt-0.5 break-words font-mono text-xs text-muted">{t.detail}</div>}
            </div>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="text-muted hover:text-ink">×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext).toast;
