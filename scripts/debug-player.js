/**
 * Debug script: prints per-date avatar and albums for a player.
 *
 * Usage:
 *   npm run debug:player -- --player 25732950
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');

const PLAYERS_PREFIX = 'players/';

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

function parseArgs(argv) {
  const args = { player: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--player') args.player = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: npm run debug:player -- --player <sourceId>');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.player) throw new Error('--player is required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = createStore();

  const key = `${PLAYERS_PREFIX}${args.player}.json`;
  const file = await store.get(key);

  if (!file) {
    console.log(`[DEBUG] Player file not found: ${key}`);
    process.exit(1);
  }

  console.log(`[DEBUG] Player: ${file.name} (id: ${file.id})`);
  console.log(`[DEBUG] Dates in file: ${file.dates?.join(', ') || 'none'}`);
  console.log('');

  if (file.dates?.length) {
    console.log('[DEBUG] Latest date info:');
    const latest = file.dates[0];
    const entry = file.byDate?.[latest];
    console.log(`  ${latest}:`);
    console.log(`    avatar: ${entry?.avatar || '(none)'}`);
    console.log(`    albums count: ${entry?.albums?.length || 0}`);
    if (entry?.albums?.length) {
      entry.albums.slice(0, 3).forEach((a, i) => {
        console.log(`      [${i}] likes: ${a.likes ?? '(none)'}, postedAt: ${a.postedAt || '(none)'}`);
      });
    }
    console.log('');

    if (file.dates.length > 1) {
      console.log('[DEBUG] Other dates:');
      for (const date of file.dates.slice(1)) {
        const entry = file.byDate?.[date];
        const hasAvatar = entry?.avatar ? 'YES' : 'NO';
        const albumCount = entry?.albums?.length || 0;
        console.log(`  ${date}: avatar=${hasAvatar}, albums=${albumCount}`);
      }
    }
  } else {
    console.log('[DEBUG] No dates found in file.');
  }

  if (file.albums?.length) {
    console.log('');
    console.log(`[DEBUG] Top-level albums (should be empty after cleanup): ${file.albums.length}`);
  }
  if (file.avatar) {
    console.log(`[DEBUG] Top-level avatar (should be empty after cleanup): ${file.avatar}`);
  }
}

main().catch((err) => {
  console.error(`[DEBUG] Failed: ${err.stack || err.message}`);
  process.exit(1);
});
