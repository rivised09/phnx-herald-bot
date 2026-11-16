/**
 * Verifies the server activity trend plots intervals, not snapshot dates, and
 * that the alliance multi-select actually filters the series.
 *
 *   node scripts/verify-activity-trend.js [--base http://localhost:3100] [--code <code>]
 *
 * The chart used to draw all 8 snapshot dates while the badge said "7
 * intervals", so the x axis read 11-09…11-16 next to a 7-interval label. The
 * baseline day (index 0 of the published timeline) now only anchors the first
 * interval and is named in the copy instead of being plotted.
 */
const { chromium } = require('playwright');

function argValue(flag, fallback = null) {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const BASE = (argValue('--base', 'http://localhost:3100')).replace(/\/+$/, '');
const CODE = argValue('--code', process.env.ACCESS_CODE || '');
const qs = CODE ? `?code=${encodeURIComponent(CODE)}` : '';
const ORIGIN = (process.env.ROSTER_ORIGIN || 'https://phw973.dpdns.org/roster').replace(/\/+$/, '');

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
  // The published summary is the expected source of truth for the dates.
  const index = await (await fetch(`${ORIGIN}/index.json`)).json();
  const latest = index.dates[0];
  const summary = await (await fetch(`${ORIGIN}/leadership/${latest}.json?cb=${Date.now()}`)).json();
  const intervals = summary.timeline.slice(1);
  const expectedTicks = intervals.map((point) => point.date.slice(5));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/leadership${qs}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForSelector('text=Server activity trend', { timeout: 60000 });
  // ResponsiveContainer measures after mount, so the axis ticks appear a beat
  // after the card title. Reading too early looks like "the chart is empty".
  await page
    .waitForSelector('.recharts-xAxis .recharts-cartesian-axis-tick-value', { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(500);

  const read = () =>
    page.evaluate(() => {
      const section = [...document.querySelectorAll('section')].find((s) =>
        (s.querySelector('p')?.textContent || '').toLowerCase().includes('server activity trend'),
      );
      if (!section) return null;
      const ticks = [...section.querySelectorAll('.recharts-cartesian-axis-tick-value')]
        .map((t) => t.textContent.trim())
        .filter((t) => /^\d{2}-\d{2}$/.test(t));
      const values = [...section.querySelectorAll('.recharts-label-list text')]
        .map((t) => t.textContent.trim())
        .filter((t) => /^\d+$/.test(t))
        .map(Number);
      const buttons = [...section.querySelectorAll('button')].map((b) => b.textContent.trim());
      return {
        ticks,
        values,
        buttons,
        text: section.innerText,
      };
    });

  const before = await read();
  check(before !== null, 'trend card renders');
  if (!before) {
    await browser.close();
    process.exit(1);
  }

  /* 1. The x axis is intervals, not snapshot dates ----------------------- */
  console.log('Interval labels');
  check(
    before.ticks.length === intervals.length,
    `chart plots ${intervals.length} intervals, not ${summary.timeline.length} snapshots`,
    `ticks: ${before.ticks.join(', ')}`,
  );
  check(
    JSON.stringify(before.ticks) === JSON.stringify(expectedTicks),
    'tick labels are the interval end dates (baseline excluded)',
    `got ${before.ticks.join(', ')} · expected ${expectedTicks.join(', ')}`,
  );
  check(
    new RegExp(`\\b${intervals.length} intervals\\b`).test(before.text),
    `badge says "${intervals.length} intervals"`,
  );
  check(
    new RegExp(`baseline ${summary.timeline[0].date.slice(5)}`).test(before.text),
    'copy names the baseline day it does not plot',
  );

  /* 2. The alliance filter ---------------------------------------------- */
  console.log('Alliance filter');
  const filterButton = page
    .locator('section', { hasText: 'Server activity trend' })
    .getByRole('button', { name: /alliances|Alliance/i })
    .first();
  check(await filterButton.isVisible().catch(() => false), 'multi-select is available');
  if (!(await filterButton.isVisible().catch(() => false))) {
    await browser.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }

  const beforeValues = before.values;
  await filterButton.click();
  const optionCount = await page
    .locator('section', { hasText: 'Server activity trend' })
    .locator('input[type="checkbox"]')
    .count();
  check(optionCount >= 2, `panel lists the window's alliances (${optionCount})`);

  await page
    .locator('section', { hasText: 'Server activity trend' })
    .locator('input[type="checkbox"]')
    .first()
    .check();
  await page.waitForTimeout(400);
  const filtered = await read();
  const filteredValues = filtered.values;

  check(
    filteredValues.length === beforeValues.length,
    'every interval still gets a point after filtering',
    `${filteredValues.length} vs ${beforeValues.length}`,
  );
  const changed = filteredValues.some((value, i) => value !== beforeValues[i]);
  check(changed, 'selecting an alliance changes the plotted counts', `${beforeValues} -> ${filteredValues}`);
  const sumBefore = beforeValues.reduce((a, b) => a + b, 0);
  const sumAfter = filteredValues.reduce((a, b) => a + b, 0);
  check(
    sumAfter > 0 && sumAfter <= sumBefore,
    `filtered total is a subset of the server total (${sumBefore} -> ${sumAfter})`,
  );
  check(
    !/All alliances/.test(filtered.buttons.join(' ')),
    'the control shows the active selection',
    filtered.buttons.join(' | '),
  );

  /* 3. Clearing restores the server total -------------------------------- */
  const clear = page
    .locator('section', { hasText: 'Server activity trend' })
    .getByRole('button', { name: /^Show all$/i })
    .first();
  await clear.click();
  await page.waitForTimeout(400);
  const cleared = await read();
  check(
    JSON.stringify(cleared.values) === JSON.stringify(beforeValues),
    'Show all restores the unfiltered series',
    `${cleared.values}`,
  );

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
