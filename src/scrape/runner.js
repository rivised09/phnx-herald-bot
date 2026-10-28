const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Scrape jobs, driven from the web dashboard.
 *
 * The existing commands stay the single implementation of each job: this module
 * spawns the same scripts (`scripts/scrape.js`, `scripts/enrich.js`,
 * `scripts/callofstats-scrape.js`, `scripts/dragon-login.js`) as child
 * processes and streams their output. Nothing here duplicates scraping logic,
 * so a run started from the settings page behaves exactly like the terminal.
 *
 * Only one job runs at a time: they all write the same R2 keys, and the two
 * roster sources must never race on `index.json`.
 *
 * DragonStats signs in through Google, which cannot be scripted. When the saved
 * Convex JWT is missing or expired the runner starts `dragon-login.js`, which
 * opens a window on the bot host, and continues with the scrape once it exits
 * successfully. That requires a desktop session; on a headless host the job
 * fails with an explicit message instead of waiting forever.
 */

const ROOT = path.join(__dirname, '..', '..');
const MAX_LOG_LINES = 2000;
const MAX_STEP_LINES = 600;
const LOGIN_TIMEOUT_MINUTES = 10;

const SCRIPTS = {
  dragon: path.join(ROOT, 'scripts', 'scrape.js'),
  enrich: path.join(ROOT, 'scripts', 'enrich.js'),
  callofstats: path.join(ROOT, 'scripts', 'callofstats-scrape.js'),
  login: path.join(ROOT, 'scripts', 'dragon-login.js'),
};

const STEP_LABELS = {
  dragon: 'DragonStats scrape',
  enrich: 'CallofStats enrichment',
  callofstats: 'CallofStats full scrape',
  login: 'DragonStats sign-in',
};

const KINDS = ['dragon', 'enrich', 'callofstats', 'login'];
const MODES = ['latest', 'date', 'scan-index'];

let job = null;
let logs = [];
let seq = 0;
let child = null;
let cancelled = false;
let stepLines = [];

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_JOB';
  return error;
}

function text(value, fallback = '') {
  return String(value === undefined || value === null ? fallback : value).trim();
}

function validDate(value) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === date ? date : null;
}

function concurrency(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(5, Math.round(parsed)));
}

/**
 * Turns a request body into an explicit job: script, arguments and label.
 *
 * Exported so the argument building can be tested without spawning anything.
 */
function normalizeJob(input = {}) {
  const kind = text(input.kind, 'dragon');
  if (!KINDS.includes(kind)) throw invalid(`Unknown scrape type "${kind}".`);

  const server = text(input.server, '973').replace(/^#/, '');
  if (kind !== 'login' && !/^\d{1,7}$/.test(server)) {
    throw invalid('Server must be a number, for example 973.');
  }

  const spec = {
    kind,
    server: kind === 'login' ? null : server,
    mode: null,
    date: null,
    scanIndex: 0,
    concurrency: 1,
    relogin: input.relogin !== false,
    enrichAfter: false,
    label: STEP_LABELS[kind],
    phase: 'scraping',
    args: [],
  };

  if (kind === 'dragon') {
    const mode = text(input.mode, 'latest');
    if (!MODES.includes(mode)) throw invalid(`Unknown scan mode "${mode}".`);
    spec.mode = mode;
    spec.args = ['--server', server];

    if (mode === 'date') {
      const date = validDate(input.date);
      if (!date) throw invalid('Pick a date (YYYY-MM-DD) for the scan to scrape.');
      spec.date = date;
      spec.args.push('--scan-date', date);
    } else if (mode === 'scan-index') {
      const index = Number(input.scanIndex ?? 0);
      if (!Number.isInteger(index) || index < 0 || index > 500) {
        throw invalid('Scan index must be a whole number from 0 to 500.');
      }
      spec.scanIndex = index;
      if (index > 0) spec.args.push('--scan-index', String(index));
    }

    spec.enrichAfter = Boolean(input.enrichAfter);
    if (mode === 'date') spec.label = `DragonStats scan · ${spec.date}`;
    else if (mode === 'scan-index') spec.label = `DragonStats scan · #${spec.scanIndex}`;
    else spec.label = 'DragonStats latest scan';
  }

  if (kind === 'enrich') {
    const date = input.date ? validDate(input.date) : null;
    if (input.date && !date) throw invalid('The enrichment date must be YYYY-MM-DD.');
    spec.date = date;
    spec.concurrency = concurrency(input.concurrency, 1);
    spec.args = ['--server', server, '--concurrency', String(spec.concurrency)];
    if (date) spec.args.push('--date', date);
    spec.label = date ? `CallofStats enrichment · ${date}` : 'CallofStats enrichment';
    spec.phase = 'enriching';
  }

  if (kind === 'callofstats') {
    spec.concurrency = concurrency(input.concurrency, 2);
    spec.args = ['--server', server, '--concurrency', String(spec.concurrency)];
    spec.label = 'CallofStats full scrape';
  }

  if (kind === 'login') {
    spec.args = [`--timeout=${LOGIN_TIMEOUT_MINUTES}`];
    spec.label = 'DragonStats sign-in';
    spec.phase = 'login';
  }

  return spec;
}

function addLog(stream, line) {
  const entry = { seq: (seq += 1), at: Date.now(), stream, line };
  logs.push(entry);
  if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES);
  if (stream !== 'meta') {
    stepLines.push(line);
    if (stepLines.length > MAX_STEP_LINES) stepLines = stepLines.slice(-MAX_STEP_LINES);
  }
  return entry;
}

