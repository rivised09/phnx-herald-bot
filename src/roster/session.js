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

/** Whether fetching and logging in should go through the Python sidecar. */
function sidecarEnabled() {
  return require('./sidecar').enabled();
}

/**
 * Whether the sidecar answers, checked once per process.
 *
 * A machine without Python must still be able to log in, so a sidecar that
 * cannot start falls back to the browser login instead of burning every
 * configured account on connection errors that look like refusals.
 */
let sidecarProbe = null;
function sidecarUsable() {
  if (!sidecarEnabled()) return Promise.resolve(false);
  if (!sidecarProbe) {
    sidecarProbe = require('./sidecar')
      .request('ping', {}, 15000)
      .then(() => true)
      .catch((err) => {
        console.warn('[ROSTER] Sidecar unavailable, falling back to the browser login:', err.message);
        return false;
      });
  }
  return sidecarProbe;
}

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

/**
 * Writes a storage-state object (the shape `context.storageState()` returns)
 * to the session file and the settings table.
 *
 * Split out from `saveSession` so a login that happened outside the browser -
 * the Python sidecar fills the form in its own stealth browser - can persist
 * its cookies the same way without a Playwright context to ask.
 */
async function persistSessionState(state) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state));
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

async function saveSession(context) {
  let state;
  try {
    state = await context.storageState({ path: SESSION_FILE });
  } catch (err) {
    console.warn('[ROSTER] Could not persist session file:', err.message);
    return false;
  }
  state.savedAt = Date.now();
  return persistSessionState(state);
}

/** Cookie names and ages for the log; values are tokens and never printed. */
function describeCookies(state) {
  if (!state || !Array.isArray(state.cookies)) return 'no session';
  const bits = [];
  if (state.savedAt) bits.push(`saved ${Math.round((Date.now() - state.savedAt) / 60000)}m ago`);
  for (const cookie of state.cookies) {
    if (cookie.name !== 'cf_clearance' && cookie.name !== 'session_token') continue;
    const expires = Number(cookie.expires);
    const left =
      Number.isFinite(expires) && expires > 0
        ? `${Math.round((expires * 1000 - Date.now()) / 60000)}m left`
        : 'expiry unset';
    bits.push(`${cookie.name} ${left}`);
  }
  if (bits.length && !state.cookies.some((c) => c.name === 'cf_clearance')) bits.push('no cf_clearance');
  return bits.join(', ') || 'no cookies';
}

/**
 * Whether the Cloudflare clearance cookie is present and when it lapses.
 *
 * `minutesLeft` is null when the expiry is unknown (a session-scoped cookie),
 * which is deliberately different from the cookie being absent: an unknown
 * expiry must not trigger renewals on every call.
 */
function clearanceState(state) {
  const cookie =
    state && Array.isArray(state.cookies)
      ? state.cookies.find((entry) => entry.name === 'cf_clearance')
      : null;
  if (!cookie) return { present: false, minutesLeft: null };
  const expires = Number(cookie.expires);
  const known = Number.isFinite(expires) && expires > 0;
  return { present: true, minutesLeft: known ? (expires * 1000 - Date.now()) / 60000 : null };
}

