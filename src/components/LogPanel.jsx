import React, { useState, useEffect, useRef } from 'react';

const LEVEL_TONE = {
  error: { border: 'border-l-down', bg: 'bg-down/10', text: 'text-down', dot: 'bg-down' },
  warn: { border: 'border-l-live', bg: 'bg-live/10', text: 'text-live', dot: 'bg-live' },
  log: { border: 'border-l-line', bg: 'bg-raised/10', text: 'text-muted', dot: 'bg-line2' },
};

export default function LogPanel() {
  const [logs, setLogs] = useState([]);
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef(null);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/logs');
      if (res.ok) {
        const data = await res.json();
        setLogs(Array.isArray(data.logs) ? data.logs : []);
      }
    } catch {
      /* silently ignore fetch errors */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    const iv = setInterval(fetchLogs, 3000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const clearLogs = async () => {
    try {
      await fetch('/api/logs', { method: 'DELETE' });
    } catch {
      /* ignore */
    }
    setLogs([]);
  };

  const rows = logs.map((l) => {
    const t = LEVEL_TONE[l.level] || LEVEL_TONE.log;
    const shortTs = l.ts ? l.ts.slice(11, 19) : '';
    return (
      <div
        key={l.id}
        className={`flex gap-2 p-1.5 text-xs border-b border-line/40 ${t.bg} group`}
      >
        <span className={`flex-shrink-0 w-8 ${t.dot}`} aria-hidden />
        <span className="text-[10px] text-muted whitespace-nowrap">{shortTs}</span>
        <span className={`text-[10px] uppercase font-bold ${t.text} ml-1`}>{l.level.toUpperCase()}</span>
        <div className="flex-1 min-w-0 break-all font-mono text-xs text-ink whitespace-pre-wrap">
          {l.message}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setAutoScroll(false);
          }}
          className="text-xs text-muted hover:text-ink opacity-0 group-hover:opacity-100"
          aria-label="Pin"
        >
          ⋮
        </button>
      </div>
    );
  });

  return (
    <div className="flex flex-col gap-1.5 border-t border-line bg-surface/50">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface border-b border-line/60 cursor-pointer select-none hover:bg-raised/40" onClick={() => setExpanded((e) => !e)}>
        <span className="text-xs font-semibold text-ink">Server Logs</span>
        <div className="flex items-center gap-1.5 text-xs">
          <span className={`text-[10px] ${logs.filter((l) => l.level === 'error').length ? 'text-down' : 'text-muted'}`}>
            {logs.filter((l) => l.level === 'error').length} errors
          </span>
          <button
            onClick={clearLogs}
            className="text-[10px] text-muted hover:text-ink underline underline-offset-2"
            aria-label="Clear logs"
          >
            Clear
          </button>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-[10px] text-muted hover:text-ink"
            aria-label={expanded ? 'Collapse logs' : 'Expand logs'}
          >
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>
      {expanded && (
        <div
          ref={listRef}
          className={`max-h-64 overflow-y-auto border-t border-line ${loading ? 'opacity-50' : 'opacity-100'}`}
        >
          {loading ? (
            <div className="p-3 text-xs text-muted">Loading logs…</div>
          ) : logs.length ? (
            rows
          ) : (
            <div className="p-3 text-xs text-muted text-center">No server logs yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
