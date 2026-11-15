/**
 * Mobile layout diagnostic for the leadership pages.
 *
 *   node scripts/test-mobile-layout.js [--base http://localhost:3100] [--code <access code>]
 *
 * Renders the leadership overview and every tab of the player detail at a
 * 375x812 (iPhone-ish) viewport and reports every element that sticks out
 * past the viewport - the "horizontal scrollbar" bugs. Exits non-zero when
 * anything overflows, so it can guard the layout.
 */
const { chromium } = require('playwright');

function argValue(flag, fallback = null) {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const BASE = (argValue('--base', 'http://localhost:3100')).replace(/\/+$/, '');
const CODE = argValue('--code', process.env.ACCESS_CODE || '');
const qs = CODE ? `?code=${encodeURIComponent(CODE)}` : '';

// Runs in the page: elements wider than the viewport, ignoring anything
// inside an explicitly horizontally-scrollable container (tables are allowed
// their own scroll) and collapsing the parent/child cascade so the report
// names the actual offender.
function findOverflow() {
  const vw = document.documentElement.clientWidth;
  const seen = new Set();
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    let parent = el.parentElement;
    let inScroller = false;
    while (parent) {
      const overflowX = getComputedStyle(parent).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') {
        inScroller = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (inScroller) continue;
    if (rect.right > vw + 1 || rect.left < -1) {
      const cls = String(el.className || '').slice(0, 140);
      const key = el.tagName + '.' + cls;
      if (seen.has(key)) continue;
      seen.add(key);
      offenders.push({
        tag: el.tagName,
        cls,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70),
        right: Math.round(rect.right),
      });
    }
  }
  return {
    pageOverflow: document.documentElement.scrollWidth > vw + 1,
    scrollWidth: document.documentElement.scrollWidth,
    viewport: vw,
    offenders: offenders.slice(0, 12),
  };
}

async function check(page, label) {
  const result = await page.evaluate(findOverflow);
  const clean = !result.pageOverflow && result.offenders.length === 0;
  console.log(`${clean ? 'PASS' : 'FAIL'}  ${label} (scrollWidth ${result.scrollWidth} vs viewport ${result.viewport})`);
  if (!clean) {
    for (const o of result.offenders) {
      console.log(`        <${o.tag.toLowerCase()} class="${o.cls}"> right=${o.right} :: ${o.text}`);
    }
  }
  return clean;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  let allClean = true;

  const goto = async (path) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(800);
  };

  try {
    await goto(`/leadership${qs}`);
    await page.waitForSelector('text=Kingdom activity', { timeout: 60000 });
    allClean = (await check(page, 'leadership overview @375')) && allClean;

    await goto(`/leadership/player/25732950${qs}`);
    await page.waitForSelector('text=Leadership profile', { timeout: 60000 });
    allClean = (await check(page, 'player overview @375')) && allClean;

    for (const tab of ['Combat', 'Growth', 'Profile']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await page.waitForTimeout(700);
      allClean = (await check(page, `player ${tab} @375`)) && allClean;
    }

    // And a desktop sanity pass on the busiest tab.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.waitForTimeout(500);
    allClean = (await check(page, 'player profile @1280')) && allClean;
  } catch (err) {
    console.error('DIAGNOSTIC FAILED:', err.message);
    allClean = false;
  } finally {
    await browser.close();
  }

  console.log(allClean ? '\nNo overflow detected.' : '\nOverflow detected.');
  process.exit(allClean ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
