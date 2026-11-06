/**
 * Full scrape of callofstats.com for one server.
 *
 *   npm run callofstats:scrape -- --server 973
 *   npm run callofstats:scrape -- --server 973 --concurrency 4
 *   npm run callofstats:scrape -- --server 973 --out ./.cof-test   write locally
 *   npm run callofstats:scrape -- --server 973 --dry-run              fetch and merge, write nothing
 *   npm run callofstats:scrape -- --server 973 --force                re-read pairs already done
 *   npm run callofstats:scrape -- --server 973 --player 21136188      one player, all dates, then stop
 *   npm run callofstats:scrape -- --server 973 --alliance 12345       one alliance, all dates, then stop
 *   npm run callofstats:scrape -- --server 973 --from 2026-08-01       from a date back to oldest
 *   npm run callofstats:scrape -- --server 973 --date 2026-11-04       enrich one date only
 *   npm run callofstats:scrape -- --server 973 --wait 30               wait 30m between blocked passes
 *
 * Without --player/--alliance the run walks every player and every alliance one
 * at a time. For each player it fetches every known date (plus today) from
 * latest to oldest, then moves to the next. For each alliance it fetches every
 * known date (plus today) from latest to oldest, then moves to the next.
 * With --player <id> it fetches only that one player, all dates, then stops.
 * With --alliance <id> it fetches only that one alliance, all dates, then stops.
 * With --from YYYY-MM-DD it only fetches dates on or before that date,
 * going backward to the oldest available date.
 * With --date YYYY-MM-DD it fetches only that one date (enrich mode),
 * skipping dates that already have CallOfStats avatar + albums unless --force.
 *
 * The source gives an account a small page budget before it starts answering
 * every data page with a redirect. A run that hits that wall leaves the pairs
 * it did finish recorded, and the next run skips them and continues from where
 * it stopped - so repeated runs walk the whole roster instead of re-reading the
 * same first few dozen players forever.
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
const { scanServer, playerIdsFromScan } = require('../src/roster/api');
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
    player: null,
    alliance: null,
    from: null,
    date: null,
    out: null,
    dryRun: false,
    force: false,
    waitMinutes: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server') args.server = argv[++i];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]) || 4;
    else if (arg === '--stripe') args.stripe = Number(argv[++i]) || 0;
    else if (arg === '--player') args.player = argv[++i];
    else if (arg === '--alliance') args.alliance = argv[++i];
    else if (arg === '--from') args.from = argv[++i];
    else if (arg === '--date') args.date = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--wait') args.waitMinutes = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run callofstats:scrape -- --server 973 [--concurrency N] [--stripe N] [--player <id>] [--alliance <id>] [--from YYYY-MM-DD] [--date YYYY-MM-DD] [--out <dir>] [--dry-run] [--force] [--wait <minutes>]',
      );
      console.log('');
      console.log('Without --player/--alliance the run walks every player one at a time, fetching each');
      console.log('player\'s dates from latest to oldest before moving to the next player.');
      console.log('With --player <id> it fetches only that one player, all dates, then stops.');
      console.log('With --alliance <id> it fetches only that one alliance, all dates, then stops.');
      console.log('With --from YYYY-MM-DD it only fetches dates on or before that date,');
      console.log('going backward to the oldest available date.');
      console.log('With --date YYYY-MM-DD it fetches only that one date (enrich mode).');
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
 * Whether this player's file already carries the target date's detail.
 *
 * The scrape writes one date entry per player, so a run stopped by the
 * source's page budget has still marked everyone it reached. Treating that
 * entry as done is what lets the next run continue past them; `--force`
 * ignores it and re-reads the whole roster.
 */
