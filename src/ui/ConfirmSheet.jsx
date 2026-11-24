import React, { useEffect, useState } from 'react';

/**
 * One confirm step for anything that moves real money (order, cancel, close, start bot, delete account).
 * rows: [[label, value], ...]. Pass typeToConfirm="BUY" to require typing a word first.
 */
export default function ConfirmSheet({ open, title, subtitle, rows = [], warning, typeToConfirm, confirmLabel = 'Confirm and send', live = true, busy = false, onConfirm, onCancel }) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (open) setTyped(''); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  const ready = !typeToConfirm || typed.trim().toUpperCase() === typeToConfirm.toUpperCase();
  return (
    <div className="fixed inset-0 z-[70] grid place-items-end bg-black/60 p-0 sm:place-items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel?.()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`w-full max-w-md rounded-t-2xl border ${live ? 'border-live' : 'border-line'} bg-surface p-6 sm:rounded-2xl`}>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          {live && <span className="rounded-md bg-live px-2 py-0.5 text-[11px] font-bold text-canvas">LIVE</span>}
        </div>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <dl className="mt-4">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between border-t border-line py-2 text-sm">
              <dt className="text-muted">{k}</dt>
              <dd className="font-mono font-semibold text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        {warning && <p className="mt-3 rounded-lg bg-live/10 p-3 text-xs text-live">{warning}</p>}
        {typeToConfirm && (
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Type ${typeToConfirm}`}
            aria-label={`Type ${typeToConfirm} to confirm`}
            className="mt-3 w-full rounded-lg border border-live bg-canvas px-3 py-2.5 font-mono text-sm text-ink"
          />
        )}
        <div className="mt-4 flex gap-2">
          <button onClick={onCancel} className="flex-1 rounded-lg border border-line bg-raised px-4 py-2.5 text-sm font-semibold text-ink">Cancel</button>
          <button disabled={!ready || busy} onClick={onConfirm} className="flex-[2] rounded-lg bg-live px-4 py-2.5 text-sm font-bold text-canvas disabled:opacity-40">
            {busy ? 'Sending…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
