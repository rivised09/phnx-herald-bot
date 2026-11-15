/**
 * Screenshots the leadership pages at mobile width so layout problems can be
 * reviewed by eye (fullPage, one file per tab).
 *
 *   node scripts/shoot-mobile.js [--base http://localhost:3100] [--code <code>] [--out ./mobile-shots]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function argValue(flag, fallback = null) {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const BASE = (argValue('--base', 'http://localhost:3100')).replace(/\/+$/, '');
const CODE = argValue('--code', process.env.ACCESS_CODE || '');
const OUT = path.resolve(argValue('--out', path.join(__dirname, '..', 'data', 'mobile-shots')));
const qs = CODE ? `?code=${encodeURIComponent(CODE)}` : '';

/**
 * Chromium hands Playwright the previous compositor frame when a screenshot
 * lands right after a tab switch (verified: DOM says Profile, pixels say
 * Growth). A double-rAF with a tiny opacity nudge forces a fresh paint.
 */
async function forceRepaint(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          document.body.style.opacity = '0.999';
          requestAnimationFrame(() => {
            document.body.style.opacity = '';
            requestAnimationFrame(() => resolve());
          });
        });
      }),
  );
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });

  const goto = async (p) => {
    await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(800);
  };

  await goto(`/leadership${qs}`);
  await page.waitForSelector('text=Kingdom activity', { timeout: 60000 });
  await forceRepaint(page);
  await page.screenshot({ path: path.join(OUT, 'leadership-overview.png'), fullPage: true });

  await goto(`/leadership/player/25732950${qs}`);
  await page.waitForSelector('text=Leadership profile', { timeout: 60000 });
  await forceRepaint(page);
  await page.screenshot({ path: path.join(OUT, 'player-overview.png'), fullPage: true });

  for (const tab of ['Combat', 'Growth', 'Profile']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    // Wait for the tab's own content, not a fixed delay - a slow compile can
    // swallow a timed screenshot and shoot the previous tab.
    const marker =
      tab === 'Combat' ? 'text=War stats' : tab === 'Growth' ? 'text=Power & rank' : 'text=Source metrics';
    await page.waitForSelector(marker, { timeout: 30000 });
    await forceRepaint(page);
    await page.screenshot({ path: path.join(OUT, `player-${tab.toLowerCase()}.png`), fullPage: true });
  }

  await browser.close();
  console.log('shots written to', OUT);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