function publicJob() {
  if (!job) return null;
  return { ...job, logSeq: seq, logCount: logs.length };
}

/** The current job plus the log lines the caller has not seen yet. */
function getScrapeState({ after = 0, limit = 500 } = {}) {
  const max = Math.max(1, Math.min(Number(limit) || 500, MAX_LOG_LINES));
  const since = Number(after) || 0;
  const fresh = since > 0 ? logs.filter((entry) => entry.seq > since) : logs;
  return { job: publicJob(), logs: fresh.slice(-max) };
}

/**
 * Whether the host has a display a browser window can open on.
 *
 * Windows and macOS are desktops. On Linux, DISPLAY or WAYLAND_DISPLAY is
 * trusted (a container may run Xvfb deliberately), with the X socket checked
 * so a stale variable does not start a browser that cannot connect. Set
 * DRAGONSTATS_INTERACTIVE_LOGIN=0 on a server whose virtual display nobody is
 * watching, so the job fails with an explanation instead of waiting.
 */
function canOpenWindow() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  if (process.env.DRAGONSTATS_INTERACTIVE_LOGIN === '0') return false;
  if (process.env.WAYLAND_DISPLAY) return true;

  const display = process.env.DISPLAY;
  if (!display) return false;
  const match = /^:(\d+)/.exec(display);
  if (!match) return true;
  return fs.existsSync(`/tmp/.X11-unix/X${match[1]}`);
}

/** Whether the saved DragonStats storage state carries a usable Convex JWT. */
function dragonSessionStatus() {
  let state = null;
  let base = 'https://dragonstats.com';
  try {
    const session = require('../dragon/session');
    base = session.BASE;
    state = session.loadSession();
  } catch {
    state = null;
  }

  const origin = (state?.origins || []).find((entry) => String(entry.origin).startsWith(base));
  const token = (origin?.localStorage || []).find((item) =>
    String(item.name).startsWith('__convexAuthJWT'),
  );
  if (!token?.value) {
    return { hasSession: Boolean(state), valid: false, expiresAt: null, secondsLeft: null };
  }

  try {
    const payload = JSON.parse(
      Buffer.from(String(token.value).split('.')[1], 'base64url').toString('utf8'),
    );
    const secondsLeft = Number(payload.exp) - Math.floor(Date.now() / 1000);
    return {
      hasSession: true,
      valid: Number.isFinite(secondsLeft) && secondsLeft > 120,
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      secondsLeft: Number.isFinite(secondsLeft) ? secondsLeft : null,
    };
  } catch {
    return { hasSession: true, valid: false, expiresAt: null, secondsLeft: null };
  }
}

