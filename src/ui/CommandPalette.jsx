import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * ⌘K / Ctrl+K palette: jump to a page or a pair, or run a safe action.
 * It never places or cancels orders; anything that moves money stays on its own screen with its confirm sheet.
 * Also supports "G then T/P/O" shortcuts to go to Terminal, Positions or Orders.
 */
export default function CommandPalette({ pages, tickers = [], extraActions = [], onGoPage, onSelectPair }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  const gPressed = useRef(0);

  useEffect(() => {
    const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setQ('');
        setIdx(0);
        return;
      }
      if (e.key === 'Escape') { setOpen(false); return; }
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'g') { gPressed.current = Date.now(); return; }
      if (Date.now() - gPressed.current < 1200) {
        const map = { t: 'dashboard', p: 'positions', o: 'trades' };
        if (map[k]) { gPressed.current = 0; onGoPage(map[k]); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onGoPage]);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (s) => !needle || s.toLowerCase().includes(needle);
    const pairs = tickers.filter((t) => hit(t.symbol)).slice(0, needle ? 8 : 4).map((t) => ({
      id: `pair-${t.symbol}`, label: t.symbol,
      hint: `$${t.price < 0.01 ? Number(t.price).toFixed(6) : Number(t.price).toLocaleString()}  ${t.change24h >= 0 ? '▲ +' : '▼ '}${t.change24h}%`,
      run: () => onSelectPair(t.symbol),
    }));
    const pgs = pages.filter((p) => hit(p.label)).map((p) => ({ id: `page-${p.id}`, label: p.label, hint: p.shortcut || '', run: () => onGoPage(p.id) }));
    const acts = extraActions.filter((a) => hit(a.label)).map((a) => ({ id: `act-${a.label}`, ...a }));
    return [['Pairs', pairs], ['Pages', pgs], ['Actions', acts]].filter(([, items]) => items.length);
  }, [q, tickers, pages, extraActions, onGoPage, onSelectPair]);

  const flat = groups.flatMap(([, items]) => items);
  const run = (item) => { setOpen(false); item?.run(); };

  const onInputKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, flat.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); run(flat[idx]); }
  };

  if (!open) return null;
  let n = -1;
  return (
    <div className="fixed inset-0 z-[80] grid place-items-start bg-black/55 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="mx-auto w-full max-w-xl overflow-hidden rounded-2xl border border-accent bg-surface shadow-2xl">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={onInputKey}
          placeholder="Search pairs, pages and actions"
          aria-label="Search"
          className="w-full border-b border-line bg-transparent px-5 py-4 font-mono text-base text-ink placeholder:text-muted"
        />
        <div className="max-h-[50vh] overflow-y-auto p-2" role="listbox">
          {flat.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted">No matches.</div>}
          {groups.map(([title, items]) => (
            <div key={title}>
              <div className="px-3 pb-1 pt-3 text-xs text-muted">{title}</div>
              {items.map((it) => {
                n += 1;
                const on = n === idx;
                const mine = n;
                return (
                  <button
                    key={it.id}
                    role="option"
                    aria-selected={on}
                    onMouseEnter={() => setIdx(mine)}
                    onClick={() => run(it)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm ${on ? 'bg-raised text-ink' : 'text-ink2'}`}
                  >
                    <span>{it.label}</span>
                    <span className="font-mono text-xs text-muted">{it.hint}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="border-t border-line px-5 py-2.5 text-xs text-muted">↑↓ move · Enter run · Esc close</div>
      </div>
    </div>
  );
}
