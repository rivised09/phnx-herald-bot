/**
 * Removes top-level `albums` and `avatar` from every player file.
 *
 * Albums are now stored per-date under `byDate[YYYY-MM-DD].albums`. The old
 * top-level list was being overwritten by the most recent enrichment, so every
 * snapshot was showing the same album/likes from whatever date was enriched
 * last. This script deletes the stale top-level list so each snapshot only
 * shows the per-date gallery recorded for that day.
 *
 * Top-level avatar is also removed because it's now redundant - the web uses
 * per-date avatar with fallback to the newest available (see carryForwardEntry).
 *
 *   npm run clean:all
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');

const PLAYERS_PREFIX = 'players/';

function createStore() {
  return {
    label: `R2 bucket "${r2.config().bucket}"`,
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
}

async function main() {
  if (!r2.configured()) {
    throw new Error(`R2 is not configured (${r2.describeMissing()}).`);
  }

  const store = createStore();
  const keys = await store.list(PLAYERS_PREFIX);
  console.log(`[CLEAN] Found ${keys.length} player files in ${store.label}`);

  let cleaned = 0;
  let removed = 0;
  let bytes = 0;

  for (const key of keys) {
    const file = await store.get(key);
    if (!file) continue;

    if (!file.albums || file.albums.length === 0) continue;

    const count = file.albums.length;
    delete file.albums;

    const written = await store.put(key, file, { cacheControl: 'public, max-age=3600' });
    bytes += written;
    cleaned += 1;
    removed += count;
  }

  console.log(
    `[CLEAN] Removed top-level albums from ${cleaned} files (${removed} album entries), ${formatBytes(bytes)} written.`,
  );
}

function formatBytes(value) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

main().catch((err) => {
  console.error(`[CLEAN] Failed: ${err.stack || err.message}`);
  process.exit(1);
});