function gateStatus() {
  try {
    const gate = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'data', 'dragon-gate.json'), 'utf8'),
    );
    const msLeft = Number(gate.expiresAt) - Date.now();
    return {
      valid: msLeft > 0,
      expiresAt: Number(gate.expiresAt) ? new Date(Number(gate.expiresAt)).toISOString() : null,
      secondsLeft: Math.floor(msLeft / 1000),
    };
  } catch {
    return { valid: false, expiresAt: null, secondsLeft: null };
  }
}

/** Everything the settings page needs to render sensible defaults. */
async function getScrapeOptions() {
  let dates = [];
  let latest = null;
  try {
    const r2 = require('../roster/r2');
    if (r2.configured()) {
      const index = await r2.getJson('index.json');
      dates = Array.isArray(index?.dates) ? index.dates : [];
      latest = index?.latest || dates[0] || null;
    }
  } catch {
    // A missing R2 configuration only hides the date shortcuts.
  }

  let accounts = 0;
  try {
    accounts = require('../roster/session').accountList().length;
  } catch {
    accounts = 0;
  }

  return {
    server: '973',
    dates,
    latest,
    dragon: { ...dragonSessionStatus(), gate: gateStatus() },
    callofstats: { accounts },
    canOpenWindow: canOpenWindow(),
    platform: process.platform,
    running: Boolean(job?.running),
  };
}

function pipeLines(stream, name, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(name, line);
    }
  });
  stream.on('end', () => {
    const line = buffer.replace(/\r$/, '');
    buffer = '';
    if (line.trim()) onLine(name, line);
  });
}

function killChild() {
  const proc = child;
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        proc.kill('SIGTERM');
      }
      const force = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5000);
      if (force.unref) force.unref();
    }
  } catch {
    /* the process may have exited between the check and the signal */
  }
}

