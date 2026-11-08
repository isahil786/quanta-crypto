// Shared helpers

let counter = 0;

/** Collision-free id: prefix + time + monotonically increasing counter. */
export function uid(prefix) {
  counter = (counter + 1) % 1e9;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Keep the newest `max` entries of an array that is built with unshift(). */
export function capList(list, max) {
  if (list.length > max) list.length = max;
}

export function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function isPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}
