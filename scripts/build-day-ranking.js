/**
 * Rebuilds `leadership/days.json` - the all-history weekday activity ranking
 * the leadership Overview card reads.
 *
 *   npm run days
 *
 * Read-only apart from that one small file: it is derived from the leadership
 * summaries already in the bucket. Runs automatically at the end of a scrape.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');
const { writeDayRanking } = require('../src/roster/day-ranking');

const store = {
  async get(key) {
    try {
      return await r2.getJson(key);
    } catch (err) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  },
  put(key, value, options) {
    return r2.putJson(key, value, options);
  },
  list(prefix) {
    return r2.listKeys(prefix);
  },
};

(async () => {
  if (!r2.configured()) {
    throw new Error(`R2 is not configured (missing ${r2.describeMissing()}).`);
  }
  const ranking = await writeDayRanking(store);
  console.log(
    `[DAYS] ${ranking.dayCount} days across ${ranking.summaries} summaries -> leadership/days.json`,
  );
  for (const day of ranking.weekdays.slice(0, 3)) {
    console.log(
      `[DAYS] ${day.label}: ${day.averageActivePlayers} avg active lords (${day.days} days)`,
    );
  }
})().catch((err) => {
  console.error(`[DAYS] Failed: ${err.message}`);
  process.exitCode = 1;
});