function alreadyScraped(existing, date) {
  const entry = existing?.byDate?.[date];
  if (!entry) return false;
  // CallOfStats-specific enrichment: avatar + albums. Only skip when both are
  // already present. Dates from DragonStats (Oct 25+) carry stats sections but
  // no CallOfStats enrichment, so they still need a CallOfStats pass to fill in
  // avatar, albums, playstyle, alliance, and name history.
  return Boolean(entry.avatar && Array.isArray(entry.albums) && entry.albums.length > 0);
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
    alliance: lordData.alliance || existingEntry?.alliance || null,
    sections: [],
    achievements: existingEntry?.achievements || [],
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
  // Playstyle rows carry their own section and must not be keyed by label in stats.
  for (const row of lordData.playstyle || []) {
    const existingLabels = existingSections.get(row.section);
    if (existingLabels && existingLabels.has(row.label)) continue;
    if (!bySection.has(row.section)) bySection.set(row.section, []);
    bySection.get(row.section).push({ label: row.label, value: row.value });
  }
  entry.sections = [...bySection].map(([section, rows]) => ({ section, rows }));

  // Achievements from this lord page, merged by name.
  if (lordData.achievements && lordData.achievements.length) {
    const existingNames = new Set(entry.achievements.map((a) => a.name));
    for (const ach of lordData.achievements) {
      if (existingNames.has(ach.name)) continue;
      entry.achievements.push({
        name: ach.name,
        progress: ach.progressText || null,
        target: null,
        completedAt: null,
      });
      existingNames.add(ach.name);
    }
  }

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

  // Playstyle percentiles go to radar (separate from metrics), keyed by date.
  if (lordData.playstyle && lordData.playstyle.length) {
    if (!incoming.radar) incoming.radar = {};
    const radarEntry = {};
    for (const row of lordData.playstyle) {
      // Store percentiles as numbers ("27.28%" -> 27.28) so every consumer
      // does not have to know about the display decoration.
      const parsed = Number(String(row.value).replace(/,/g, '').replace(/%/g, '').trim());
      radarEntry[row.label] = Number.isFinite(parsed) ? parsed : row.value;
    }
    incoming.radar[date] = { ...(incoming.radar[date] || {}), ...radarEntry };
  }

  if (!incoming.byDate) incoming.byDate = {};
  incoming.byDate[date] = entry;

  return incoming;
}

/**
 * Turns extracted alliance-page data into an alliance file entry for one date.
 *
 * Alliance pages expose stat sections (war stats, server totals, etc.) but not
 * name history, avatar, or albums - so only sections and carried-over fields
 * are written.
 */
