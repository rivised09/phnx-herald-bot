/**
 * Enriches published player files with callofstats-only data.
 *
 *   npm run enrich -- --server 973
 *   npm run enrich -- --server 973 --concurrency 1
 *   npm run enrich -- --server 973 --date 2026-10-27
 *   npm run enrich -- --server 973 --out ./.enrich-test   write locally
 *   npm run enrich -- --server 973 --dry-run              fetch and merge, write nothing
 *
 * For every player in the archive it visits /lord/{id} on callofstats and
 * extracts the fields callofstats has that dragonstats does not:
 *
 *   - name history (previous names)
 *   - gallery album images with likes
 *   - avatar URL
 *   - T1-T5 kills, division, king/leadership time, ToC / RoW stats,
 *     resource assistance, and every other stat on the lord page
 *
 * Writes are additive via src/roster/merge.js: callofstats never erases what
 * dragonstats recorded, and dragonstats never erases what callofstats recorded.
 *
 * Transport: the document is fetched through the Python sidecar (Chrome TLS
 * fingerprint) with the saved callofstats session, paced with jitter, and
 * parsed in one reused browser - see src/roster/lord.js. The source refuses an
 * account that reads too fast, so requests are held apart rather than run in
 * parallel; when a refusal survives a renewal the next account is logged in.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');
const { mergeFile } = require('../src/roster/merge');
const { sectionFor } = require('../src/roster/sections');
const { createLordSource } = require('../src/roster/lord');
const sidecar = require('../src/roster/sidecar');
const { createProgress } = require('../src/utils/progress');

const PLAYERS_PREFIX = 'players/';

/** Resume state: tracks which player IDs have been enriched per server+date. */
const ENRICH_PROGRESS_FILE = path.join(
  __dirname,
  '..',
  'data',
  'enrich-progress.json',
);

function progressKey(server, date) {
  return `${server}:${date || 'latest'}`;
}

