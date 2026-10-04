const fs = require('fs');
const path = require('path');

/**
 * Persistent CallOfStats login.
 *
 * The site gates server pages behind a 303 to /login, so a scrape needs an
 * authenticated browser context. This logs in once and then persists the
 * browser storage state (cookies + localStorage) to disk, so subsequent runs
 * reuse the existing tokens instead of logging in again.
 *
 * The session file holds real credentials' output - tokens - and is gitignored.
 */

const BASE = process.env.CALLOFSTATS_BASE_URL || 'https://callofstats.com';
const LOGIN_URL = `${BASE}/login`;

const SESSION_FILE =
  process.env.CALLOFSTATS_SESSION_FILE ||
  path.join(__dirname, '..', '..', 'data', 'callofstats-session.json');

const NAV_TIMEOUT_MS = 30000;
const LOGIN_TIMEOUT_MS = 30000;

/** Serialises scrapes so a burst of visitors launches one browser, not many. */
let queue = Promise.resolve();

function credentials() {
  const username = String(process.env.CALLOFSTATS_USERNAME || '').trim();
  const password = String(process.env.CALLOFSTATS_PASSWORD || '');
  if (!username || !password) {
    const err = new Error(
      'CallofStats credentials are not set. Set CALLOFSTATS_USERNAME and CALLOFSTATS_PASSWORD on the bot.',
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return { username, password };
}

/**
 * Railway's filesystem is ephemeral, so a token file alone would be wiped on
 * every redeploy and force a login each time. Tokens are therefore written to
 * the settings table as well; the file is kept as a local/dev fallback.
 */
const SESSION_KEY = 'callofstats_session:v1';

function readLocalSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    // A corrupt session file should not block a fresh login.
    return null;
  }
}

async function loadSession() {
  try {
    const prisma = require('../db');
    const row = await prisma.setting.findUnique({ where: { key: SESSION_KEY } });
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (parsed && Array.isArray(parsed.cookies)) return parsed;
    }
  } catch (err) {
    console.warn('[ROSTER] Session DB read failed, using local file:', err.message);
  }
  return readLocalSession();
}

async function saveSession(context) {
  let state;
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    state = await context.storageState({ path: SESSION_FILE });
  } catch (err) {
    console.warn('[ROSTER] Could not persist session file:', err.message);
    return false;
  }

  try {
    const prisma = require('../db');
    const value = JSON.stringify(state);
    await prisma.setting.upsert({
      where: { key: SESSION_KEY },
      create: { key: SESSION_KEY, value },
      update: { value },
    });
  } catch (err) {
    // Not fatal - the local copy still short-circuits logins in dev.
    console.warn('[ROSTER] Could not persist session to database:', err.message);
  }
  return true;
}

function requirePlaywright() {
  try {
    // Required lazily so a bot without this feature still boots normally.
    return require('playwright');
  } catch {
    const err = new Error(
      'Playwright is not installed. Run: npm i playwright && npx playwright install --with-deps chromium',
    );
    err.code = 'NO_PLAYWRIGHT';
    throw err;
  }
}

/** True when the page shows the logged-out entry points. */
async function isLoggedOut(page) {
  const link = page.locator('a[href="/login"]').first();
  try {
    await link.waitFor({ state: 'attached', timeout: 4000 });
    return await link.isVisible();
  } catch {
    return false;
  }
}

async function login(page, { username, password }) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT_MS });

  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT_MS }).catch(() => {}),
    page.click('button[type="submit"]').catch(() => page.click('form button')),
  ]);

  if ((page.url() || '').includes('/login')) {
    const err = new Error('CallofStats rejected the credentials (still on the login page).');
    err.code = 'BAD_CREDENTIALS';
    throw err;
  }
}

/**
 * Runs `work(page)` against an authenticated page.
 *
 * Order: reuse saved tokens when present, fall back to a fresh login when they
 * have expired, and always persist whatever tokens we end up with.
 */
async function withAuthedPage(work) {
  const pw = requirePlaywright();
  const creds = credentials();
  const storageState = (await loadSession()) || undefined;

  const run = async () => {
    const browser = await pw.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        storageState,
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

      try {
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

        if (await isLoggedOut(page)) {
          console.log('[ROSTER] Session expired, logging in again.');
          await login(page, creds);
        }
      } catch (err) {
        // A stale or malformed session should trigger a fresh login, not fail.
        if (err.code === 'BAD_CREDENTIALS') throw err;
        await login(page, creds);
      }

      const result = await work(page);
      await saveSession(context);
      return result;
    } finally {
      await browser.close();
    }
  };

  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

function sessionPath() {
  return SESSION_FILE;
}

module.exports = { withAuthedPage, sessionPath, loadSession, saveSession, BASE };
