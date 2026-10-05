/**
 * The public home page roster.
 *
 * One source, deliberately: the snapshots the bot has already written to
 * Supabase. The page reads the database and never asks the stats site for a
 * row - fetching from the site is the bot's job, and doing it here would put a
 * live scrape between a visitor and their page, on a page load, at whatever
 * hour they happen to arrive.
 *
 * The cache is a minor optimisation rather than a scrape shield: a burst of
 * visitors costs a burst of queries, not of requests upstream. It is kept
 * short so a newly ingested date reaches visitors quickly.
 */

const TTL_MS = envInt('ROSTER_V1_TTL_MS', 60 * 1000);

function envInt(name, fallback) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const cache = new Map();

async function getRoster({ force = false } = {}) {
  const hit = cache.get('v1');
  if (!force && hit && Date.now() - hit.at < TTL_MS) {
    return { ...hit.value, cached: true };
  }

  let value;
  try {
    value = await require('./store').getStoredRoster();
  } catch (err) {
    value = {
      status: 'fetch_failed',
      detail: err.message,
      alliances: [],
      players: [],
    };
  }

  cache.set('v1', { at: Date.now(), value });
  return { ...value, cached: false };
}

/**
 * Ask for a background resync.
 *
 * Fire-and-forget: the caller wants the page to improve on its next load, not
 * to wait on Chromium. runSync is self-guarding, so repeated calls while one
 * is in flight are simply ignored.
 *
 * The detail pass follows the roster sync because it can only work on
 * snapshots that exist. It is budget-limited and locks itself, so a refresh
 * request on a quiet site costs a handful of queries and on a busy one simply
 * adds another bounded slice of work.
 */
function requestSync(reason = 'request') {
  const { runSync } = require('./ingest');
  return runSync({ reason })
    .then(() => require('./detail').runDetail({ reason }))
    .catch((err) => {
      console.warn('[ROSTER] requested sync failed:', err.message);
      return null;
    });
}

function invalidate() {
  cache.clear();
}

module.exports = { getRoster, requestSync, invalidate };
