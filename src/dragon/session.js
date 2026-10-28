const fs = require('fs');
const path = require('path');
const { sandboxEnabled } = require('../browser');

/**
 * A saved DragonStats session.
 *
 * DragonStats signs in through Google only, so there is no password to store
 * and no form to fill on every run: a human completes the Google flow once in
 * a headed browser, and the resulting storage state (cookies plus the Convex
 * auth token in localStorage) is reused afterwards.
 *
 * The file holds live tokens and lives under `data/`, which is gitignored.
 */

const BASE = process.env.DRAGONSTATS_BASE_URL || 'https://dragonstats.com';
const DASHBOARD_URL = `${BASE}/dashboard`;

const SESSION_FILE =
  process.env.DRAGONSTATS_SESSION_FILE ||
  path.join(__dirname, '..', '..', 'data', 'dragonstats-session.json');

const NAV_TIMEOUT_MS = 45000;

function requirePlaywright() {
  let pw;
  try {
    pw = require('playwright');
  } catch {
    const err = new Error(
      'Playwright is not installed. Run: npm i playwright && npx playwright install --with-deps chromium',
    );
    err.code = 'NO_PLAYWRIGHT';
    throw err;
  }

  try {
    const exe = pw.chromium.executablePath();
    if (!exe || !fs.existsSync(exe)) throw new Error('browser binary missing');
  } catch {
    const err = new Error(
      'The Chromium binary is not installed. Run: npm run install:browsers',
    );
    err.code = 'NO_PLAYWRIGHT';
    throw err;
  }

  return pw;
}

function readLocalSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function saveSession(context) {
  const state = await context.storageState({ path: SESSION_FILE });
  state.savedAt = Date.now();
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state));
  return state;
}

/**
 * Imports a storage state captured on another machine.
 *
 * A Google login needs a visible window, so a container host can never create
 * one itself. `npm run dragon:login` on a desktop writes
 * `data/dragonstats-session.json`; uploading that file here lets the bot reuse
 * the same cookies and Convex JWT.
 *
 * Only the expiry is returned. The state itself holds live tokens and must
 * never be logged.
 */
function importSession(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('The file is not a Playwright storage state.');
  }
  if (!Array.isArray(state.cookies)) {
    throw new Error('The session file has no cookies.');
  }
  if (!Array.isArray(state.origins)) {
    throw new Error('The session file has no localStorage origins.');
  }

  const origin = state.origins.find((entry) =>
    (entry?.localStorage || []).some((item) =>
      String(item?.name || '').startsWith('__convexAuthJWT'),
    ),
  );
  const token = (origin?.localStorage || []).find((item) =>
    String(item?.name || '').startsWith('__convexAuthJWT'),
  );
  if (!token?.value) {
    throw new Error('The session file has no DragonStats Convex token. Run npm run dragon:login first.');
  }

  let expiresAt = null;
  let secondsLeft = null;
  try {
    const payload = JSON.parse(
      Buffer.from(String(token.value).split('.')[1], 'base64url').toString('utf8'),
    );
    secondsLeft = Number(payload.exp) - Math.floor(Date.now() / 1000);
    expiresAt = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    throw new Error('The DragonStats token in that file is not readable.');
  }

  if (!Number.isFinite(secondsLeft) || secondsLeft <= 120) {
    throw new Error(
      `That DragonStats session is expired${
        expiresAt ? ` (${expiresAt})` : ''
      }. Run npm run dragon:login again on a desktop.`,
    );
  }

  const saved = { ...state, savedAt: Date.now() };
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(saved));
  return { expiresAt, secondsLeft };
}

/**
 * Whether the browser is signed in.
 *
 * DragonStats uses Convex for auth, which keeps its JWT in localStorage under
 * a namespaced key (`__convexAuthJWT_…`). That is a more reliable signal than
 * looking for a button: the header renders differently on mobile widths and
 * during hydration, and a stale token is still worth trying before asking the
 * user to sign in again.
 */
async function signedIn(page) {
  return page.evaluate(() => {
    try {
      return Object.keys(window.localStorage).some((key) => key.startsWith('__convexAuthJWT'));
    } catch {
      return false;
    }
  });
}

/** The Convex auth token, if one is stored. Never printed. */
async function authToken(page) {
  return page.evaluate(() => {
    try {
      const key = Object.keys(window.localStorage).find((name) => name.startsWith('__convexAuthJWT'));
      return key ? window.localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  });
}

/**
 * Runs `work(page)` in a browser carrying the saved session.
 *
 * Unlike the callofstats session there is nothing to repair automatically: a
 * Google login cannot be scripted, so a missing or expired session fails with
 * instructions to run the login command rather than silently scraping a login
 * page. `npm run dragon:login` is the only way to create one.
 */
async function withPage(work, { headless = true } = {}) {
  const pw = requirePlaywright();
  const storageState = readLocalSession();
  if (!storageState) {
    const err = new Error(
      `No DragonStats session at ${SESSION_FILE}. Run: npm run dragon:login (once, in a window, with Google).`,
    );
    err.code = 'NO_SESSION';
    throw err;
  }

  const browser = await pw.chromium.launch({
    headless,
    // Google and this app both look at the automation surface. No
    // `--enable-automation` and the blink flag masked make the browser what
    // it claims to be; the sandbox stays on unless this is a root container,
    // where Chromium refuses to start with it. The user agent is left alone
    // so it matches the engine instead of contradicting
    // `navigator.userAgentData`.
    chromiumSandbox: sandboxEnabled(),
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({
      storageState,
      viewport: { width: 1600, height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    const result = await work(page);
    await saveSession(context);
    return result;
  } finally {
    await browser.close();
  }
}

module.exports = {
  BASE,
  DASHBOARD_URL,
  SESSION_FILE,
  requirePlaywright,
  loadSession: readLocalSession,
  saveSession,
  importSession,
  signedIn,
  authToken,
  withPage,
};