function envMinutes(name, fallback, minimum = 0) {
  const parsed = parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

/** Minutes of clearance left that should trigger a renewal. */
const clearanceRefreshMinutes = () => envMinutes('ROSTER_CLEARANCE_REFRESH_MINUTES', 5);

/** Force a renewal after this much age; 0 keeps renewal clearance-driven. */
const sessionMaxAgeMinutes = () => envMinutes('ROSTER_SESSION_MAX_AGE_MINUTES', 0);

/** No more than one renewal per window, whatever the reason reported. */
const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastRefreshAt = 0;

/**
 * Renews the session before Cloudflare's clearance lapses.
 *
 * `cf_clearance` is what makes a plain HTTP read acceptable to Cloudflare and
 * it is issued with a short lifetime (the source's own refusal cooldown is 30
 * minutes, the same window). Once it runs out the next fetch is challenged and
 * the crawl reads that as "the session died" - which then walks the account
 * rotation ladder over what is only an expired cookie, burning accounts that
 * were never refused. Renewing on the clock keeps one account usable instead.
 *
 * A renewal is a successful login, not a refusal: it never rotates accounts.
 */
async function refreshSessionIfNeeded(reason = '') {
  if (!sidecarEnabled()) return { refreshed: false, why: 'sidecar off' };
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
    return { refreshed: false, why: 'renewed within the last 5 minutes' };
  }

  const state = await loadSession();
  if (!state || !Array.isArray(state.cookies) || !state.cookies.length) {
    return { refreshed: false, why: 'no stored session' };
  }

  const clearance = clearanceState(state);
  const ageMinutes = state.savedAt ? (now - state.savedAt) / 60000 : null;
  const maxAge = sessionMaxAgeMinutes();

  let why = null;
  if (!clearance.present) why = 'cf_clearance missing';
  else if (clearance.minutesLeft !== null && clearance.minutesLeft <= clearanceRefreshMinutes()) {
    why = `cf_clearance expires in ${Math.max(0, Math.round(clearance.minutesLeft))}m`;
  } else if (maxAge > 0 && ageMinutes !== null && ageMinutes >= maxAge) {
    why = `session is ${Math.round(ageMinutes)}m old`;
  }

  if (!why) {
    // The state the run is starting from - age and clearance time left - is
    // what tells a "session expired" report apart from an account refusal.
    const current = describeCookies(state);
    console.log(`[ROSTER] Session state: ${current}.`);
    return { refreshed: false, why: current };
  }

  lastRefreshAt = now;
  try {
    const { cookies } = await sidecarLogin(credentials());
    await persistSessionState({ cookies, savedAt: Date.now() });
    console.log(`[ROSTER] Session renewed (${why})${reason ? ` for ${reason}` : ''}.`);
    return { refreshed: true, why };
  } catch (err) {
    console.warn(`[ROSTER] Session renewal failed (${why}): ${err.message}`);
    return { refreshed: false, why: `renewal failed: ${err.message}` };
  }
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

async function protectedPageAccepted(page, target) {
  if (!sessionAccepted(page, target)) return false;
  const title = (await page.title().catch(() => '')).toLowerCase();
  return !title.includes('email verification') && !title.includes('access denied');
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

/** Lowercased page title read out of a raw HTML document. */
function pageTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return match ? match[1].replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

/**
 * Fills the login form through the sidecar and returns the fresh cookies.
 *
 * Kept separate from the probe so a plain renewal (nothing to hand a browser
 * context to) can reuse it: renewing the session must not count as an account
 * refusal, because it is the refusal path that walks through the accounts.
 */
async function sidecarLogin({ username, password }) {
  const sidecar = require('./sidecar');
  const result = await sidecar.request(
    'login',
    { loginUrl: LOGIN_URL, username, password, timeoutMs: LOGIN_TIMEOUT_MS },
    LOGIN_TIMEOUT_MS + 15000,
  );

  const cookies = Array.isArray(result.cookies) ? result.cookies : [];
  if (String(result.url || '').includes('/login') || !cookies.length) {
    const err = new Error('CallofStats rejected the credentials (still on the login page).');
    err.code = 'BAD_CREDENTIALS';
    throw err;
  }
  return { cookies, url: String(result.url || '') };
}

/**
 * Logs in through the Python sidecar and proves the session works.
 *
 * The form is filled in Scrapling's stealth browser (patched fingerprints,
 * no Playwright markers) and the cookies that come back are handed to the
 * local Playwright context so `work(page)` sees an authenticated session,
 * then persisted so plain HTTP reads pick them up too.
 *
 * The protected-route probe runs over the sidecar's impersonated HTTP fetch
 * rather than a browser navigation: if the source has learned to refuse this
 * machine's automation, doing the check with the same transport the crawl
 * uses is the only honest answer to "is this session usable?".
 */
async function loginViaSidecar(context, credentials) {
  const { fetchHtml, looksLikeLogin } = require('./http');

  const { cookies } = await sidecarLogin(credentials);

  await persistSessionState({ cookies, savedAt: Date.now() });
  try {
    await context.addCookies(cookies);
  } catch (err) {
    console.warn('[ROSTER] Could not hand the new cookies to the browser:', err.message);
  }

  // The probe has to carry the cookies it just received: `fetchHtml` sends no
  // Cookie header unless it is handed one, so reading the session back would
  // only prove that an anonymous visitor is bounced to /login.
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const target = probeUrl();
  const probe = await fetchHtml(target, { cookie });
  const title = pageTitle(probe.html);
  const denied = title.includes('email verification') || title.includes('access denied');

  if (probe.authExpired || !probe.ok || looksLikeLogin(probe.html) || denied) {
    // The distinction matters for the accounts: a bounce to /login or / after
    // a successful form submission is the source refusing that account's
    // protected routes (the same thing a human sees in a browser), while a
    // challenge page means the clearance never took.
    console.warn(
      `[ROSTER] Probe after login failed: status=${probe.status} challenge=${Boolean(probe.challenge)} ` +
        `url=${probe.url} title="${title}" cookies=${describeCookies({ cookies })}`,
    );
    const err = new Error(
      `CallOfStats accepted the form but the protected server route is unavailable (page title: "${title}", url: ${probe.url}).`,
    );
    err.code = 'SOURCE_ACCESS_DENIED';
    throw err;
  }
  if (probe.challenge) {
    console.warn(`[ROSTER] Probe after login hit a challenge page (${probe.url}); cookies may be short-lived.`);
  }
}

/**
 * Runs `work(page)` against an authenticated page.
 *
 * Order: reuse saved tokens when present, fall back to a fresh login when they
 * have expired, and always persist whatever tokens we end up with.
 */
/**
 * The identity of a page, for deciding whether the source redirected us.
 *
 * Origin plus path, ignoring a trailing slash: "/server/973" and
 * "/server/973/" are the same landing, while "/server/973" and "/" are not -
 * which is the one difference a lapsed session makes.
 */
function pageKey(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(value);
  }
}

/** One process-wide note, so only the first browser session speaks for them all. */
let routedTransportLogged = false;

/**
 * Hands every main-frame navigation on `page` to the sidecar and blocks the rest.
 *
 * The readers still run against a real DOM, but the document that DOM is built
 * from is fetched by Scrapling with a Chrome TLS fingerprint, so the source
 * never sees Playwright's. Three rules make that safe:
 *
 *  - Subresources (scripts, styles, images, XHR) are aborted before they leave
 *    the machine. Everything the extractors read ships in the HTML itself, and
 *    letting them through would put the Playwright fingerprint back on the
 *    wire - the exact surface this exists to remove.
 *  - A source redirect is replayed as the browser's own 303, so `page.url()`
 *    still shows where the source actually sent us. Session expiry is detected
 *    from the landing URL; flattening the redirect into a fulfilled page would
 *    hide it and let a bounced page be parsed as roster data.
 *  - Anything the sidecar cannot fetch falls back to letting the browser fetch
 *    it directly: availability over purity, warned once. The same fallback
 *    covers a sidecar that dies mid-crawl.
 */
async function installRoutedTransport(page) {
  if (!routedTransportLogged) {
    routedTransportLogged = true;
    console.log('[ROSTER] Navigation through the sidecar; subresources stay on this machine.');
  }
  let warned = false;

  await page.route('**/*', async (route) => {
    const request = route.request();
    try {
      const main =
        request.resourceType() === 'document' &&
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame();
      if (!main) {
        await route.abort();
        return;
      }
      // Only GET documents are ours to fetch: the login form posts through the
      // browser, and the login page itself is the one navigation the browser
      // login flow needs in its own transport.
      const target = new URL(request.url());
      if (request.method() !== 'GET' || target.pathname.startsWith('/login')) {
        await route.continue();
        return;
      }

      const { fetchForRoute, cookieHeader } = require('./http');
      // The cookies the context would have sent, with the saved session as the
      // fallback for an empty jar.
      const cookie = request.headers().cookie || (await cookieHeader());
      const res = await fetchForRoute(request.url(), { cookie });

      if (res.redirectLoop) {
        await route.abort();
        return;
      }
      if (pageKey(res.url) !== pageKey(request.url())) {
        await route.fulfill({ status: 303, headers: { location: res.url }, body: '' });
        return;
      }
      if (res.challenge) {
        console.warn(`[ROSTER] The sidecar returned a challenge page for ${target.pathname}.`);
      }
      await route.fulfill({
        status: res.status,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: res.html,
      });
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn('[ROSTER] Sidecar navigation failed, letting the browser fetch directly:', err.message);
      }
      await route.continue().catch(() => {});
    }
  });
}

