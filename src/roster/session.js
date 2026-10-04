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

/**
 * Every account that may log in, in order.
 *
 * The source refuses service to an account it decides is scraping too hard -
 * the session is invalidated and every page redirects home - so one blocked
 * account must not stop the crawl. Accounts are given as parallel
 * comma-separated lists, either in the plural keys or in the original single
 * ones, so adding a spare needs no code change:
 *
 *   CALLOFSTATS_USERNAME=user1,user2,user3
 *   CALLOFSTATS_PASSWORD=pass1,pass2,pass3
 *
 * Passwords are only split on commas when both lists line up; otherwise a
 * single password that happens to contain a comma stays whole.
 */
function accountList() {
  const split = (value) =>
    String(value || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

  const users = split(process.env.CALLOFSTATS_USERNAMES || process.env.CALLOFSTATS_USERNAME);
  if (!users.length) return [];

  const passwordRaw = String(
    process.env.CALLOFSTATS_PASSWORDS || process.env.CALLOFSTATS_PASSWORD || '',
  ).trim();
  const passwords = split(passwordRaw);

  const aligned =
    passwords.length === users.length
      ? passwords
      : users.length === 1
        ? [passwordRaw]
        : passwords;

  return users
    .map((username, index) => ({ username, password: aligned[index] || '' }))
    .filter((account) => account.password);
}

let accountIndex = 0;

/**
 * Which account is in use, remembered across restarts.
 *
 * The index normally sits at 0, which is fine until that first account gets
 * flagged - at which point every process start would begin by logging in with
 * credentials the source is already turning down, and only reach the working
 * account after a wasted round. The index is written whenever a login
 * succeeds, so a restart resumes on the account that last worked.
 */
const ACCOUNT_INDEX_KEY = 'callofstats_account_index:v1';
let accountIndexLoaded = false;

async function loadAccountIndex() {
  if (accountIndexLoaded) return;
  accountIndexLoaded = true;
  try {
    const prisma = require('../db');
    const row = await prisma.setting.findUnique({ where: { key: ACCOUNT_INDEX_KEY } });
    const parsed = parseInt(row?.value, 10);
    const count = accountCount();
    if (Number.isFinite(parsed) && count > 0) accountIndex = parsed % count;
  } catch {
    // Nothing remembered yet: start at the first account.
  }
}

async function saveAccountIndex() {
  try {
    const prisma = require('../db');
    await prisma.setting.upsert({
      where: { key: ACCOUNT_INDEX_KEY },
      create: { key: ACCOUNT_INDEX_KEY, value: String(accountIndex) },
      update: { value: String(accountIndex) },
    });
  } catch (err) {
    console.warn('[ROSTER] Could not persist the active account:', err.message);
  }
}

function accountCount() {
  return accountList().length;
}

function credentials() {
  const accounts = accountList();
  if (!accounts.length) {
    const err = new Error(
      'CallofStats credentials are not set. Set CALLOFSTATS_USERNAME and CALLOFSTATS_PASSWORD on the bot (comma-separated to list several accounts).',
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return accounts[accountIndex % accounts.length];
}

/** Moves to the next account. Returns null when there is only one to move to. */
function rotateCredentials() {
  const accounts = accountList();
  if (accounts.length < 2) return null;
  accountIndex = (accountIndex + 1) % accounts.length;
  console.log(
    `[ROSTER] Switching to callofstats account ${accountIndex + 1} of ${accounts.length}.`,
  );
  return credentials();
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
  let pw;
  try {
    // Required lazily so a bot without this feature still boots normally.
    pw = require('playwright');
  } catch {
    const err = new Error(
      'Playwright is not installed. Run: npm i playwright && npx playwright install --with-deps chromium',
    );
    err.code = 'NO_PLAYWRIGHT';
    throw err;
  }

  // The library and the browser binary are installed separately, and the
  // binary is what actually costs RAM. Checking here turns "no browser" into a
  // clear, immediate status instead of a confusing launch failure mid-scrape.
  try {
    const exe = pw.chromium.executablePath();
    if (!exe || !fs.existsSync(exe)) throw new Error('browser binary missing');
  } catch {
    const err = new Error(
      'The Chromium binary is not installed. Run: npm run install:browsers (npx playwright install --with-deps chromium).',
    );
    err.code = 'NO_PLAYWRIGHT';
    throw err;
  }

  return pw;
}

/**
 * A page only an authenticated visitor is allowed to see.
 *
 * Kept local rather than imported from v1 to avoid a cycle (v1 requires this
 * module), and it only needs the same server id v1 reads.
 */
function probeUrl() {
  const raw = String(process.env.CALLOFSTATS_SERVER_ID || '').trim();
  const server = /^\d+$/.test(raw) ? raw : '973';
  return `${BASE}/server/${server}`;
}

/**
 * Whether the source sent us to the page we asked for.
 *
 * A session the application has since discarded is answered with a 303 to /,
 * so landing on the target path is the only trustworthy signal. The homepage
 * cannot be used for this: it is public and builds its header from the mere
 * presence of a cookie, so a dead session still looks logged in there. That
 * false negative is why a lapsed session used to go unnoticed and the re-login
 * meant to repair it - and the account switch meant to follow it - never
 * actually happened.
 */
function sessionAccepted(page, target) {
  try {
    return new URL(page.url()).pathname === new URL(target).pathname;
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
  const storageState = (await loadSession()) || undefined;

  const run = async () => {
    await loadAccountIndex();
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

      // Credentials are only demanded when a login is actually needed: a
      // session that is still valid must keep working on its own.
      const loginNow = async () => {
        await login(page, credentials());
        await saveAccountIndex();
      };

      try {
        const target = probeUrl();
        await page.goto(target, { waitUntil: 'domcontentloaded' });
        if (!sessionAccepted(page, target)) {
          console.log('[ROSTER] Session no longer accepted, logging in again.');
          await loginNow();
        }
      } catch (err) {
        // A stale or malformed session should trigger a fresh login, not fail.
        if (err.code === 'BAD_CREDENTIALS') throw err;
        await loginNow();
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

module.exports = {
  withAuthedPage,
  sessionPath,
  loadSession,
  saveSession,
  requirePlaywright,
  rotateCredentials,
  accountCount,
  BASE,
};
