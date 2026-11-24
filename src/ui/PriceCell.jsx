import React, { useEffect, useRef, useState } from 'react';

/** Price that flashes on change with an arrow, so direction never relies on colour alone. Pass stale to grey it out. */
export default function PriceCell({ value, decimals = 2, stale = false, className = '' }) {
  const prev = useRef(value);
  const [dir, setDir] = useState(0);
  useEffect(() => {
    if (value === prev.current) return undefined;
    // Ignore sub-tick noise (< 0.005%) so a busy symbol does not flash constantly
    const moved = Math.abs(value - prev.current) / (Math.abs(prev.current) || 1) >= 0.00005;
    const direction = value > prev.current ? 1 : -1;
    prev.current = value;
    if (!moved) return undefined;
    setDir(direction);
    const t = setTimeout(() => setDir(0), 450);
    return () => clearTimeout(t);
  }, [value]);
  const tone = stale ? 'text-muted' : dir > 0 ? 'text-up bg-up/20' : dir < 0 ? 'text-down bg-down/20' : 'text-ink';
  return (
    <span className={`rounded px-1 font-mono tabular-nums transition-colors motion-reduce:transition-none ${tone} ${className}`}>
      <span aria-hidden="true" className="inline-block w-[1.1ch]">{dir > 0 ? '▲' : dir < 0 ? '▼' : ''}</span>
      {Number(value).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
    </span>
  );
}
