const { spawn } = require('child_process');
const path = require('path');

/**
 * Client for the Python scrape sidecar (scrape/sidecar.py).
 *
 * The sidecar owns the network: every request leaves through Scrapling's
 * browser-TLS-impersonating transport instead of Node's, which is the
 * fingerprint the source learned to refuse. The bot keeps everything else -
 * pacing, account rotation, sessions, the database.
 *
 * Protocol is JSON lines over stdin/stdout; stderr is mirrored to the console
 * with a [SIDECAR] prefix so Python failures are visible next to Node's logs.
 *
 * Enable with ROSTER_SIDECAR=1. When the flag is off the process is never
 * started, and when it dies mid-flight the caller falls back to the direct
 * HTTP path, so a broken Python install degrades to today's behaviour rather
 * than stopping a run.
 */

const SIDECAR_SCRIPT = path.join(__dirname, '..', '..', 'scrape', 'sidecar.py');
const PYTHON = process.env.ROSTER_SIDECAR_PYTHON || 'python';
const READY_TIMEOUT_MS = 20000;

/** The whole feature is opt-in so the test suite keeps its direct HTTP path. */
function enabled() {
  const flag = String(process.env.ROSTER_SIDECAR || '').toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'on';
}

let child = null;
let starting = null;
let resolveStart = null;
let nextId = 0;
let stderrTail = '';
const pending = new Map();

function sidecarError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function rejectAllPending(reason) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(reason);
  }
  pending.clear();
}

function handleLine(line) {
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.event === 'ready') {
    if (resolveStart) {
      const resolve = resolveStart;
      resolveStart = null;
      resolve();
    }
    return;
  }

  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearTimeout(entry.timer);

  if (msg.ok) {
    entry.resolve(msg.result);
  } else {
    const error = msg.error || {};
    entry.reject(sidecarError(error.code || 'SIDECAR_ERROR', error.message || 'sidecar error'));
  }
}

function start() {
  if (starting) return starting;

  starting = new Promise((resolve, reject) => {
    let stdout = '';
    const proc = spawn(PYTHON, ['-u', SIDECAR_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      proc.kill();
      starting = null;
      resolveStart = null;
      reject(sidecarError('SIDECAR_START', `sidecar did not become ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);

    resolveStart = () => {
      clearTimeout(timer);
      resolveStart = null;
      child = proc;
      starting = null;
      resolve(proc);
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
      let index = stdout.indexOf('\n');
      while (index !== -1) {
        const line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        handleLine(line);
        index = stdout.indexOf('\n');
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) console.warn(`[SIDECAR] ${line}`);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      starting = null;
      resolveStart = null;
      reject(sidecarError('SIDECAR_START', `could not start ${PYTHON}: ${err.message}`));
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      child = null;
      starting = null;
      resolveStart = null;
      rejectAllPending(
        sidecarError(
          'SIDECAR_EXIT',
          `sidecar exited (code=${code}, signal=${signal})${stderrTail ? `: ${stderrTail.trim().slice(-400)}` : ''}`,
        ),
      );
    });
  });

  return starting;
}

/**
 * Sends one operation and waits for its answer.
 *
 * The timeout is the caller's budget plus transport slack: Python enforces
 * its own per-request timeout, this only catches a wedged process.
 */
async function request(op, args = {}, timeoutMs = 60000) {
  const proc = await start();
  const id = ++nextId;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(sidecarError('SIDECAR_TIMEOUT', `${op} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(`${JSON.stringify({ id, op, args })}\n`, (err) => {
      if (err) {
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(sidecarError('SIDECAR_WRITE', err.message));
        }
      }
    });
  });
}

/** Stops the Python process; safe to call when nothing is running. */
function shutdown() {
  if (!child) return;
  const proc = child;
  child = null;
  rejectAllPending(sidecarError('SIDECAR_EXIT', 'sidecar shutting down'));
  try {
    proc.stdin.end();
  } catch {
    // Already gone.
  }
  setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
  }, 2000).unref?.();
}

process.on('exit', shutdown);

module.exports = { enabled, request, shutdown };
