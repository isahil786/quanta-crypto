import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import ConfirmSheet from './ConfirmSheet.jsx';

const ConfirmContext = createContext(async () => true);

/**
 * Promise-based confirm for money-moving or destructive actions:
 *   if (!(await confirm({ title: 'Close position?', rows: [['Pair','BTCUSDT']] }))) return;
 */
export function ConfirmProvider({ children }) {
  const [opts, setOpts] = useState(null);
  const resolver = useRef(null);
  const confirm = useCallback((o) => new Promise((resolve) => { resolver.current = resolve; setOpts(o); }), []);
  const settle = (v) => { resolver.current?.(v); resolver.current = null; setOpts(null); };
  const api = useMemo(() => confirm, [confirm]);
  return (
    <ConfirmContext.Provider value={api}>
      {children}
      <ConfirmSheet
        open={!!opts}
        {...(opts || {})}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
