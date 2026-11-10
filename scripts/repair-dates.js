/**
 * Re-publishes one or more dates from DragonStats' own scan for that day.
 *
 *   npm run repair -- --server 973 --dates 2026-10-25,2026-11-03
 *   npm run repair -- --server 973 --since 2026-10-25 --dry-run
 *   npm run repair -- --server 973 --dates 2026-11-03 --out ./.export
 *
 * Why this exists: a backfill that ran `scrape.js --date <d>` published the
 * newest scan under nine other dates (2026-10-25, 10-31, 11-01..11-06,
 * 11-09), so those days held another day's numbers. Every delta across them
 * read 0 and the activity trend collapsed on the duplicated pairs. The normal
 * scrape cannot fix that: its merge is additive by design ("never remove"),
 * so a stale player row would survive the correction. This script repairs a
 * date in place with replace semantics where the corrupt run wrote, and keeps
 * everything additive everywhere else:
 *
 *   snapshot        rebuilt from the day's own scan - stale rows drop out
 *   player files    merged (values of that day corrected, enrichment kept);
 *                   players the day's scan does not list have the scan-owned
 *                   fields for that date stripped rather than left wrong
 *   alliance files  that day's entry rebuilt from the day's own membership
 *
 * index.json is untouched: the date set does not change.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const api = require('../src/dragon/api');
const map = require('../src/dragon/map');
const { allianceResolver } = require('../src/dragon/resolve');
const { buildLeadershipSummary } = require('../src/roster/leadership');
const r2 = require('../src/roster/r2');
const { mergeFile } = require('../src/roster/merge');
const { carryForward } = require('../src/roster/carry');

const PLAYERS = 'players';
const ALLIANCES = 'alliances';
const SNAPSHOTS = 'snapshots';

/** Fields a DragonStats scan writes into a player's day-entry. */
const SCAN_SCALARS = ['power', 'rank', 'alliance'];

function parseArgs(argv) {
  const args = {
    servers: null,
    dates: null,
    since: null,
    out: null,
    dryRun: false,
    concurrency: 8,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server') args.servers = argv[++i];
    else if (arg === '--dates') args.dates = argv[++i];
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]) || 8;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run repair -- --server 973 (--dates YYYY-MM-DD,.. | --since YYYY-MM-DD) [--out <dir>] [--dry-run] [--concurrency N]',
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.servers) throw new Error('--server is required, for example --server 973');
  if (!args.dates && !args.since) throw new Error('--dates or --since is required.');
  if (args.dates && !args.dates.split(',').every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.trim()))) {
    throw new Error(`--dates must be a comma separated list of YYYY-MM-DD, got "${args.dates}"`);
  }
  return args;
}

