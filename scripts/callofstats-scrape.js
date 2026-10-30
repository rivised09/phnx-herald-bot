/**
 * Full scrape of callofstats.com for one server.
 *
 *   npm run callofstats:scrape -- --server 973
 *   npm run callofstats:scrape -- --server 973 --concurrency 4
 *   npm run callofstats:scrape -- --server 973 --out ./.cof-test   write locally
 *   npm run callofstats:scrape -- --server 973 --dry-run              fetch and merge, write nothing
 *
 * Crawl chain:
 *   /server/{id}   -> alliances + their member players (each carries player_id)
 *   /lord/{id}     -> one player in depth (avatar, name history, gallery
 *                     albums with likes, all stats)
 *
 * Since callofstats publishes current data only, each run captures today's
 * date. Run it periodically to add new dates; older dates already in R2 get
 * their missing fields filled in additively.
 *
 * Files are written snapshot/player/alliance first and index.json last, same
 * as the dragonstats scrape, so a reader never sees a partial publish.
 *
 * Transport: documents are fetched through the Python sidecar (Chrome TLS
 * fingerprint) with the saved session and parsed in one reused browser - see
 * src/roster/lord.js. The source refuses an account that reads too fast, so
 * requests are paced with jitter rather than run in parallel, and a refusal
 * that survives a renewal swaps to the next configured account.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');
const { mergeFile } = require('../src/roster/merge');
const { sectionFor } = require('../src/roster/sections');
const { createLordSource } = require('../src/roster/lord');
const { accountCount } = require('../src/roster/session');
const sidecar = require('../src/roster/sidecar');
const { createProgress } = require('../src/utils/progress');

const PLAYERS_PREFIX = 'players/';
const ALLIANCES_PREFIX = 'alliances/';
const SNAPSHOTS_PREFIX = 'snapshots/';

function parseArgs(argv) {
  const args = {
    server: null,
    concurrency: null,
    stripe: 0,
    out: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server') args.server = argv[++i];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]) || 4;
    else if (arg === '--stripe') args.stripe = Number(argv[++i]) || 0;
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run callofstats:scrape -- --server 973 [--concurrency N] [--stripe N] [--out <dir>] [--dry-run]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.server) throw new Error('--server is required, for example --server 973');
  return args;
}

function describe(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function createStore({ dir }) {
  if (dir) {
    const resolve = (key) => path.join(dir, key);
    return {
      label: path.resolve(dir),
      async get(key) {
        try {
          return JSON.parse(fs.readFileSync(resolve(key), 'utf8'));
        } catch (err) {
          if (err.code === 'ENOENT') return null;
          throw err;
        }
      },
      async put(key, value) {
        const file = resolve(key);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const body = JSON.stringify(value);
        fs.writeFileSync(file, body);
        return Buffer.byteLength(body);
      },
      async list(prefix) {
        const base = resolve(prefix);
        if (!fs.existsSync(base)) return [];
        return fs.readdirSync(base).map((name) => `${prefix}/${name}`);
      },
    };
  }

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

/** The date this scrape captures - today in YYYY-MM-DD. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Turns extracted lord-page data into a player file entry for one date.
 */
function enrichPlayer(player, lordData, targetDate) {
  const date = targetDate || lordData.date || today();

  const incoming = JSON.parse(JSON.stringify(player));

  // Non-date fields
  if (lordData.avatar) incoming.avatar = lordData.avatar;
  if (lordData.nameHistory && lordData.nameHistory.length) {
    incoming.nameHistory = [...new Set([...(incoming.nameHistory || []), ...lordData.nameHistory])];
  }
  if (lordData.albums && lordData.albums.length) {
    incoming.albums = [...(incoming.albums || [])];
    const existingUrls = new Set(incoming.albums.map((a) => a.url));
    for (const album of lordData.albums) {
      if (!existingUrls.has(album.url)) {
        incoming.albums.push(album);
        existingUrls.add(album.url);
      }
    }
  }

  incoming.dates = [...new Set([...(incoming.dates || []), date])].sort().reverse();

  const existingEntry = incoming.byDate && incoming.byDate[date];
  const entry = {
    name: existingEntry?.name || player.name || null,
    rank: existingEntry?.rank ?? null,
    power: existingEntry?.power ?? null,
    avatar: lordData.avatar || existingEntry?.avatar || null,
    alliance: existingEntry?.alliance || null,
    sections: [],
  };

  // If we have no name from existing data, try to get it from the page
  if (!entry.name && player.name) entry.name = player.name;

  const bySection = new Map();
  const existingSections = (existingEntry?.sections || []).reduce((acc, s) => {
    acc.set(s.section, new Set(s.rows.map((r) => r.label)));
    return acc;
  }, new Map());
  for (const [label, value] of Object.entries(lordData.stats || {})) {
    const section = sectionFor(label);
    const existingLabels = existingSections.get(section);
    if (existingLabels && existingLabels.has(label)) continue;
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push({ label, value });
  }
  entry.sections = [...bySection].map(([section, rows]) => ({ section, rows }));

  if (!incoming.metrics) incoming.metrics = {};
  const existingMetrics = player.metrics?.[date] || {};
  const metrics = {};
  for (const [label, value] of Object.entries(lordData.stats || {})) {
    if (label in existingMetrics) continue;
    const parsed = Number(value.replace(/,/g, ''));
    metrics[label] = Number.isFinite(parsed) ? parsed : value;
  }
  if (Object.keys(metrics).length) {
    incoming.metrics[date] = { ...existingMetrics, ...metrics };
  }

  if (!incoming.byDate) incoming.byDate = {};
  incoming.byDate[date] = entry;

  return incoming;
}

