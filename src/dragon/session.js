const fs = require('fs');
const { sandboxEnabled } = require('../browser');

/**
 * A real browser for DragonStats.
 *
 * There is no login any more: DragonStats reads without an account, and the
 * only browser use is minting the Arcjet "browser gate" token, which refuses
 * plain HTTP clients (403) and browsers that announce themselves as headless.
 * The launch options below - plus a UA without the HeadlessChrome token when
 * running headless - are what makes the browser acceptable to that check.
 *
 * `withPage` therefore runs against a fresh, guest profile: no cookies, no
 * saved session file, nothing to import or refresh, and no display required.
 */
const BASE = process.env.DRAGONSTATS_BASE_URL || 'https://dragonstats.com';
const DASHBOARD_URL = `${BASE}/dashboard`;

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
    err.code = 'NO_BROWSER';
    throw err;
  }

  return pw;
}

/**
 * The browser's own platform-correct Chrome UA with the `HeadlessChrome`
 * token removed.
 *
 * Arcjet's gate endpoint rejects a browser that announces itself as headless
 * (the default Playwright UA contains "HeadlessChrome" -> 403) but accepts the
 * same headless browser with this UA - verified by probe: same launch, same
 * everything, only the UA differs, and the gate plus a full scan listing come
 * back. The platform and major version stay exactly what the browser really
 * is, so nothing else about the fingerprint changes.
 */
function cleanHeadlessUserAgent(browser) {
  // Playwright exposes this as a string (a promise in a few versions).
  const raw = browser.version();
  const version = typeof raw === 'string' ? raw : String(raw);
  const platform =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/**
 * Runs `work(page)` in a real browser window and closes it afterwards.
 *
 * Headless is the default and works for the gate (see the UA note above), so
 * a server needs no display; `headless: false` opens a real window, which is
 * the fallback when the headless mint is refused.
 */
async function withPage(work, { headless = true } = {}) {
  const pw = requirePlaywright();
  const browser = await pw.chromium.launch({
    headless,
    chromiumSandbox: sandboxEnabled(),
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      ...(headless ? { userAgent: cleanHeadlessUserAgent(browser) } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    return await work(page);
  } finally {
    await browser.close();
  }
}

/**
 * Whether the browser is signed in - kept as a diagnostic for the probe
 * script; nothing in the scrape path depends on it.
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

module.exports = {
  BASE,
  DASHBOARD_URL,
  requirePlaywright,
  withPage,
  signedIn,
};
