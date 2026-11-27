// In-memory server log store: captures all console.log / warn / error output
// so the UI can surface server logs and errors across every tab.
const MAX_LOGS = 2000;
const logs = [];

// Save originals BEFORE overwriting so we can forward without recursion.
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

/** Render one console argument safely: Errors keep their stack, circular/BigInt values never throw. */
function fmt(a) {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (a && typeof a === 'object') {
    try { return JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)); } catch { return '[unserializable]'; }
  }
  return String(a);
}

/** Mask credentials before a log line is exposed through /api/logs. */
export function redact(text) {
  return String(text)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/(["']?(?:api[_-]?key|api[_-]?secret|secret|token|password|signature|authorization|x-auth-[a-z-]+)["']?\s*[:=]\s*)(["']?)[^\s"',}&]+/gi, '$1$2***')
    .replace(/([?&](?:token|apiKey|signature)=)[^&\s]+/gi, '$1***');
}

function push(level, ...args) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level, // 'log' | 'warn' | 'error'
    message: redact(args.map(fmt).join(' ')),
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
  // After an uncaught exception the process state is unknown (half-applied fills, stuck locks). For a trading
  // process the safe response is to log it and exit so a supervisor (Docker/Render/systemd) restarts it clean.
  // Set CRASH_ON_UNCAUGHT=false to keep running (not recommended). Tests never exit.
  process.on('uncaughtException', (err) => {
    push('error', `[UNCAUGHT_EXCEPTION] ${err.stack || err.message}`);
    if (process.env.CRASH_ON_UNCAUGHT !== 'false' && !process.env.QUANTA_TEST) {
      setTimeout(() => process.exit(1), 100).unref?.();
    }
  });
  process.on('unhandledRejection', (reason) => {
    push('error', `[UNHANDLED_REJECTION] ${reason && reason.stack ? reason.stack : String(reason)}`);
  });
}