/**
 * Processes players one at a time through the paced source.
 */
async function processPlayers(source, store, playerIds, targetDate, dryRun) {
  const results = {
    processed: 0,
    skipped: 0,
    errors: [],
    newPlayers: 0,
    bytes: 0,
    blocked: false,
  };
  const progress = createProgress({ total: playerIds.length, tag: 'CALLSTATS' });
  let index = 0;

  for (const playerId of playerIds) {
    index += 1;
    const itemStarted = Date.now();
    try {
      const key = `players/${playerId}.json`;
      let existing;
      try {
        existing = await store.get(key);
      } catch (getErr) {
        results.errors.push({ playerId, message: `store.get: ${getErr.message}` });
        progress.item({
          index,
          id: playerId,
          status: 'error',
          detail: `store.get failed: ${getErr.message}`,
          ms: Date.now() - itemStarted,
        });
        continue;
      }

      progress.item({
        index,
        id: playerId,
        name: existing?.name,
        status: 'info',
        detail: 'fetching lord page…',
        count: false,
      });
      const page = await source.fetch(playerId);
      if (!page.ok) {
        if (page.blocked) {
          results.blocked = true;
          progress.item({
            index,
            id: playerId,
            name: existing?.name,
            status: 'error',
            detail: source.blockedReason,
            ms: Date.now() - itemStarted,
          });
          break;
        }
        results.errors.push({ playerId, message: 'Could not reach lord page after retries' });
        progress.item({
          index,
          id: playerId,
          name: existing?.name,
          status: 'error',
          detail: 'cannot reach lord page',
          ms: Date.now() - itemStarted,
        });
        continue;
      }

      const lordData = await source.read(page.html);
      if (!lordData) {
        results.errors.push({ playerId, message: 'Empty lord page' });
        progress.item({
          index,
          id: playerId,
          name: existing?.name,
          status: 'error',
          detail: 'empty lord page',
          ms: Date.now() - itemStarted,
        });
        continue;
      }

      // Try to get the player name from the page title
      const nameMatch = (lordData.title || '').match(/Lord Profile — (.+) \|/);
      const lordName = nameMatch ? nameMatch[1] : null;

      const enriched = enrichPlayer(existing, lordData, targetDate);
      if (lordName && !enriched.name) enriched.name = lordName;

      const merged = mergeFile('player', existing, enriched);

      if (!dryRun) {
        const bytes = await store.put(key, merged, { cacheControl: 'public, max-age=3600' });
        results.bytes += bytes;
      }

      results.processed += 1;
      if (!existing) results.newPlayers += 1;
      progress.item({
        index,
        id: playerId,
        name: merged.name || existing?.name,
        status: 'done',
        detail: existing ? (dryRun ? 'dry run, nothing written' : null) : 'new player',
        ms: Date.now() - itemStarted,
      });
    } catch (err) {
      results.errors.push({ playerId, message: err.message });
      progress.item({
        index,
        id: playerId,
        status: 'error',
        detail: err.message,
        ms: Date.now() - itemStarted,
      });
    }
  }

  progress.bar();
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out && !args.dryRun && !r2.configured()) {
    throw new Error(
      `R2 is not configured (missing ${r2.describeMissing()}). ` +
        'Add the R2_* variables to .env, or pass --out <dir> to write locally.',
    );
  }

  if (accountCount() === 0) {
    throw new Error('No callofstats accounts configured. Set CALLOFSTATS_USERNAME/PASSWORD.');
  }
  if ((args.concurrency || 4) > 1) {
    console.log(
      '[CALLSTATS] Concurrency is fixed at 1: the source refuses bursts, so requests are paced instead.',
    );
  }
  const stripes = args.stripe > 0 ? Math.min(args.stripe, accountCount()) : 1;
  console.log(
    `[CALLSTATS] Server: #${args.server}, ${accountCount()} account(s), ` +
      `${stripes > 1 ? `striped across ${stripes} accounts` : 'single session'}`,
  );

  const store = createStore({ dir: args.out });
  const targetDate = today();
  console.log(`[CALLSTATS] Target date: ${targetDate}`);

  // Gather every player file already in R2 (we enrich these, don't re-discover)
  const playerKeys = await store.list(PLAYERS_PREFIX);
  const playerIds = playerKeys.map((key) => path.basename(key, '.json'));
  console.log(`[CALLSTATS] Found ${playerIds.length} existing player files in ${store.label}`);

  const source = createLordSource({ tag: 'CALLSTATS', stripe: args.stripe });
  const started = Date.now();

  let result;
  try {
    result = await processPlayers(source, store, playerIds, targetDate, args.dryRun);
  } finally {
    await source.close();
  }

  for (const e of result.errors) {
    console.warn(`[CALLSTATS] error: player ${e.playerId}: ${e.message}`);
  }

  console.log(
    `[CALLSTATS] Done: ${result.processed} processed, ${result.newPlayers} new, ` +
      `${result.skipped} skipped, ${result.errors.length} errors, ${describe(result.bytes)}, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  if (result.blocked) {
    console.warn(`[CALLSTATS] Stopped early: ${result.blockedReason}. Re-run later to continue.`);
  }

  if (result.errors.length > 0 || result.blocked) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`[CALLSTATS] Failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // The sidecar owns the network and its Python children inherit the stdio
    // pipes, so a plain return would leave the process waiting on them.
    sidecar.shutdown();
    setTimeout(() => process.exit(process.exitCode || 0), 2500);
  });
