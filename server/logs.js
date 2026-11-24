// In-memory server log store: captures all console.log / warn / error output
// so the UI can surface server logs and errors across every tab.
const MAX_LOGS = 2000;
const logs = [];

// Save originals BEFORE overwriting so we can forward without recursion.
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function push(level, ...args) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level, // 'log' | 'warn' | 'error'
    message: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
    raw: args,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  // Forward to real console so the terminal still shows everything.
  if (level === 'error') origError.apply(console, args);
  else if (level === 'warn') origWarn.apply(console, args);
  else origLog.apply(console, args);
}

export function getLogs() {
  return [...logs].reverse(); // newest first
}

export function clearLogs() {
  logs.length = 0;
}

export function installConsoleCapture() {
  console.log = (...args) => push('log', ...args);
  console.warn = (...args) => push('warn', ...args);
  console.error = (...args) => push('error', ...args);
  // Capture unhandled errors and rejections too.
  process.on('uncaughtException', (err) => {
    push('error', `[UNCAUGHT_EXCEPTION] ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    push('error', `[UNHANDLED_REJECTION] ${reason && reason.stack ? reason.stack : String(reason)}`);
  });
}
