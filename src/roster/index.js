const { HOME_VERSIONS, DEFAULT_HOME_VERSION } = require('../settings');

/**
 * Dispatcher for the public home page roster.
 *
 * v1 and v2 have separate sources; this file only decides which one to call
 * and caches the result briefly so a burst of visitors does not turn into a
 * burst of work.
 *
 * v1 reads snapshots that ./ingest wrote ahead of time, so a request never
 * launches a browser. That also means the cache is a minor optimisation
 * rather than a scrape shield, and it is kept short so a newly ingested date
 * reaches visitors quickly. Filling the database is the scheduler's job; a
 * visitor asking for fresh data only triggers a background run.
 */

const TTL_MS = {
  v1: envInt('ROSTER_V1_TTL_MS', 60 * 1000),
  v2: 60 * 1000,
};

function envInt(name, fallback) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const cache = new Map();

const LOADERS = {
  v1: () => require('./store').getStoredRoster(),
  v2: () => require('./v2').getRoster(),
};

function normalizeVersion(value) {
  const v = String(value || '').trim().toLowerCase();
  return HOME_VERSIONS.includes(v) ? v : DEFAULT_HOME_VERSION;
}

async function getRoster(version, { force = false } = {}) {
  const v = normalizeVersion(version);
  const hit = cache.get(v);
  if (!force && hit && Date.now() - hit.at < (TTL_MS[v] || TTL_MS.v2)) {
    return { ...hit.value, cached: true };
  }

  let value;
  try {
    value = await LOADERS[v]();
  } catch (err) {
    value = {
      version: v,
      status: 'fetch_failed',
      detail: err.message,
      alliances: [],
      players: [],
    };
  }

  cache.set(v, { at: Date.now(), value });
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
 * adds another bounded slice to the backfill.
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

module.exports = { getRoster, requestSync, invalidate, HOME_VERSIONS, DEFAULT_HOME_VERSION };