async function withAuthedPage(work) {
  const pw = requirePlaywright();
  // Renew first when the clearance is about to lapse, so the browser context
  // below is built from cookies that still work instead of being launched
  // with a session the next probe would reject.
  await refreshSessionIfNeeded('browser session');
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

      // With the sidecar answering, the browser is only the DOM: documents
      // come from Scrapling and nothing else leaves the machine. Installed
      // before the first navigation, so the session probe is covered too.
      if (await sidecarUsable()) {
        await installRoutedTransport(page);
      }

      // Credentials are only demanded when a login is actually needed: a
      // session that is still valid must keep working on its own.
      const loginNow = async () => {
        const total = accountCount();
        const useSidecar = await sidecarUsable();
        let lastError;

        for (let attempt = 0; attempt < Math.max(1, total); attempt += 1) {
          try {
            if (useSidecar) {
              // Login, persistence and the protected-route probe all happen
              // through the sidecar; the browser is only handed the cookies.
              await loginViaSidecar(context, credentials());
            } else {
              await login(page, credentials());
              // A successful form submission commonly lands on the public home
              // page. Probe the protected server route before accepting cookies.
              const target = probeUrl();
              await page.goto(target, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT_MS });
              if (!(await protectedPageAccepted(page, target))) {
                const err = new Error(
                  `CallOfStats accepted the form but the protected server route is unavailable (page title: "${await page.title()}").`,
                );
                err.code = 'SOURCE_ACCESS_DENIED';
                throw err;
              }
            }
            await saveAccountIndex();
            return;
          } catch (err) {
            lastError = err;
            if (attempt + 1 >= total) break;
            rotateCredentials();
          }
        }

        throw lastError || new Error('No CallOfStats account is configured.');
      };

      try {
        const target = probeUrl();
        await page.goto(target, { waitUntil: 'domcontentloaded' });
        if (!(await protectedPageAccepted(page, target))) {
          console.log('[ROSTER] Session no longer accepted, logging in again.');
          console.log('[ROSTER] Session state:', describeCookies(storageState));
          await loginNow();
        }
      } catch (err) {
        // A stale or malformed session should trigger a fresh login, not fail.
        if (err.code === 'BAD_CREDENTIALS' || err.code === 'SOURCE_ACCESS_DENIED') throw err;
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
  installRoutedTransport,
  sessionPath,
  loadSession,
  saveSession,
  requirePlaywright,
  rotateCredentials,
  accountCount,
  refreshSessionIfNeeded,
  BASE,
};
