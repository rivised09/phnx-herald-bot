// Verifies the three leadership fixes:
//   1. overview window language is consistent (7 intervals, labelled snapshots)
//   2. a player who left the roster still has a detail page (no 404)
//   3. decision reports render with their ranked lists
const { chromium } = require('playwright');

function argValue(flag, fallback = null) {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const BASE = (argValue('--base', 'http://localhost:3100')).replace(/\/+$/, '');
const CODE = argValue('--code', process.env.ACCESS_CODE || '');
const qs = CODE ? `?code=${encodeURIComponent(CODE)}` : '';
const sep = CODE ? '&' : '?';

let passed = 0;
let failed = 0;
function check(ok, label, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  /* 1. Overview window language ---------------------------------------- */
  console.log('Overview window language');
  await page.goto(`${BASE}/leadership${qs}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForSelector('text=Kingdom activity', { timeout: 60000 });

  const overview = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      badge: (text.match(/(\d+)\s+intervals/i) || [])[1] || null,
      saysDaysBadge: /\b8\s+DAYS\b/i.test(text),
      snapshotsWorded: /usable snapshots/i.test(text),
      hasIntervalWindow: /-interval window/i.test(text),
    };
  });
  check(overview.badge === '7', 'trend badge shows 7 intervals', `got "${overview.badge}"`);
  check(!overview.saysDaysBadge, 'no bare "8 DAYS" badge left');
  check(overview.snapshotsWorded, 'health line says "usable snapshots"');
  check(overview.hasIntervalWindow, 'snapshot card names the 7-interval window');

  /* 2 + 3. Decision reports --------------------------------------------- */
  console.log('Decision reports');
  const reports = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    return {
      heading: text.includes('what needs a decision this window'),
      alliance: text.includes('alliance power balance'),
      atRisk: text.includes('high power, low activity'),
      movers: text.includes('power movers'),
      warForm: text.includes('war form'),
      contribution: text.includes('contribution this window'),
      allianceRows: [...document.querySelectorAll('table tbody tr')].length,
    };
  });
  check(reports.heading, 'decision-support section heading present');
  check(reports.alliance, 'alliance power balance block present');
  check(reports.atRisk, 'high-power/low-activity block present');
  check(reports.movers, 'power movers block present');
  check(reports.warForm, 'war form block present');
  check(reports.contribution, 'contribution block present');
  check(reports.allianceRows >= 3, `alliance table has rows (${reports.allianceRows})`);

  /* 2. Player whose snapshot window predates the roster ------------------ */
  console.log('Departed player detail (was a 404)');
  // Find a player who exists in an older pinned window but not the latest one
  // (fetched from Node - the page context cannot read the data origin: CORS).
  let departedId = null;
  let departedDate = null;
  try {
    const origin = process.env.ROSTER_ORIGIN || 'https://phw973.dpdns.org/roster';
    const idx = await (await fetch(`${origin}/index.json`)).json();
    const latest = await (await fetch(`${origin}/leadership/${idx.dates[0]}.json`)).json();
    const latestIds = new Set(latest.players.map((p) => p.id));
    for (const date of idx.dates.slice(1, 25)) {
      const old = await (await fetch(`${origin}/leadership/${date}.json`)).json();
      const gone = old.players.find((p) => !latestIds.has(p.id) && (p.powerValue || 0) > 0);
      if (gone) {
        departedId = gone.id;
        departedDate = date;
        break;
      }
    }
  } catch (err) {
    console.log(`  (probe skipped: ${err.message})`);
  }

  if (!departedId) {
    console.log('  SKIP  no departed player found in stored windows');
  } else {
    // The reported bug: from a pinned old window, the player's link dropped
    // ?date= and 404'd. Test both the direct link and the pinned link.
    await page.goto(`${BASE}/leadership/player/${departedId}${qs}`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await page.waitForSelector('text=Leadership profile', { timeout: 60000 }).catch(() => {});
    const body = await page.evaluate(() => document.body.innerText);
    const bodyLower = body.toLowerCase();
    check(
      bodyLower.includes('leadership profile'),
      `departed player #${departedId} renders (no 404)`,
      body.slice(0, 120).replace(/\s+/g, ' '),
    );
    check(
      !/404|not found/i.test(body.slice(0, 400)),
      'no 404 wording on the detail page',
    );

    // And the pinned link from the Players tab keeps its date.
    await page.goto(`${BASE}/leadership${qs}${sep}date=${departedDate}`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await page.waitForSelector('text=Kingdom activity', { timeout: 60000 });
    const href = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/leadership/player/"]');
      return link ? link.getAttribute('href') : null;
    });
    check(
      !!href && href.includes(`date=${departedDate}`),
      `player links from a pinned window carry ?date= (${href})`,
    );
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
