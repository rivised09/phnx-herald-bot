/**
 * The KVK season table, published for the web.
 *
 * DragonStats states a kingdom's division/season on the dashboard
 * (`KVK / SOS / SoS1-3126 / Nov 17, 2026 - Dec 29, 2026`) and keeps every
 * season with its kingdom list on /kvk/list - neither is in the scan JSON.
 * This module turns that page into `seasons.json` next to the snapshots, so
 * the player profile can answer "which division was this day played in?"
 * without a browser: a snapshot date inside a season's span that lists this
 * server gets that season's label.
 *
 * Only what the source states is published: a date between two seasons (for
 * #973, 2026-11-04 .. 2026-11-16) belongs to no season and therefore shows no
 * Division row, rather than inheriting the previous one.
 */
const api = require('../dragon/api');

/** Which season covered `date` for `server`, or null. */
function seasonOn(seasons, server, date) {
  const number = Number(String(server).replace(/^#/, '').trim());
  if (!Number.isFinite(number) || !date) return null;
  return (
    (seasons || []).find(
      (season) =>
        Array.isArray(season.servers) &&
        season.servers.includes(number) &&
        season.start <= date &&
        (!season.end || date <= season.end),
    ) || null
  );
}

/**
 * Reads the KVK list and writes `seasons.json`.
 *
 * Best-effort by design: `store` is the R2 store the scrape already writes to,
 * and a browser that cannot open the page must not fail a scrape whose data is
 * already published - the previous seasons.json simply stays in place.
 */
async function publishSeasons(store, { server = null } = {}) {
  const seasons = await api.kvkSeasons({ force: true });
  const payload = {
    version: 1,
    server: server ? String(server) : null,
    updatedAt: new Date().toISOString(),
    seasons,
  };
  await store.put('seasons.json', payload, { cacheControl: 'no-store' });
  return payload;
}

module.exports = { publishSeasons, seasonOn };