function runStep(key, args, phase) {
  return new Promise((resolve) => {
    const script = SCRIPTS[key];
    const step = {
      key,
      label: STEP_LABELS[key],
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
    };
    job = { ...job, phase, steps: [...job.steps, step] };
    addLog('meta', `[scrape] $ node ${path.relative(ROOT, script)} ${args.join(' ')}`);

    let proc;
    try {
      proc = spawn(process.execPath, [script, ...args], {
        cwd: ROOT,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      addLog('stderr', `[scrape] Could not start ${path.basename(script)}: ${error.message}`);
      step.status = 'failed';
      step.finishedAt = new Date().toISOString();
      resolve({ ok: false, code: -1 });
      return;
    }

    child = proc;
    pipeLines(proc.stdout, 'stdout', addLog);
    pipeLines(proc.stderr, 'stderr', addLog);
    proc.on('error', (error) => addLog('stderr', `[scrape] ${error.message}`));

    proc.on('close', (code, signal) => {
      if (child === proc) child = null;
      const ok = code === 0;
      step.status = cancelled ? 'cancelled' : ok ? 'complete' : 'failed';
      step.exitCode = code;
      step.finishedAt = new Date().toISOString();
      addLog(
        'meta',
        `[scrape] ${step.label} ${
          cancelled ? 'cancelled' : ok ? 'finished' : `failed (exit ${code ?? signal})`
        }.`,
      );
      resolve({ ok, code: code ?? -1 });
    });
  });
}

/** Phrases that only appear when DragonStats refused the saved session. */
function looksLikeExpiredSession() {
  const text = stepLines.join('\n');
  if (
    /did not issue a browser session|No DragonStats session|NO_SESSION|Unauthorized|not authenticated|dragon:login/i.test(
      text,
    )
  ) {
    return true;
  }

  // Convex masks auth failures as "Server Error", which is also what a changed
  // query looks like. Only treat it as a session problem when the JWT is gone
  // or about to expire, so a schema change cannot open a login window.
  const status = dragonSessionStatus();
  return (
    /CONVEX .*Server Error/i.test(text) &&
    (!status.valid || status.secondsLeft === null)
  );
}

function finish(result) {
  const label = job.label;
  const phase = cancelled ? 'cancelled' : result.ok ? 'complete' : 'failed';
  job = {
    ...job,
    running: false,
    phase,
    finishedAt: new Date().toISOString(),
    exitCode: result.code,
    error: result.ok
      ? null
      : cancelled
        ? 'Cancelled.'
        : `${label} exited with code ${result.code}.`,
  };
  addLog('meta', `[scrape] Job ${phase}.`);
}

function fail(error) {
  job = {
    ...job,
    running: false,
    phase: cancelled ? 'cancelled' : 'failed',
    finishedAt: new Date().toISOString(),
    error: error.message,
  };
  addLog('stderr', `[scrape] ${error.message}`);
}

async function signIn() {
  if (!canOpenWindow()) {
    throw new Error(
      'DragonStats sign-in needs a browser window on the bot host, but no display is available. ' +
        'Run the scrape from a machine with a desktop, or give this host a display (Xvfb/VNC).',
    );
  }
  addLog(
    'meta',
    '[scrape] Opening the DragonStats Google sign-in window on the bot host. ' +
      'If you cannot see it, cancel and run the scrape from a desktop.',
  );
  return runStep('login', [`--timeout=${LOGIN_TIMEOUT_MINUTES}`], 'login');
}

async function run(spec) {
  try {
    if (spec.kind === 'dragon' && !canOpenWindow() && !gateStatus().valid) {
      throw new Error(
        'The DragonStats browser gate token has expired and the bot host has no display to mint a new one. ' +
          'Run the scrape on a machine with a desktop, or run npm run scrape locally.',
      );
    }

    if (spec.kind === 'dragon' && spec.relogin) {
      const status = dragonSessionStatus();
      if (!status.valid) {
        addLog(
          'meta',
          `[scrape] DragonStats session is ${status.hasSession ? 'expired' : 'missing'}; signing in first.`,
        );
        const signed = await signIn();
        if (!signed.ok) {
          throw new Error(
            'DragonStats sign-in did not complete, so the scrape was not started. ' +
              'Finish the Google sign-in in the window and try again.',
          );
        }
      }
    }

    let result = await runStep(spec.kind, spec.args, spec.phase);

    if (
      !result.ok &&
      spec.kind === 'dragon' &&
      spec.relogin &&
      !cancelled &&
      looksLikeExpiredSession()
    ) {
      addLog('meta', '[scrape] The saved session looks rejected; signing in and retrying once.');
      const signed = await signIn();
      if (signed.ok) result = await runStep(spec.kind, spec.args, spec.phase);
    }

    if (result.ok && spec.enrichAfter && !cancelled) {
      const args = ['--server', spec.server, '--concurrency', '1'];
      if (spec.mode === 'date' && spec.date) args.push('--date', spec.date);
      result = await runStep('enrich', args, 'enriching');
    }

    finish(result);
  } catch (error) {
    fail(error);
  }
}

function startScrape(input) {
  if (job?.running) return { accepted: false, ...getScrapeState() };

  const spec = normalizeJob(input);
  logs = [];
  seq = 0;
  stepLines = [];
  cancelled = false;
  job = {
    id: `job_${Date.now().toString(36)}`,
    kind: spec.kind,
    label: spec.label,
    phase: 'starting',
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    options: {
      server: spec.server,
      mode: spec.mode,
      date: spec.date,
      scanIndex: spec.scanIndex,
      concurrency: spec.concurrency,
      relogin: spec.relogin,
      enrichAfter: spec.enrichAfter,
    },
    steps: [],
  };
  addLog('meta', `[scrape] ${spec.label} started.`);

  // Let the response return before the first child process is spawned.
  setImmediate(() => {
    run(spec).catch(fail);
  });

  return { accepted: true, ...getScrapeState() };
}

function cancelScrape() {
  if (!job?.running) return { cancelled: false, ...getScrapeState() };
  cancelled = true;
  addLog('meta', '[scrape] Cancel requested; stopping the current step.');
  killChild();
  return { cancelled: true, ...getScrapeState() };
}

module.exports = {
  normalizeJob,
  startScrape,
  cancelScrape,
  getScrapeState,
  getScrapeOptions,
  dragonSessionStatus,
  canOpenWindow,
};
