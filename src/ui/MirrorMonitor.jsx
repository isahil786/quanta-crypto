import React from 'react';

const BROKER_COLOR = { coinswitch: '#E8A838', delta: '#38BDF8', coindcx: '#A78BFA' };
const time = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '—');

function Node({ title, sub, tone = 'border-line', children }) {
  return (
    <div className={`min-w-0 rounded-xl border bg-surface p-4 ${tone}`}>
      <div className="truncate text-sm font-semibold text-ink">{title}</div>
      <div className="mt-1 truncate font-mono text-xs text-muted">{sub}</div>
      {children && <div className="mt-3 flex flex-wrap gap-1.5">{children}</div>}
    </div>
  );
}
const Chip = ({ tone, children }) => <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${tone}`}>{children}</span>;
const Arrow = () => <div aria-hidden className="grid place-items-center text-muted"><span className="hidden lg:block">━━▶</span><span className="lg:hidden">▼</span></div>;

/** Live picture of the copy chain: master, copy engine, replicas, and what just happened. Read-only. */
export default function MirrorMonitor({ config, masterAccount, accounts }) {
  const logs = (config.logs || []).slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const copied = logs.filter((l) => l.status === 'EXECUTED').length;
  const skipped = logs.length - copied;
  const nameOf = (id) => accounts.find((a) => a.id === id)?.accountName || id;

  const replicaState = (rep) => {
    const name = nameOf(rep.accountId);
    const last = logs.find((l) => l.targetAccount === name);
    if (!config.enabled || !rep.active) return { label: 'Paused', tone: 'bg-raised text-muted', border: 'border-line', last };
    if (last && last.status !== 'EXECUTED') return { label: 'Last copy skipped', tone: 'bg-live/15 text-live', border: 'border-live/60', last };
    return { label: last ? 'Synced' : 'Waiting', tone: 'bg-up/15 text-up', border: 'border-up/40', last };
  };

  return (
    <section className="rounded-xl border border-line bg-canvas/40 p-4 lg:p-5" aria-label="Copy chain">
      <div className="grid items-start gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1.2fr]">
        <Node title={`Master · ${masterAccount.accountName}`} sub={`${masterAccount.broker} · ${masterAccount.segment}`} tone="border-live/50">
          <Chip tone={masterAccount.mode === 'REAL' ? 'bg-live text-canvas' : 'bg-paper/15 text-paper'}>{masterAccount.mode === 'REAL' ? 'LIVE' : 'PAPER'}</Chip>
        </Node>
        <Arrow />
        <Node title="Copy engine" sub={config.enabled ? 'Engine active' : 'Engine paused'} tone={config.enabled ? 'border-accent/60' : 'border-line'}>
          <Chip tone={config.enabled ? 'bg-up/15 text-up' : 'bg-raised text-muted'}>{config.enabled ? '● Running' : '❚❚ Paused'}</Chip>
          <Chip tone="bg-raised text-ink2">{config.replicas.filter((r) => r.active).length} active replicas</Chip>
        </Node>
        <Arrow />
        <div className="grid gap-3">
          {config.replicas.map((rep) => {
            const acc = accounts.find((a) => a.id === rep.accountId);
            const st = replicaState(rep);
            return (
              <Node key={rep.accountId} title={nameOf(rep.accountId)} sub={`${acc?.broker || 'unknown'} · size ×${rep.multiplier ?? 1}`} tone={st.border}>
                <Chip tone={st.tone}>{st.label}</Chip>
                {st.last && <span className="self-center font-mono text-xs text-muted">last copy {time(st.last.timestamp)}</span>}
                <span className="ml-auto size-2.5 self-center rounded-full" style={{ background: BROKER_COLOR[acc?.broker] || '#8e97a8' }} aria-hidden />
              </Node>
            );
          })}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_2fr]">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">Copied</p><p className="font-mono text-xl font-semibold text-up">{copied}</p></div>
          <div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">Skipped or failed</p><p className={`font-mono text-xl font-semibold ${skipped ? 'text-live' : 'text-ink'}`}>{skipped}</p></div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="mb-1 text-xs font-semibold text-ink">Live copy log</p>
          {logs.length === 0 && <p className="text-xs text-muted">No copies yet.</p>}
          {logs.slice(0, 5).map((l) => (
            <div key={l.id} className="flex gap-3 border-t border-line/60 py-1.5 font-mono text-xs first:border-0">
              <span className="text-muted">{time(l.timestamp)}</span>
              <span className={l.status === 'EXECUTED' ? 'text-up' : 'text-live'}>{l.status === 'EXECUTED' ? '✓' : '!'} {l.targetAccount}</span>
              <span className="truncate text-ink2">{l.masterOrder}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
