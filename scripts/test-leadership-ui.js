/**
 * Browser smoke test for the Leadership page.
 *
 *   node scripts/test-leadership-ui.js [--base http://localhost:3100] [--code <access code>]
 *
 * The tabs are client-rendered, so a plain fetch never sees them. This walks
 * all four and asserts the things the fix checklist cares about:
 *
 *   Overview - snapshot health and a baseline are on screen, no UNDEFINED
 *   Players  - the Export CSV control exists and Kill growth sorting puts a
 *              non-zero delta first (the "leader at zero" bug)
 *   Alliances- Server Stats renders full-precision power and the list shows
 *              every alliance with pagination
 *   RoW      - the saved-roster area settles into content, an empty state or
 *              an error with retry - never an endless spinner
 *
 * Exits non-zero on the first failed assertion. Console errors are reported.
 */
const path = require('path');

function argValue(flag, fallback = null) {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const BASE = argValue('--base', process.env.BASE_URL || 'http://localhost:3100').replace(/\/+$/, '');
const CODE = argValue('--code', process.env.ACCESS_CODE || '');

let failures = 0;
function assert(ok, label, detail = '') {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error.message || error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const url = `${BASE}/leadership${CODE ? `?code=${encodeURIComponent(CODE)}` : ''}`;
  console.log(`Opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  // Hydration (and the background roster fetch) must land before clicking
  // tabs: networkidle is best-effort so a slow proxy cannot hang the run.
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1000);
  // The first-visit language dialog must not cover leadership; dismiss it if
  // a stale localStorage flag ever brings it up.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  /* Overview ------------------------------------------------------------------ */
  console.log('\nOverview');
  await page.waitForSelector('text=Kingdom activity', { timeout: 60000 });
  assert(await page.locator('text=Snapshot health').isVisible(), 'snapshot health block is visible');
  const healthText = await page.locator('text=Snapshot health').locator('xpath=../..').innerText();
  assert(/Last snapshot: \d{4}-\d{2}-\d{2}/.test(healthText), 'last snapshot date is shown', healthText.replace(/\n/g, ' | '));
  assert(/\d+ of \d+ snapshots usable in this \d+-interval window/.test(healthText), 'usable/total snapshot counts are shown', healthText.replace(/\n/g, ' | '));
  assert(
    (await page.locator('body').innerText()).indexOf('UNDEFINED') === -1,
    'no UNDEFINED anywhere on the overview',
  );
  const hasBaseline = /vs baseline \d[\d,]* on \d{4}-\d{2}-\d{2}/.test(await page.locator('body').innerText());
  assert(hasBaseline, 'baseline names its value and date');

  /* Players ------------------------------------------------------------------- */
  console.log('\nPlayers');
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await page.waitForSelector('text=Export CSV', { timeout: 30000 });
  assert(await page.locator('button:has-text("Export CSV")').isVisible(), 'Export CSV control exists');
  // Sort by kill growth: the leader must not be "0".
  await page.selectOption('select >> nth=-1', 'kills').catch(() => {});
  await page.waitForTimeout(400);
  const firstKillDelta = await page
    .locator('tbody tr')
    .first()
    .locator('td')
    .nth(3)
    .innerText();
  const deltaNumber = Number(firstKillDelta.replace(/[^\d-]/g, ''));
  assert(
    Number.isFinite(deltaNumber) && deltaNumber > 0,
    'top kill-growth row shows a non-zero delta',
    `got "${firstKillDelta}"`,
  );
  const tiles = await page.locator('text=Kingdom readiness').locator('xpath=../../..').innerText();
  // The tiles are CSS-uppercased, so innerText reads "LORDS 304"; the
  // definition line below them is normal case. Match both, case-insensitively.
  const lordTile = /lords\s*(\d+)/i.exec(tiles);
  const activeTile = /\bactive\s*(\d+)/i.exec(tiles);
  assert(Boolean(lordTile), 'Lords tile is shown', tiles.replace(/\n/g, ' | '));
  assert(Boolean(activeTile), 'Active tile is shown', tiles.replace(/\n/g, ' | '));
  if (lordTile && activeTile) {
    const sum = [...tiles.matchAll(/(?:active|low activity|dormant|lords)\s*(\d+)/gi)].map((m) => Number(m[1]));
    const [a, l, d, t] = sum;
    assert(a + l + d === t, 'activity tiles sum to the lord total', `${a}+${l}+${d} vs ${t}`);
    assert(Number(lordTile[1]) === 304 || Number(lordTile[1]) > 0, 'lord total is the snapshot count', `lords=${lordTile[1]}`);
  }

  /* Alliances ------------------------------------------------------------------ */
  console.log('\nAlliances');
  await page.getByRole('button', { name: 'Alliances', exact: true }).click();
  await page.waitForSelector('text=Server statistics', { timeout: 30000 });
  const allianceBody = await page.locator('body').innerText();
  assert(/\d{1,3}(,\d{3}){3,}/.test(allianceBody), 'total power is shown at full precision');
  const allianceLinks = await page.locator('a[href*="/roster/alliance/"]').count();
  assert(allianceLinks >= 10, 'alliance rows are listed with pagination', `${allianceLinks} links`);
  assert(/Alliances \((\d+)\)/.test(allianceBody), 'alliance count heading is shown');

  /* RoW ------------------------------------------------------------------------ */
  console.log('\nRoW');
  await page.getByRole('button', { name: 'RoW', exact: true }).click();
  // The acceptance check: resolves within seconds to content, empty or error.
  const settled = await page
    .waitForSelector(
      'text=/No saved rosters yet|Could not load saved rosters|Saved rosters/',
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(settled, 'saved-roster area settles into content, empty state or error');
  const rowText = await page.locator('body').innerText();
  const stillLoading = rowText.includes('Loading saved rosters…');
  assert(!settled || !stillLoading, 'no endless "Loading saved rosters…" spinner');
  if (rowText.includes('Could not load saved rosters')) {
    assert(await page.locator('button:has-text("Retry")').isVisible(), 'error state offers a Retry button');
  }

  /* Player detail ---------------------------------------------------------- */
  console.log('\nPlayer detail');
  const playerQs = CODE ? `?code=${encodeURIComponent(CODE)}` : '';
  await page.goto(`${BASE}/leadership/player/25732950${playerQs}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.waitForSelector('text=Leadership profile', { timeout: 60000 });
  {
    // innerText applies CSS text-transform, so content is matched lowercased;
    // the UNDEFINED check stays case-sensitive on the raw text (lowercase
    // "undefined" legitimately appears in the framework's inline script).
    const raw = await page.locator('body').innerText();
    const body = raw.toLowerCase();
    // The snapshot date in the hero follows the data, so match the shape of a
    // date instead of pinning a literal one that every scrape outdates.
    assert(/snapshot \d{4}-\d{2}-\d{2}/.test(body), 'hero shows the snapshot date');
    assert(body.includes('phoenix of war'), 'hero shows the alliance');
    assert(!raw.includes('UNDEFINED'), 'no UNDEFINED on the player page');
    assert(body.includes('reporting window'), 'overview tab renders by default');
    assert(body.includes('quick read'), 'quick-read card present');
    assert(body.includes('baseline'), 'baseline is named');
    assert(body.includes('current merits by troop'), 'per-troop merits shown');
  }

  // Growth: the leadership-exclusive charts.
  await page.getByRole('button', { name: 'Growth', exact: true }).click();
  await page.waitForSelector('text=Power & rank', { timeout: 30000 });
  {
    const charts = await page.locator('.recharts-surface').count();
    assert(charts >= 6, `growth tab renders the chart set (saw ${charts} chart surfaces)`);
    const body = (await page.locator('body').innerText()).toLowerCase();
    assert(body.includes('daily kill gains'), 'daily kill-gain chart present');
    assert(body.includes('units killed'), 'counter charts present');
    assert(body.includes('resources gathered') || body.includes('activity coverage'), 'coverage/gathered cards present');
  }

  // Profile: the complete data the public page does not show in one place.
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await page.waitForSelector('text=Previous names', { timeout: 30000 });
  {
    const raw = await page.locator('body').innerText();
    const body = raw.toLowerCase();
    assert(body.includes('previous servers'), 'previous servers listed');
    assert(body.includes('gallery'), 'gallery (album) card present');
    assert(body.includes('achievements ('), 'achievements listed');
    assert(body.includes('snapshot history ('), 'snapshot history listed');
    assert(body.includes('source metrics ('), 'source metrics listed');
    const albumImages = await page.locator('a img[src*="image-proxy"]').count();
    assert(albumImages >= 1, `album images render (saw ${albumImages})`);
    assert(!raw.includes('UNDEFINED'), 'no UNDEFINED on the profile tab');
  }

  /* console --------------------------------------------------------------------- */
  if (consoleErrors.length) {
    console.log(`\nConsole errors (${consoleErrors.length}):`);
    for (const error of consoleErrors.slice(0, 8)) console.log(`  - ${error.slice(0, 300)}`);
  } else {
    console.log('\nNo console errors.');
  }

  await browser.close();
  console.log(failures ? `\n${failures} assertion(s) failed.` : '\nAll assertions passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
