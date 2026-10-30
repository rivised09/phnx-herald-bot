/**
 * Simulate what the web sees for a player at specific dates.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');

function createStore() {
  return {
    async get(key) {
      try {
        return await r2.getJson(key);
      } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
  };
}

function latestAvatar(file) {
  for (const date of file.dates) {
    const value = file.byDate?.[date]?.avatar;
    if (value) return value;
  }
  return null;
}

function splitNameHistory(nameHistory, currentName) {
  const previousNames = [];
  const previousServers = [];
  for (const name of nameHistory || []) {
    if (name === currentName) continue;
    if (/^\d+$/.test(String(name).trim())) {
      previousServers.push(String(name).trim());
    } else {
      previousNames.push(name);
    }
  }
  return { previousNames, previousServers };
}

function albumPostedAt(album) {
  const url = String(album?.url || '');
  const proxy = url.match(/image-proxy\/([A-Za-z0-9+/=]+)$/);
  if (proxy) {
    try {
      const original = Buffer.from(proxy[1], 'base64').toString('utf8');
      const match = original.match(/(\d{4}-\d{2}-\d{2})/);
      if (match) return match[1];
    } catch {
      // fall through
    }
  }
  const direct = url.match(/(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  return album?.postedAt || null;
}

function albumsForDate(file, wanted) {
  const entry = file.byDate?.[wanted];
  return entry?.albums?.slice(0, 8) || [];
}

function getPlayerDetail(file, wanted) {
  const entry = file.byDate?.[wanted];
  if (!entry) return null;

  return {
    date: wanted,
    avatar: entry.avatar || latestAvatar(file),
    albums: albumsForDate(file, wanted),
    albumCount: albumsForDate(file, wanted).length,
    entryHasAvatar: Boolean(entry.avatar),
    entryHasAlbums: Array.isArray(entry.albums) && entry.albums.length > 0,
  };
}

async function main() {
  const playerId = process.argv[2] || '25718805';
  const store = createStore();

  const key = `players/${playerId}.json`;
  const file = await store.get(key);

  if (!file) {
    console.log(`Player file not found: ${key}`);
    process.exit(1);
  }

  console.log(`Player: ${file.name} (${playerId})`);
  console.log(`Dates: ${file.dates.length} total`);
  console.log('');

  // Check top-level
  console.log('Top-level (should be empty after cleanup):');
  console.log(`  avatar: ${file.avatar ? 'EXISTS' : 'empty'}`);
  console.log(`  albums: ${file.albums?.length || 0} items`);
  console.log('');

  // Simulate web for specific dates
  const testDates = ['2026-10-29', '2026-10-28', '2026-10-27', '2026-10-26', '2026-10-25'];
  for (const date of testDates) {
    const detail = getPlayerDetail(file, date);
    console.log(`Date: ${date}`);
    if (!detail) {
      console.log(`  No byDate entry for this date`);
      continue;
    }
    console.log(`  entry.avatar: ${detail.entryHasAvatar ? 'YES' : 'NO'}`);
    console.log(`  entry.albums: ${detail.entryHasAlbums ? 'YES' : 'NO'}`);
    console.log(`  Web shows avatar: ${detail.avatar ? 'YES' : 'NO'}`);
    console.log(`  Web shows albums: ${detail.albumCount} items`);
    console.log(`  Avatar from: ${detail.avatar === file.byDate?.[date]?.avatar ? 'per-date' : 'latestAvatar()'}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(`Failed: ${err.stack || err.message}`);
  process.exit(1);
});
