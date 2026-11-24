/** setInterval that skips its callback while the browser tab is hidden (no background polling).
 *  Returns a normal interval id, so `clearInterval(id)` cleans it up as usual. The next tick after the tab
 *  becomes visible again refreshes the data. */
export function visibleInterval(fn, ms) {
  return setInterval(() => { if (!document.hidden) fn(); }, ms);
}
