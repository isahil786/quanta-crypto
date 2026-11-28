import React from 'react';

/**
 * One table pattern, two layouts. From md up it is a real table with a sticky header and
 * right-aligned numbers. Below md each row becomes a card, so nothing scrolls sideways.
 *
 * columns: [{ key, header, render?(row), align?: 'right'|'center', primary?: bool, mono?: bool, cardHide?: bool }]
 *   primary  - shown as the card title; the other columns become label/value lines
 *   sortable - field name; with onSort(field) and sortBy/sortAsc the header becomes a sort button
 *   actions  - mark an action column with `actions: true`; it renders as the card footer
 */
export default function DataTable({ columns, rows, rowKey = (r) => r.id, empty = 'Nothing to show yet.', loading = false, className = '', sortBy, sortAsc = true, onSort }) {
  const cell = (c, r) => (c.render ? c.render(r) : r[c.key]);
  const align = (c) => (c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left');

  if (loading) {
    return (
      <div className={`space-y-2 p-4 ${className}`} aria-busy="true">
        {[70, 90, 60].map((w) => <div key={w} className="h-4 animate-pulse rounded bg-raised" style={{ width: `${w}%` }} />)}
      </div>
    );
  }
  if (!rows.length) return <div className={`px-4 py-10 text-center text-sm text-muted ${className}`}>{empty}</div>;

  const primary = columns.find((c) => c.primary) || columns[0];
  const actions = columns.find((c) => c.actions);
  const fields = columns.filter((c) => c !== primary && c !== actions && !c.cardHide);

  return (
    <div className={className}>
      {/* Table: tablet and desktop */}
      <div className="hidden max-h-[70vh] overflow-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-raised text-xs font-medium text-muted">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={c.sortable && sortBy === c.sortable ? (sortAsc ? 'ascending' : 'descending') : undefined}
                  className={`px-4 py-2.5 font-medium ${align(c)}`}
                >
                  {c.sortable && onSort ? (
                    <button onClick={() => onSort(c.sortable)} className="inline-flex items-center gap-1 hover:text-ink">
                      {c.header}
                      <span aria-hidden className={sortBy === c.sortable ? 'text-accent' : 'opacity-40'}>{sortBy === c.sortable ? (sortAsc ? '▲' : '▼') : '↕'}</span>
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60 tabular-nums">
            {rows.map((r) => (
              <tr key={rowKey(r)} className="transition-colors hover:bg-raised/50">
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-3 ${align(c)} ${c.mono === false ? '' : 'font-mono'}`}>{cell(c, r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Cards: phones */}
      <ul className="grid gap-3 p-3 md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="rounded-xl border border-line bg-surface p-4">
            <div className="text-sm font-semibold text-ink">{cell(primary, r)}</div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
              {fields.map((c) => (
                <div key={c.key} className="min-w-0">
                  <dt className="text-xs text-muted">{c.header}</dt>
                  <dd className="truncate font-mono text-sm text-ink">{cell(c, r)}</dd>
                </div>
              ))}
            </dl>
            {actions && <div className="mt-3 border-t border-line pt-3">{cell(actions, r)}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
