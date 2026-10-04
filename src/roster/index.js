const { getHomeVersionConfig, HOME_VERSIONS, DEFAULT_HOME_VERSION } = require('../settings');

/**
 * Dispatcher for the public home page roster.
 *
 * v1 and v2 are separate modules with separate sources; this file only decides
 * which one to call and caches the result briefly so a burst of visitors does
 * not turn into a burst of scrapes.
 */

/**
 * v1 launches a browser and walks a chain of pages (server, then each
 * alliance), so a refresh costs real seconds of Chromium time. It is cached
 * far longer than v2 (a cheap sheet read) to avoid crawling for every visitor.
 * Override with ROSTER_V1_TTL_MS if the server is large and the chain is slow.
 */
const envTtl = parseInt(process.env.ROSTER_V1_TTL_MS || '', 10);
const TTL_MS = {
  v1: Number.isFinite(envTtl) && envTtl > 0 ? envTtl : 30 * 60 * 1000,
  v2: 60 * 1000,
};
const cache = new Map();

const LOADERS = {
  v1: () => require('./v1').getRoster(),
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
      players: [],
    };
  }

  cache.set(v, { at: Date.now(), value });
  return { ...value, cached: false };
}

function invalidate() {
  cache.clear();
}

module.exports = { getRoster, invalidate, HOME_VERSIONS, DEFAULT_HOME_VERSION };