/** R2 in production, a directory for --out / --dry-run inspection. */
function remoteStore() {
  return {
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

function localStore(dir) {
  const resolve = (key) => path.join(dir, key);
  return {
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

/**
 * A directory that reads through to R2 when the bucket is configured: the
 * preview starts from the real archive (so merges, carry-forward and the
 * alliance resolver behave exactly as they would in production) and every
 * write lands locally, where the result can be diffed before publishing.
 */
function createStore({ dir }) {
  if (!dir) {
    const remote = remoteStore();
    return { label: `R2 bucket "${r2.config().bucket}"`, ...remote };
  }
  const local = localStore(dir);
  if (!r2.configured()) {
    return { label: `${path.resolve(dir)} (no R2 configured, local only)`, ...local };
  }
  const remote = remoteStore();
  return {
    label: `${path.resolve(dir)} (reading through to R2)`,
    async get(key) {
      const own = await local.get(key);
      if (own) return own;
      return remote.get(key);
    },
    put: (key, value, options) => local.put(key, value, options),
    async list(prefix) {
      const [here, there] = await Promise.all([local.list(prefix), remote.list(prefix)]);
      return [...new Set([...here, ...there])];
    },
  };
}

async function pool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function allianceIdsFrom(snapshot) {
  const out = {};
  for (const alliance of snapshot?.alliances || []) {
    if (alliance?.name && alliance?.id) out[alliance.name] = alliance.id;
  }
  return out;
}

function describe(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Every label and metric key a DragonStats scan contributes to a day. */
function scanOwnedLabels(built, date) {
  const labels = new Set();
  for (const player of built.players.values()) {
    for (const block of player.byDate[date]?.sections || []) {
      for (const row of block.rows || []) labels.add(row.label);
    }
    for (const key of Object.keys(player.metrics[date] || {})) {
      labels.add(key);
    }
  }
  return labels;
}

/**
 * Strips the scan-owned data of one date from a player the day's own scan
 * does not list. What the corrupt run wrote for that date is wrong; missing
 * is better than wrong. Enrichment the date really had (albums, achievements,
 * callofstats-only stat rows) survives.
 */
function stripUnknownDay(entry, owned) {
  if (!entry) return null;
  const sections = (entry.sections || [])
    .map((block) => ({
      ...block,
      rows: (block.rows || []).filter((row) => !owned.has(row.label)),
    }))
    .filter((block) => block.rows.length);

  const kept = { ...entry };
  for (const field of SCAN_SCALARS) delete kept[field];
  if (sections.length) kept.sections = sections;
  else delete kept.sections;

  const empty =
    !kept.albums?.length &&
    !kept.achievements?.length &&
    !kept.avatar &&
    !kept.sections &&
    !kept.name;
  return empty ? null : kept;
}

async function repairDate(server, date, args, store, scansByDate) {
  const scanInfo = scansByDate.get(date);
  if (!scanInfo) throw new Error(`DragonStats has no scan published on ${date}.`);

  const scan = await api.fetchScan(scanInfo.url);
  const existingSnapshot = await store.get(`${SNAPSHOTS}/${date}.json`);
  const index = await store.get('index.json');
  const latestSnapshot = index?.latest ? await store.get(`${SNAPSHOTS}/${index.latest}.json`) : null;

  // Load every player the day's scan lists so the alliance resolver can walk
  // their history (and so the merge does not fetch them twice).
  const scanIds = [
    ...new Set(scan.map((record) => String(record.id || '').trim()).filter(Boolean)),
  ];
  const existingById = new Map();
  await pool(scanIds, args.concurrency, async (id) => {
    const file = await store.get(`${PLAYERS}/${id}.json`);
    if (file) existingById.set(id, file);
  });

  const built = map.fromScan(scan, {
    server,
    date,
    existingAlliances: {
      ...allianceIdsFrom(existingSnapshot),
      ...allianceIdsFrom(latestSnapshot),
    },
    crawledAt: scanInfo.createdAt,
    serverUrl: `https://dragonstats.com/dashboard/${server}`,
    resolveAlliance: allianceResolver(existingById, date),
  });

  const owned = scanOwnedLabels(built, date);
  const carried = [...built.players.values()].filter(
    (player) => player.byDate[date].alliance && player.byDate[date].alliance !== 'Not In An Alliance',
  ).length;

  // 1. Snapshot: rebuilt, not merged - this is the whole point.
  const snapshotBytes = await store.put(`${SNAPSHOTS}/${date}.json`, built.snapshot, {
    cacheControl: 'public, max-age=3600',
  });

  // Players the day's corrupt snapshot lists but the day's own scan does not:
  // their entry for the date came from the wrong scan and must be stripped,
  // not left behind by the additive merge.
  const scanIdSet = new Set(scanIds);
  const extraIds = [...new Set(
    (existingSnapshot?.players || [])
      .map((player) => String(player.id || '').trim())
      .filter((id) => id && !scanIdSet.has(id)),
  )];
  const extraFiles = await pool(extraIds, args.concurrency, async (id) => {
    const file = await store.get(`${PLAYERS}/${id}.json`);
    return file ? { id, file } : null;
  });

  // 2. Player files: merge (corrects the day's values, keeps enrichment), and
  //    strip the scan-owned fields of that day from players the scan omits.
  let stripped = 0;
  let written = 0;
  const merges = await pool([...existingById.entries()], args.concurrency, async ([id, existing]) => {
    const incoming = built.players.get(id);
    if (!incoming) return null;
    const value = mergeFile('player', existing, carryForward(existing, incoming, date));
    return { key: `${PLAYERS}/${id}.json`, value, mode: 'merge' };
  });

  const strips = extraFiles.flatMap((item) => {
    if (!item) return [];
    const { id, file } = item;
    const entry = file.byDate?.[date];
    if (!entry) return [];
    const value = { ...file, byDate: { ...file.byDate } };
    const cleaned = stripUnknownDay(entry, owned);
    if (cleaned) {
      value.byDate[date] = cleaned;
    } else {
      delete value.byDate[date];
      if (value.metrics) delete value.metrics[date];
      if (value.radar) delete value.radar[date];
      value.dates = (value.dates || []).filter((d) => d !== date);
      if (!value.dates.length) return [];
    }
    if (value.metrics && !Object.keys(value.metrics).length) delete value.metrics;
    return [{ key: `${PLAYERS}/${id}.json`, value, mode: 'strip' }];
  });

  // Players the scan lists but whose file we do not have yet.
  const news = [];
  for (const [id, incoming] of built.players) {
    if (!existingById.has(id)) {
      news.push({
        key: `${PLAYERS}/${id}.json`,
        value: mergeFile('player', null, carryForward(null, incoming, date)),
        mode: 'new',
      });
    }
  }

  for (const item of [...merges, ...strips, ...news]) {
    if (!item) continue;
    await store.put(item.key, item.value, { cacheControl: 'public, max-age=3600' });
    // Keep the in-memory copy truthful: the leadership summary builder below
    // reads from it instead of re-fetching every repaired file.
    existingById.set(path.basename(item.key, '.json'), item.value);
    written += 1;
    if (item.mode === 'strip') stripped += 1;
  }

  // 3. Alliance files: that day's entry is rebuilt from the day's own
  //    membership; alliances the scan does not list lose the entry.
  const builtAllianceIds = new Set(built.alliances.map((alliance) => alliance.id));
  const allianceKeys = new Set([
    ...(await store.list(`${ALLIANCES}/`)),
    ...built.alliances.map((alliance) => `${ALLIANCES}/${alliance.id}.json`),
  ]);
  let allianceBytes = 0;
  await pool([...allianceKeys], args.concurrency, async (key) => {
    const id = path.basename(key, '.json');
    const existing = await store.get(key);
    const incoming = built.alliances.find((alliance) => alliance.id === id);
    if (incoming) {
      const entry = {
        ...(existing?.byDate?.[date] || {}),
        ...allianceEntry(incoming, date, built.snapshot.players),
      };
      const value = {
        ...(existing || { id, name: incoming.name, dates: [] }),
        id,
        name: incoming.name,
        dates: [...new Set([...(existing?.dates || []), date])].sort().reverse(),
        byDate: { ...(existing?.byDate || {}), [date]: entry },
      };
      allianceBytes += await store.put(key, value, { cacheControl: 'public, max-age=3600' });
      return;
    }
    if (existing?.byDate?.[date]) {
      const byDate = { ...existing.byDate };
      const gone = byDate[date];
      delete byDate[date];
      // Keep enrichment the date really had (alliance albums and the like).
      const leftovers = Object.fromEntries(
        Object.entries(gone || {}).filter(
          ([field]) => !['rank', 'power', 'memberCount', 'players'].includes(field),
        ),
      );
      const dates = (existing.dates || []).filter((d) => d !== date);
      if (Object.keys(leftovers).length && leftovers.albums?.length) {
        byDate[date] = { name: existing.name, ...leftovers };
        dates.push(date);
      }
      const value = { ...existing, byDate, dates: dates.sort().reverse() };
      allianceBytes += await store.put(key, value, { cacheControl: 'public, max-age=3600' });
    }
  });

  const carriedNote = carried < built.players.size
    ? `, ${built.players.size - carried} unallied`
    : '';

  // Refresh this day's leadership summary so the web's fast path picks up the
  // repaired numbers (a missing summary only costs the slow read, but a stale
  // one would serve the old, wrong window).
  let summaryWritten = false;
  const summary = await buildLeadershipSummary(store, date, { files: existingById });
  if (summary) {
    await store.put(`leadership/${date}.json`, summary, {
      cacheControl: 'public, max-age=3600',
    });
    summaryWritten = true;
  }

  return {
    date,
    players: built.snapshot.players.length,
    alliances: built.alliances.length,
    written,
    stripped,
    carried,
    bytes: snapshotBytes + allianceBytes,
    summary: summaryWritten,
    note: carriedNote,
  };
}

/** One alliance's entry for one date, in the shape archive.js writes. */
function allianceEntry(alliance, date, players) {
  const members = players
    .filter((player) => player.allianceId === alliance.name)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((player) => ({
      id: player.id,
      name: player.name,
      rank: player.index,
      power: Number(String(player.stats.Power).replace(/,/g, '')) || null,
    }));
  return {
    name: alliance.name,
    rank: alliance.rank,
    power: Number(String(alliance.stats.Power).replace(/,/g, '')) || null,
    memberCount: Number(alliance.stats.Members) || members.length,
    players: members,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out && !args.dryRun && !r2.configured()) {
    throw new Error(
      `R2 is not configured (missing ${r2.describeMissing()}). ` +
        'Add the R2_* variables to .env, or pass --out <dir> / --dry-run to write the files locally.',
    );
  }

  // A dry run must never touch the bucket: without an explicit --out it
  // writes into a local directory that can be diffed instead.
  const outDir = args.out || (args.dryRun ? path.join(__dirname, '..', 'data', 'repair-dry-run') : null);
  const store = createStore({ dir: outDir });
  const server = args.servers.split(',').map((v) => v.trim().replace(/^#/, ''))[0];

  // One token use up front: the scan list needs the gate, the scan files and
  // the bucket do not.
  const scansByDate = new Map();
  await api.withClient(async (client, gate) => {
    const records = (await api.scans(client, gate, server)).filter((r) => r.externalUrl);
    for (const record of records) {
      const createdAt = new Date(record._creationTime || 0);
      const day = createdAt.toISOString().slice(0, 10);
      const current = scansByDate.get(day);
      if (!current || createdAt > current.createdAt) {
        scansByDate.set(day, { url: record.externalUrl, createdAt });
      }
    }
  });

  let dates;
  if (args.dates) {
    dates = args.dates.split(',').map((d) => d.trim()).sort();
  } else {
    dates = [...scansByDate.keys()].filter((day) => day >= args.since).sort();
  }

  console.log(`[REPAIR] #${server} -> ${store.label}`);
  console.log(`[REPAIR] ${dates.length} date(s): ${dates.join(', ')}`);

  const rows = [];
  for (const date of dates) {
    const started = Date.now();
    try {
      const result = await repairDate(server, date, args, store, scansByDate);
      rows.push(result);
      console.log(
        `[REPAIR] ${date}: ${result.players} players, ${result.alliances} alliances, ` +
          `${result.written} player files (${result.stripped} stripped), ` +
          `${describe(result.bytes)}, ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      console.error(`[REPAIR] ${date} FAILED: ${err.message}`);
      rows.push({ date, error: err.message });
    }
  }

  const failed = rows.filter((row) => row.error);
  console.log(
    `[REPAIR] done: ${rows.length - failed.length} repaired, ${failed.length} failed.`,
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[REPAIR] Failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
