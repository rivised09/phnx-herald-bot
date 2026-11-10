const fs = require('fs');
const { sandboxEnabled } = require('../browser');

/**
 * A real browser window for DragonStats.
 *
 * There is no login any more: DragonStats reads without an account, and the
 * only reason to open a browser is minting the Arcjet "browser gate" token,
 * which refuses headless browsers and plain HTTP clients (403). The launch
 * options below are what makes the browser acceptable to that check - no
 * `--enable-automation`, the automation blink flag masked, and the sandbox
 * left on except in a root container, where Chromium refuses to start.
 *
 * `withPage` therefore runs against a fresh, guest profile: no cookies, no
 * saved session file, nothing to import or refresh.
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
 * Runs `work(page)` in a real browser window and closes it afterwards.
 *
 * `headless: false` is not a preference - Arcjet's bot detection refuses
 * headless outright, so anything that talks to the gate must open a window
 * (on a server: Xvfb provides one).
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
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
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
