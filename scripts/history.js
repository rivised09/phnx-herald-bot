/**
 * Full history scrape + inject. Run by hand, on this machine: npm run history
 *
 * The deployed bot deliberately does not do this - see src/roster/scope.js.
 * It keeps the newest date current and leaves every date behind it alone,
 * which is what makes it cheap enough to run hourly. This script is the other
 * half: it turns ROSTER_HISTORY on for the process, asks for the dates the
 * source still offers, and keeps going until the database has them all.
 *
 * Safe to re-run. Completed dates and completed detail subjects are already
 * recorded in the database, so a second pass spends its time on whatever the
 * first one ran out of budget for.
 */
process.env.ROSTER_HISTORY = '1';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { runSync, getSyncState } = require('../src/roster/ingest');
const { runDetail, getDetailState } = require('../src/roster/detail');

/** A batch per run; a cold database needs several before it stops finding work. */
const MAX_SYNC_ROUNDS = 60;
/** Detail resumes per budget, so several runs are normal for a full history. */
const MAX_DETAIL_ROUNDS = 20;

function show(label, value) {
  console.log(`[HISTORY] ${label}: ${JSON.stringify(value)}`);
}

async function fillRoster() {
  for (let round = 1; round <= MAX_SYNC_ROUNDS; round += 1) {
    const result = await runSync({ reason: 'history' });
    show(`sync ${round}/${MAX_SYNC_ROUNDS}`, result);
    if (result.error) throw new Error(`sync failed: ${result.error} ${result.detail || ''}`.trim());
    if (result.upToDate) return round;
  }
  console.warn(`[HISTORY] Stopped after ${MAX_SYNC_ROUNDS} sync rounds; still not up to date.`);
  return MAX_SYNC_ROUNDS;
}

async function fillDetail() {
  for (let round = 1; round <= MAX_DETAIL_ROUNDS; round += 1) {
    let state;
    try {
      state = await runDetail({ reason: 'history' });
    } catch (err) {
      show(`detail ${round} refused`, { error: err.message, code: err.code || null });
      throw err;
    }
    const stats = state.stats || {};
    show(`detail ${round}/${MAX_DETAIL_ROUNDS}`, {
      scope: state.scope,
      dates: stats.dates,
      pages: stats.pages,
      server: stats.server,
      alliances: stats.alliances,
      lords: stats.lords,
      budgetHit: stats.budgetHit,
      error: state.error,
    });
    if (state.error) throw new Error(`detail failed: ${state.error}`);
    // Nothing fetched means every subject on the list is already recorded.
    if (!stats.pages) return round;
  }
  console.warn(`[HISTORY] Stopped after ${MAX_DETAIL_ROUNDS} detail rounds; budget keeps interrupting.`);
  return MAX_DETAIL_ROUNDS;
}

(async () => {
  console.log('[HISTORY] Roster history run starting (ROSTER_HISTORY=1).');
  await fillRoster();
  await fillDetail();
  show('roster', await getSyncState());
  show('detail', await getDetailState());
  console.log('[HISTORY] Done.');
})().catch((err) => {
  console.error(`[HISTORY] Stopped: ${err.stack || err.message}`);
  process.exitCode = 1;
});
