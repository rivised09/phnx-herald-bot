/**
 * One-time DragonStats login.
 *
 *   npm run dragon:login
 *
 * Opens a real browser window on the dashboard and waits while you sign in
 * with Google. Nothing is typed by this script and no Google password is ever
 * asked for or stored: when the app has a Convex auth token, the browser state
 * is saved and every later run reuses it.
 *
 * It prefers the installed Google Chrome over Playwright's bundled Chromium,
 * keeping a real profile under data/. Google refuses sign-in from a browser it
 * recognises as automated, and a profile with history is what makes the flow
 * behave like the one you would do by hand.
 */
const path = require('path');

const session = require('../src/dragon/session');
const { sandboxEnabled } = require('../src/browser');

const TIMEOUT_MINUTES = Number(
  (process.argv.find((arg) => arg.startsWith('--timeout=')) || '').split('=')[1] || 15,
);

const PROFILE_DIR = path.join(__dirname, '..', 'data', 'dragonstats-profile');

/**
 * Where Brave lives on Windows.
 *
 * Brave is the preferred browser for the login: Google refuses sign-in from a
 * browser it recognises as automated, and Brave is both a real, trusted
 * Chromium and the browser already in use here. The profile is a separate
 * Playwright one under data/, so it never collides with the daily Brave
 * profile that is already open.
 */
function installedBrave() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  for (const root of roots) {
    if (!root) continue;
    const candidate = path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
    if (require('fs').existsSync(candidate)) return candidate;
  }
  return null;
}

function describe(state) {
  const cookies = Array.isArray(state.cookies) ? state.cookies.length : 0;
  const items = Array.isArray(state.origins)
    ? state.origins.reduce((sum, origin) => sum + (origin.localStorage || []).length, 0)
    : 0;
  return `${cookies} cookies, ${items} localStorage entries`;
}

/**
 * Launch options that Google accepts.
 *
 * Playwright quietly disables the Chromium sandbox and marks the session as
 * automated; Google reads both and refuses the sign-in with "This browser or
 * app may not be secure". A real Brave with the sandbox on (except in a root
 * container, where Chromium refuses to start), no `--enable-automation` and
 * `navigator.webdriver` masked looks like the browser the user opened by hand,
 * which is what it is.
 */
function launchOptions(extra = {}) {
  return {
    headless: false,
    viewport: { width: 1500, height: 950 },
    // Chromium cannot start as root with the sandbox on, which is how the
    // container hosts run it. On a desktop the sandbox stays enabled.
    chromiumSandbox: sandboxEnabled(),
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    ...extra,
  };
}

async function openBrowser(pw) {
  const brave = installedBrave();
  if (brave) {
    try {
      const context = await pw.chromium.launchPersistentContext(PROFILE_DIR, launchOptions({ executablePath: brave }));
      console.log('[DRAGON] Using Brave.');
      return context;
    } catch (err) {
      console.log(`[DRAGON] Brave did not start (${err.message.split('\n')[0]}), trying another browser.`);
    }
  }

  for (const [channel, label] of [
    ['chrome', 'Google Chrome'],
    ['msedge', 'Microsoft Edge'],
  ]) {
    try {
      const context = await pw.chromium.launchPersistentContext(PROFILE_DIR, launchOptions({ channel }));
      console.log(`[DRAGON] Using ${label}.`);
      return context;
    } catch {
      continue;
    }
  }
  const context = await pw.chromium.launchPersistentContext(PROFILE_DIR, launchOptions());
  console.log('[DRAGON] No installed browser found, using the bundled Chromium.');
  return context;
}

(async () => {
  const pw = session.requirePlaywright();
  const context = await openBrowser(pw);
  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();

  await page.bringToFront();
  console.log('');
  console.log('[DRAGON] Sign in with Google in the window that just opened.');
  console.log('[DRAGON] This process waits up to %d minutes, saves the session, and closes the window.', TIMEOUT_MINUTES);
  console.log('');

  await page.goto(session.DASHBOARD_URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + TIMEOUT_MINUTES * 60 * 1000;
  const loginStart = Date.now();
  let fresh = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (page.isClosed()) break;
    const token = await session.authToken(page).catch(() => null);
    if (token) {
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        // Accept a JWT issued within the last minute (allows for clock skew).
        if (payload.iat && payload.iat * 1000 > loginStart - 60000) {
          fresh = true;
          break;
        }
      } catch {}
    }
  }

  if (!fresh) {
    console.log('[DRAGON] No fresh session was created. Run the command again when you can finish the Google sign-in.');
    await context.close();
    process.exitCode = 1;
    return;
  }

  // Let the app finish writing its token after the redirect from Google.
  await page.waitForTimeout(2000);
  const state = await context.storageState({ path: session.SESSION_FILE });
  state.savedAt = Date.now();
  require('fs').mkdirSync(path.dirname(session.SESSION_FILE), { recursive: true });
  require('fs').writeFileSync(session.SESSION_FILE, JSON.stringify(state));

  console.log(`[DRAGON] Session saved to ${path.relative(process.cwd(), session.SESSION_FILE)} (${describe(state)}).`);
  console.log('[DRAGON] Next: npm run dragon:probe');
  await context.close();
})().catch((err) => {
  console.error(`[DRAGON] Login failed: ${err.message}`);
  process.exitCode = 1;
});
