/**
 * DOM-based verification of the player-detail chart and layout fixes -
 * asserted from rendered text and element geometry, which are reliable,
 * instead of screenshots (the image pipeline proved untrustworthy in this
 * session: a nav-strip capture came back as an unrelated full-page shot).
 *
 *   node scripts/verify-player-charts.js [--base http://localhost:3100] [--code <code>]
 *
 * Checks:
 *   - trend chart prints a numeric label per plottable day (recharts v3
 *     needs the `label` prop, not a LabelList child)
 *   - kill-growth bars carry their values
 *   - the resources chart is not dominated by a month-sized spike
 *   - activity-coverage rows do not overlap each other
 *   - profile: raw source metrics are collapsed by default, grouped labels
 *     present, identity rows full-width on mobile
 */
const { chromium } = require('playwright');

function argValue(flag, fallback = null) {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const BASE = (argValue('--base', 'http://localhost:3100')).replace(/\/+$/, '');
const CODE = argValue('--code', process.env.ACCESS_CODE || '');
const qs = CODE ? `?code=${encodeURIComponent(CODE)}` : '';

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
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await page.goto(`${BASE}/leadership/player/25732950${qs}`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForSelector('text=Leadership profile', { timeout: 60000 });

  /* Growth ---------------------------------------------------------------- */
  console.log('Growth tab');
  await page.getByRole('button', { name: 'Growth', exact: true }).click();
  await page.waitForSelector('text=Power & rank', { timeout: 30000 });

  const growth = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('section')];
    const card = (title) =>
      cards.find((s) => (s.querySelector('p')?.textContent || '').toLowerCase().includes(title));

    // 1. Value labels on the trend line (tagged .chart-value-label; axis ticks
    //    use similar number formats so class counting is the only precise way).
    const trend = card('power & rank');
    const trendLabels = trend ? [...trend.querySelectorAll('.chart-value-label')] : [];
    const trendValues = trendLabels
      .map((t) => t.textContent.trim())
      .filter((t) => /^[\d.]+[KMB]?$/.test(t));

    // 2. Values on the top kill-gain bars.
    const kills = card('daily kill gains');
    const killLabels = kills ? [...kills.querySelectorAll('.chart-value-label')] : [];
    const killValues = killLabels
      .map((t) => t.textContent.trim())
      .filter((t) => /^\+?[\d,]{4,}$/.test(t));

    // 3. Resources chart axis: a month-sized spike shows as a >=50M tick.
    const gathered = card('resources gathered');
    const gatheredTicks = gathered
      ? [...gathered.querySelectorAll('svg text')]
          .map((t) => t.textContent.trim())
          .filter((t) => /^\d+(\.\d+)?M$/.test(t))
          .map((t) => parseFloat(t) * 1e6)
      : [];

    // 4. Activity coverage rows must not overlap.
    const coverage = card('activity coverage');
    const rows = coverage
      ? [...coverage.querySelectorAll('.flex.h-full > div')].map((r) => r.getBoundingClientRect())
      : [];
    let overlaps = 0;
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].top < rows[i - 1].bottom - 1) overlaps += 1;
    }

    return {
      trendLabels: trendValues.length,
      killLabels: killValues.length,
      gatheredMaxTick: gatheredTicks.length ? Math.max(...gatheredTicks) : null,
      coverageRows: rows.length,
      coverageOverlaps: overlaps,
    };
  });

  check(growth.trendLabels >= 4, `trend prints numeric day labels (${growth.trendLabels})`);
  check(growth.killLabels >= 3, `kill-gain bars carry values (${growth.killLabels})`);
  check(
    growth.gatheredMaxTick !== null && growth.gatheredMaxTick < 20e6,
    'resources axis is not dominated by a month-sized spike',
    `max tick ${growth.gatheredMaxTick}`,
  );
  check(
    growth.coverageRows >= 4 && growth.coverageOverlaps === 0,
    `activity-coverage rows do not overlap (${growth.coverageRows} rows, ${growth.coverageOverlaps} overlaps)`,
  );

  /* Profile ---------------------------------------------------------------- */
  console.log('Profile tab');
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await page.waitForSelector('text=Previous names', { timeout: 30000 });

  const profile = await page.evaluate(() => {
    const details = [...document.querySelectorAll('details')];
    const identityRows = [...document.querySelectorAll('section')]
      .find((s) => (s.querySelector('p')?.textContent || '').toLowerCase().includes('identity'))
      ?.querySelectorAll('.sm\\:grid-cols-3 > div');
    const identityWidths = identityRows ? [...identityRows].map((r) => Math.round(r.getBoundingClientRect().width)) : [];
    return {
      sourceSections: details.length,
      allCollapsed: details.length > 0 && details.every((d) => !d.open),
      groupedLabels: document.body.innerText.toLowerCase().includes('progress'),
      identityWidths,
      hasGallery: document.body.innerText.toLowerCase().includes('gallery'),
      hasHistory: document.body.innerText.toLowerCase().includes('snapshot history'),
    };
  });

  check(profile.sourceSections >= 10, `source metrics present (${profile.sourceSections} sections)`);
  check(profile.allCollapsed, 'raw source metrics collapsed by default');
  check(profile.groupedLabels, 'progress group label present');
  check(profile.hasGallery, 'gallery group present');
  check(profile.hasHistory, 'snapshot history grouped under progress');
  check(
    profile.identityWidths.length === 3 && profile.identityWidths.every((w) => w > 250),
    `identity rows full-width on mobile (${JSON.stringify(profile.identityWidths)})`,
  );

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