function loadProgress() {
  try {
    const raw = fs.readFileSync(ENRICH_PROGRESS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveProgress(progress) {
  fs.mkdirSync(path.dirname(ENRICH_PROGRESS_FILE), { recursive: true });
  fs.writeFileSync(ENRICH_PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function parseArgs(argv) {
  const args = {
    server: null,
    date: null,
    out: null,
    concurrency: null,
    stripe: 0,
    dryRun: false,
    allPlayers: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server') args.server = argv[++i];
    else if (arg === '--date') args.date = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]) || 1;
    else if (arg === '--stripe') args.stripe = Number(argv[++i]) || 0;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--all-players') args.allPlayers = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run enrich -- --server 973 [--date YYYY-MM-DD] [--concurrency N] [--stripe N] [--out <dir>] [--dry-run] [--all-players] [--force]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.server) throw new Error('--server is required, for example --server 973');
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${args.date}"`);
  }
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

function accountList() {
  const split = (value) =>
    String(value || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

  const users = split(process.env.CALLOFSTATS_USERNAMES || process.env.CALLOFSTATS_USERNAME);
  if (!users.length) return [];

  const passwordRaw = String(
    process.env.CALLOFSTATS_PASSWORDS || process.env.CALLOFSTATS_PASSWORD || '',
  ).trim();
  const passwords = split(passwordRaw);

  const aligned =
    passwords.length === users.length
      ? passwords
      : users.length === 1
        ? [passwordRaw]
        : passwords;

  return users
    .map((username, index) => ({ username, password: aligned[index] || '' }))
    .filter((account) => account.password);
}

/**
 * Turns extracted lord-page data into the fields we merge into a player file.
 */
function enrichPlayer(player, lordData, targetDate) {
  const date = targetDate || lordData.date;

  const incoming = JSON.parse(JSON.stringify(player));

  // Non-date fields: cumulative lists that do not belong to a single day.
  if (lordData.nameHistory && lordData.nameHistory.length) {
    incoming.nameHistory = [...new Set([...(incoming.nameHistory || []), ...lordData.nameHistory])];
  }

  // Date-specific fields: stats and byDate entry
  if (!date) {
    const existingDates = incoming.dates || [];
    if (existingDates.length && Object.keys(lordData.stats || {}).length) {
      incoming.dates = [...new Set(existingDates)].sort().reverse();
    }
    return incoming;
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
    albums: lordData.albums || existingEntry?.albums || [],
    achievements: lordData.achievements || existingEntry?.achievements || [],
  };

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
 * Processes players sequentially through one paced source.
 *
 * The source paces its own requests and stops once every account has been
 * refused, so a run that hits the wall ends with the resume state intact
 * instead of recording hundreds of identical failures.
 */
async function processPlayers(
  store,
  playerIds,
  targetDate,
  dryRun,
  force,
  progressSet,
  progressSaveCb,
  progressObj,
  progressKeyName,
  stripe = 0,
  tag = 'ENRICH',
) {
  const results = { processed: 0, skipped: 0, errors: [], bytes: 0, blocked: false };
  const progress = createProgress({ total: playerIds.length, tag });
  const source = createLordSource({ tag, stripe, date: targetDate });

  try {
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
        if (!existing) {
          results.skipped += 1;
          progress.item({ index, id: playerId, status: 'skipped', detail: 'no player file' });
          continue;
        }

        // Skip players already enriched for this specific date. Each date is
        // independent, so enriching Oct 29 does not make Oct 28 done.
        const dateEntry = existing.byDate?.[targetDate];
        const hasDateAvatar = Boolean(dateEntry?.avatar);
        const hasDateAlbums = Array.isArray(dateEntry?.albums) && dateEntry.albums.length > 0;
        if (!force && (hasDateAvatar || hasDateAlbums)) {
          results.skipped += 1;
          progress.item({
            index,
            id: playerId,
            name: existing.name,
            status: 'skipped',
            detail: `already enriched for ${targetDate || 'latest'}`,
          });
          continue;
        }

        // Skip players already enriched in a previous run of this same command
        // (resume support). This is always respected, even with --force, so a
        // rate-limited run picks up where it stopped instead of restarting.
        if (progressSet && progressSet.has(playerId)) {
          results.skipped += 1;
          progress.item({
            index,
            id: playerId,
            name: existing.name,
            status: 'skipped',
            detail: 'already enriched (resume)',
          });
          continue;
        }

        progress.item({
          index,
          id: playerId,
          name: existing.name,
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
              name: existing.name,
              status: 'error',
              detail: source.blockedReason,
              ms: Date.now() - itemStarted,
            });
            break;
          }
          results.errors.push({ playerId, message: 'Could not reach lord page' });
          progress.item({
            index,
            id: playerId,
            name: existing.name,
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
            name: existing.name,
            status: 'error',
            detail: 'empty lord page',
            ms: Date.now() - itemStarted,
          });
          continue;
        }

        const enriched = enrichPlayer(existing, lordData, targetDate);
        const merged = mergeFile('player', existing, enriched);

        if (!dryRun) {
          const bytes = await store.put(key, merged, { cacheControl: 'public, max-age=3600' });
          results.bytes += bytes;
        }

        results.processed += 1;
        progress.item({
          index,
          id: playerId,
          name: merged.name || existing.name,
          status: 'done',
          detail: dryRun ? 'dry run, nothing written' : null,
          ms: Date.now() - itemStarted,
        });
        if (progressSet && progressObj) {
          progressSet.add(playerId);
          if (!progressObj[progressKeyName].includes(playerId)) {
            progressObj[progressKeyName].push(playerId);
          }
          progressSaveCb();
        }
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
  } finally {
    await source.close();
  }

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

  const accounts = accountList();
  if (!accounts.length) {
    throw new Error('No callofstats accounts configured. Set CALLOFSTATS_USERNAME/PASSWORD.');
  }
  if ((args.concurrency || 1) > 1) {
    console.log(
      '[ENRICH] Concurrency is fixed at 1: the source refuses bursts, so requests are paced instead.',
    );
  }
  console.log(`[ENRICH] Using ${accounts.length} account(s) for rotation`);

  const store = createStore({ dir: args.out });

  // Prefer the date's own roster from its snapshot: a player who migrated out
  // is not on the server that day, so enriching them is wasted work. Fall back
  // to every player file in the bucket when there is no date, no snapshot for
  // it, or --all-players was passed.
  let allPlayerIds = null;
  if (args.date && !args.allPlayers) {
    const snapshot = await store.get(`snapshots/${args.date}.json`).catch(() => null);
    const roster = [
      ...new Set(
        (snapshot?.players || [])
          .map((p) => (typeof p === 'string' ? p : p?.id))
          .filter(Boolean),
      ),
    ];
    if (roster.length) {
      allPlayerIds = roster;
      console.log(
        `[ENRICH] Using ${roster.length} players from snapshots/${args.date}.json (that date's roster)`,
      );
    } else {
      console.warn(
        `[ENRICH] snapshots/${args.date}.json has no roster; falling back to every player file`,
      );
    }
  }
  if (!allPlayerIds) {
    const playerKeys = await store.list(PLAYERS_PREFIX);
    allPlayerIds = playerKeys.map((key) => path.basename(key, '.json'));
    console.log(`[ENRICH] Found ${allPlayerIds.length} player files in ${store.label}`);
  }

  // Load resume state: skip players already enriched for this server+date
  const progress = loadProgress();
  const key = progressKey(args.server, args.date);
  if (!progress[key]) progress[key] = [];
  const processedSet = new Set(progress[key]);
  const playerIds = allPlayerIds.filter((id) => !processedSet.has(id));
  if (processedSet.size) {
    console.log(
      `[ENRICH] Resuming: ${processedSet.size} players already enriched for ${args.server}:${args.date}, ${playerIds.length} remaining`,
    );
  }

  const saveProgressCb = () => {
    saveProgress(progress);
  };

  const started = Date.now();
  const result = await processPlayers(
    store,
    playerIds,
    args.date,
    args.dryRun,
    args.force,
    processedSet,
    saveProgressCb,
    progress,
    key,
    args.stripe,
    'ENRICH',
  );

  for (const e of result.errors) {
    console.warn(`[ENRICH] error: player ${e.playerId}: ${e.message}`);
  }

  console.log(
    `[ENRICH] Done: ${result.processed} processed, ${result.skipped} skipped, ` +
      `${result.errors.length} errors, ${describe(result.bytes)}, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  if (result.blocked) {
    console.warn(
      `[ENRICH] Stopped early: ${result.blockedReason}. Progress is saved; re-run later to continue.`,
    );
  }

  if (result.errors.length > 0 || result.blocked) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`[ENRICH] Failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // The sidecar owns the network and its Python children inherit the stdio
    // pipes, so a plain return would leave the process waiting on them.
    sidecar.shutdown();
    setTimeout(() => process.exit(process.exitCode || 0), 2500);
  });