function enrichAlliance(existing, lordData, date) {
  const incoming = JSON.parse(JSON.stringify(existing || {}));
  const existingEntry = incoming.byDate && incoming.byDate[date];

  const entry = {
    name: existingEntry?.name || existing?.name || null,
    rank: existingEntry?.rank ?? null,
    power: existingEntry?.power ?? null,
    memberCount: existingEntry?.memberCount ?? null,
    players: existingEntry?.players || [],
    sections: [],
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

  incoming.dates = [...new Set([...(incoming.dates || []), date])].sort().reverse();

  if (!incoming.byDate) incoming.byDate = {};
  incoming.byDate[date] = entry;

  return incoming;
}

/**
 * Processes (alliance, date) pairs one at a time through the paced source.
 *
 * Each pair is one alliance-page fetch. Alliances are walked one at a time and,
 * within an alliance, dates are walked latest to oldest, so a run stopped by the
 * source's page budget resumes exactly where it left off on the next run.
 */
async function processPlayers(source, store, work, dryRun, force = false) {
  const results = {
    processed: 0,
    skipped: 0,
    errors: [],
    bytes: 0,
    blocked: false,
  };
  const progress = createProgress({ total: work.length, tag: 'CALLSTATS' });
  const existingCache = new Map();
  let index = 0;

  async function existingFor(playerId) {
    if (existingCache.has(playerId)) return existingCache.get(playerId);
    let existing;
    try {
      existing = await store.get(`players/${playerId}.json`);
    } catch (getErr) {
      results.errors.push({ playerId, message: `store.get: ${getErr.message}` });
      existingCache.set(playerId, null);
      return null;
    }
    existingCache.set(playerId, existing);
    return existing;
  }

  for (const { playerId, date } of work) {
    index += 1;
    const itemStarted = Date.now();
    const existing = await existingFor(playerId);

    if (!force && alreadyScraped(existing, date)) {
      results.skipped += 1;
      progress.item({
        index,
        id: playerId,
        name: existing?.name,
        status: 'skipped',
        detail: `already scraped for ${date}`,
        count: false,
      });
      continue;
    }

    progress.item({
      index,
      id: playerId,
      name: existing?.name,
      status: 'info',
      detail: `fetching ${date} lord page…`,
      count: false,
    });
    try {
      const page = await source.fetch(playerId, date);
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

      const enriched = enrichPlayer(existing, lordData, date);
      if (lordName && !enriched.name) enriched.name = lordName;

      const merged = mergeFile('player', existing, enriched);

      if (!dryRun) {
        const bytes = await store.put(`players/${playerId}.json`, merged, { cacheControl: 'public, max-age=3600' });
        results.bytes += bytes;
        existingCache.set(playerId, merged);
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

async function processAlliances(source, store, work, dryRun, force = false) {
  const results = {
    processed: 0,
    skipped: 0,
    errors: [],
    bytes: 0,
    blocked: false,
  };
  const progress = createProgress({ total: work.length, tag: 'CALLSTATS' });
  const existingCache = new Map();
  let index = 0;

  async function existingFor(allianceId) {
    if (existingCache.has(allianceId)) return existingCache.get(allianceId);
    let existing;
    try {
      existing = await store.get(`alliances/${allianceId}.json`);
    } catch (getErr) {
      results.errors.push({ allianceId, message: `store.get: ${getErr.message}` });
      existingCache.set(allianceId, null);
      return null;
    }
    existingCache.set(allianceId, existing);
    return existing;
  }

  for (const { allianceId, date } of work) {
    index += 1;
    const itemStarted = Date.now();
    const existing = await existingFor(allianceId);

    if (!force && alreadyScraped(existing, date)) {
      results.skipped += 1;
      progress.item({
        index,
        id: allianceId,
        name: existing?.name,
        status: 'skipped',
        detail: `already scraped for ${date}`,
        count: false,
      });
      continue;
    }

    progress.item({
      index,
      id: allianceId,
      name: existing?.name,
      status: 'info',
      detail: `fetching ${date} alliance page…`,
      count: false,
    });
    try {
      const page = await source.fetch(allianceId, date);
      if (!page.ok) {
        if (page.blocked) {
          results.blocked = true;
          progress.item({
            index,
            id: allianceId,
            name: existing?.name,
            status: 'error',
            detail: source.blockedReason,
            ms: Date.now() - itemStarted,
          });
          break;
        }
        results.errors.push({ allianceId, message: 'Could not reach alliance page after retries' });
        progress.item({
          index,
          id: allianceId,
          name: existing?.name,
          status: 'error',
          detail: 'cannot reach alliance page',
          ms: Date.now() - itemStarted,
        });
        continue;
      }

      const lordData = await source.read(page.html);
      if (!lordData) {
        results.errors.push({ allianceId, message: 'Empty alliance page' });
        progress.item({
          index,
          id: allianceId,
          name: existing?.name,
          status: 'error',
          detail: 'empty alliance page',
          ms: Date.now() - itemStarted,
        });
        continue;
      }

      const enriched = enrichAlliance(existing, lordData, date);

      const merged = mergeFile('alliance', existing, enriched);

      if (!dryRun) {
        const bytes = await store.put(`alliances/${allianceId}.json`, merged, { cacheControl: 'public, max-age=3600' });
        results.bytes += bytes;
        existingCache.set(allianceId, merged);
      }

      results.processed += 1;
      if (!existing) {
        // Count new alliances only if they had no prior file
      }
      progress.item({
        index,
        id: allianceId,
        name: merged.name || existing?.name,
        status: 'done',
        detail: existing ? (dryRun ? 'dry run, nothing written' : null) : 'new alliance',
        ms: Date.now() - itemStarted,
      });
    } catch (err) {
      results.errors.push({ allianceId, message: err.message });
      progress.item({
        index,
        id: allianceId,
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

  // Build the player list. Prefer today's own roster: a player who migrated out
  // is not on the server today, so reading their lord page spends the account's
  // page budget on a row the website will not show. Fall back to every player
  // file when there is no snapshot for today yet. --player overrides the lot
  // and scrapes exactly that one id.
  const playerKeys = await store.list(PLAYERS_PREFIX);
  const allPlayerIds = playerKeys.map((key) => path.basename(key, '.json'));
  console.log(`[CALLSTATS] Found ${allPlayerIds.length} existing player files in ${store.label}`);

  let playerIds;
  if (args.player) {
    if (!allPlayerIds.includes(args.player)) {
      console.log(
        `[CALLSTATS] --player ${args.player} has no existing file yet; fetching it anyway.`,
      );
    }
    playerIds = [args.player];
    console.log(`[CALLSTATS] Scraping only player ${args.player}.`);
  } else if (process.env.CALLOFSTATS_API_KEY) {
    // The API returns the server roster (lord_id per player) for one date at
    // a cost of 2 Dracoin; repeat scans of the same server+date are free.
    // Use it as the roster source so a run can start from scratch without any
    // existing player files or snapshots.
    try {
      const apiRoster = await scanServer(Number(args.server), {
        selectedDate: targetDate,
        minimumPower: 0,
      });
      console.log(
        `[CALLSTATS] API scan returned ${apiRoster.main?.length ?? 0} players for ${targetDate}`,
      );

      if (!args.dryRun) {
        await store.put(`api-scans/${targetDate}.json`, apiRoster, {
          cacheControl: 'public, max-age=3600',
        });
      }

      const apiPlayerIds = playerIdsFromScan(apiRoster);
      if (apiPlayerIds.length) {
        playerIds = apiPlayerIds;
        console.log(`[CALLSTATS] Using ${playerIds.length} players from API scan.`);
      } else {
        console.warn(`[CALLSTATS] API scan returned no players; falling back to snapshot/files.`);
      }
    } catch (err) {
      const extra =
        err.newBalance != null ? ` balance=${err.newBalance}` :
        err.status === 402 ? ' (insufficient Dracoin)' : '';
      console.warn(`[CALLSTATS] API scan failed: ${err.message}${extra}; falling back to snapshot/files.`);
    }
  }

  if (!playerIds) {
    const snapshot = await store.get(`snapshots/${targetDate}.json`).catch(() => null);
    const roster = [
      ...new Set(
        (snapshot?.players || [])
          .map((player) => (typeof player === 'string' ? player : player?.id))
          .filter(Boolean),
      ),
    ];
    playerIds = roster.length ? roster : allPlayerIds;
    console.log(
      roster.length
        ? `[CALLSTATS] Using ${playerIds.length} players from snapshots/${targetDate}.json`
        : `[CALLSTATS] No snapshot for ${targetDate}; using all ${playerIds.length} player files`,
    );
  }

  // Build the alliance list from the snapshot/API roster.
  let allianceIds;
  if (args.alliance) {
    allianceIds = [args.alliance];
    console.log(`[CALLSTATS] Scraping only alliance ${args.alliance}.`);
  } else {
    const snapshot = await store.get(`snapshots/${targetDate}.json`).catch(() => null);
    const alliances = [
      ...new Set(
        (snapshot?.alliances || [])
          .map((a) => (typeof a === 'string' ? a : a?.id))
          .filter(Boolean),
      ),
    ];
    allianceIds = alliances.length ? alliances : [];
    console.log(
      alliances.length
        ? `[CALLSTATS] Using ${allianceIds.length} alliances from snapshots/${targetDate}.json`
        : `[CALLSTATS] No alliances found for ${targetDate}.`,
    );
  }

  // Collect dates to scrape. --date restricts to exactly one date (enrich mode).
  // --from limits to dates on or before that date. Without either, all known
  // dates plus today are included.
  const fromDate = args.from;
  const singleDate = args.date;
  const allDates = new Set();
  if (singleDate) {
    allDates.add(singleDate);
  } else {
    if (!fromDate || targetDate <= fromDate) allDates.add(targetDate);
    for (const playerId of playerIds) {
      const existing = await store.get(`players/${playerId}.json`).catch(() => null);
      if (existing && Array.isArray(existing.dates)) {
        for (const d of existing.dates) {
          if (!fromDate || d <= fromDate) allDates.add(d);
        }
      }
    }
    for (const allianceId of allianceIds) {
      const existing = await store.get(`alliances/${allianceId}.json`).catch(() => null);
      if (existing && Array.isArray(existing.dates)) {
        for (const d of existing.dates) {
          if (!fromDate || d <= fromDate) allDates.add(d);
        }
      }
    }
  }
  const dates = [...allDates].sort().reverse();
  console.log(
    `[CALLSTATS] Dates to collect (latest first): ${dates.join(', ')}` +
      (singleDate ? ` (single date: ${singleDate})` : fromDate ? ` (from ${fromDate} backward)` : ''),
  );

  // Build the (player, date) work list, newest date first for each player.
  // --force re-reads every pair; otherwise anything already written is skipped.
  const playerWork = [];
  if (!args.alliance) {
    for (const playerId of playerIds) {
      const existing = await store.get(`players/${playerId}.json`).catch(() => null);
      for (const date of dates) {
        if (!args.force && alreadyScraped(existing, date)) continue;
        playerWork.push({ playerId, date });
      }
    }
    console.log(`[CALLSTATS] ${playerWork.length} (player, date) pairs to fetch.`);
  }

  // Build the (alliance, date) work list, newest date first for each alliance.
  const allianceWork = [];
  if (!args.player) {
    for (const allianceId of allianceIds) {
      const existing = await store.get(`alliances/${allianceId}.json`).catch(() => null);
      for (const date of dates) {
        if (!args.force && alreadyScraped(existing, date)) continue;
        allianceWork.push({ allianceId, date });
      }
    }
    console.log(`[CALLSTATS] ${allianceWork.length} (alliance, date) pairs to fetch.`);
  }

  const started = Date.now();
  const waitMs = Math.max(0, (args.waitMinutes || 0) * 60 * 1000);
  // With no wait there is nothing to retry against: the next scheduled run
  // resumes from the pairs this one finished. A wait turns the run into a
  // loop that sits out the source's refusal window and carries on, which is
  // what makes an overnight pass cover the whole roster.
  const maxPasses = waitMs > 0 ? 12 : 1;
  const totals = {
    processed: 0,
    skipped: 0,
    newPlayers: 0,
    bytes: 0,
    errors: [],
    blocked: false,
    blockedReason: null,
  };

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const source = createLordSource({ tag: 'CALLSTATS', stripe: args.stripe });
    let playerResult;
    let allianceResult;
    try {
      // Force only the first pass: a later pass must be able to skip what the
      // earlier one already wrote, or the loop re-reads the same pairs.
      if (!args.alliance) {
        playerResult = await processPlayers(
          source,
          store,
          playerWork,
          args.dryRun,
          args.force && pass === 1,
        );
      }
      if (!args.player && allianceWork.length > 0) {
        allianceResult = await processAlliances(
          source,
          store,
          allianceWork,
          args.dryRun,
          args.force && pass === 1,
        );
      }
    } finally {
      await source.close();
    }

    if (playerResult) {
      totals.processed += playerResult.processed;
      totals.skipped += playerResult.skipped;
      totals.newPlayers += playerResult.newPlayers;
      totals.bytes += playerResult.bytes;
      totals.errors.push(...playerResult.errors);
      if (playerResult.blocked) {
        totals.blocked = true;
        totals.blockedReason = playerResult.blockedReason;
      }
    }
    if (allianceResult) {
      totals.processed += allianceResult.processed;
      totals.skipped += allianceResult.skipped;
      totals.bytes += allianceResult.bytes;
      totals.errors.push(...allianceResult.errors);
      if (allianceResult.blocked) {
        totals.blocked = true;
        totals.blockedReason = allianceResult.blockedReason;
      }
    }

    if (!totals.blocked || !waitMs || pass === maxPasses) break;

    console.log(
      `[CALLSTATS] Blocked (${totals.blockedReason}); waiting ${args.waitMinutes} minute(s) ` +
        `before pass ${pass + 1} of ${maxPasses}.`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const result = totals;

  for (const e of result.errors) {
    const who = e.allianceId ? `alliance ${e.allianceId}` : `player ${e.playerId}`;
    console.warn(`[CALLSTATS] error: ${who}: ${e.message}`);
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
