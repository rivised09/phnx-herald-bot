/**
 * Scrapes one or more servers from DragonStats and publishes them to R2.
 *
 *   npm run scrape -- --server 973
 *   npm run scrape -- --server 973,1014
 *   npm run scrape -- --server 973 --date 2026-10-26
 *   npm run scrape -- --server 973 --out ./.export       write to a directory
 *   npm run scrape -- --server 973 --scan data/scan.json  reuse a saved scan
 *   npm run scrape -- --server 973 --dry-run              fetch and build, write nothing
 *
 * The scrape itself is two steps: the newest scan for the server is fetched
 * from DragonStats' public R2, then it is mapped onto the shape the site
 * already reads (src/dragon/map.js). Everything after that is the same
 * additive merge the export uses, so a DragonStats day can be added next to 65
 * callofstats days without either source being able to erase the other.
 *
 * Files are written snapshot/player/alliance first and `index.json` last: a
 * reader that picks up the new index never finds a date the bucket lacks.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const api = require('../src/dragon/api');
const map = require('../src/dragon/map');
const r2 = require('../src/roster/r2');
const { mergeFile } = require('../src/roster/merge');
const { carryForward } = require('../src/roster/carry');
const { createProgress } = require('../src/utils/progress');

const PLAYERS = 'players';
const ALLIANCES = 'alliances';
const SNAPSHOTS = 'snapshots';

function parseArgs(argv) {
  const args = {
    servers: null,
    date: null,
    scanDate: null,
    out: null,
    scan: null,
    'scan-index': 0,
    dryRun: false,
    concurrency: 8,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--server') args.servers = argv[++index];
    else if (arg === '--date') args.date = argv[++index];
    else if (arg === '--scan-date') args.scanDate = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--scan') args.scan = argv[++index];
    else if (arg === '--scan-index') args['scan-index'] = Number(argv[++index]) || 0;
    else if (arg === '--concurrency') args.concurrency = Number(argv[++index]) || 8;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run scrape -- --server 973[,1014] [--date YYYY-MM-DD] [--scan-date YYYY-MM-DD] [--out <dir>] [--scan <file>] [--scan-index N] [--dry-run]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.servers) throw new Error('--server is required, for example --server 973');
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${args.date}"`);
  }
  if (args.scanDate && !/^\d{4}-\d{2}-\d{2}$/.test(args.scanDate)) {
    throw new Error(`--scan-date must be YYYY-MM-DD, got "${args.scanDate}"`);
  }
  return args;
}

/**
 * Reads and writes the archive, either in R2 or in a directory.
 *
 * The directory mode exists for the same reason the export has one: the merge
 * can be exercised against a real 65-date archive without credentials, and the
 * result can be diffed before anything is published.
 */
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

/** Runs `work` over `items`, at most `limit` at a time. */
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

function describe(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** name -> id from the newest published snapshot, so alliance pages stay stable. */
function allianceIdsFrom(snapshot) {
  const out = {};
  for (const alliance of snapshot?.alliances || []) {
    if (alliance?.name && alliance?.id) out[alliance.name] = alliance.id;
  }
  return out;
}

/** Everything the scan at `scanIndex` for `server` says, in our shape. */
async function collect(server, args, scanIndex = 0) {
  if (args.scan) {
    const scan = JSON.parse(fs.readFileSync(path.resolve(args.scan), 'utf8'));
    const createdAt = new Date();
    return {
      scan,
      createdAt,
      serverId: null,
      serverUrl: null,
    };
  }

  return api.withClient(async (client, gate) => {
    const found = await api.findServer(client, gate, server);
    if (!found) throw new Error(`DragonStats does not track server #${server}.`);
    const latest = args.scanDate
      ? await api.scanOnDate(client, gate, server, args.scanDate)
      : await api.scanAt(client, gate, server, scanIndex);
    if (!latest) {
      throw new Error(
        args.scanDate
          ? `Server #${server} has no scan published on ${args.scanDate}.`
          : `Server #${server} has no scans on DragonStats yet.`,
      );
    }

    console.log(`[SCRAPE] #${server} -> ${found._id}, scan ${latest.createdAt.toISOString()}`);
    const scan = await api.fetchScan(latest.url);
    console.log(`[SCRAPE] #${server}: ${scan.length} players (${latest.url.split('/').pop()})`);

    return {
      scan,
      createdAt: latest.createdAt,
      serverId: found._id,
      serverUrl: `https://dragonstats.com/dashboard/${found._id}`,
    };
  });
}

async function scrapeServer(server, args, scanIndex, store) {
  const started = Date.now();
  const collected = await collect(server, args, scanIndex);
  const date = args.date || args.scanDate || collected.createdAt.toISOString().slice(0, 10);

  const existingIndex = await store.get('index.json');
  const existingLatest = existingIndex?.latest
    ? await store.get(`snapshots/${existingIndex.latest}.json`)
    : null;
  const existingAlliances = allianceIdsFrom(existingLatest);

  const built = map.fromScan(collected.scan, {
    server,
    date,
    existingAlliances,
    crawledAt: collected.createdAt,
    serverUrl: collected.serverUrl,
  });

  console.log(
    `[SCRAPE] #${server} ${date}: ${built.snapshot.players.length} players, ` +
      `${built.alliances.length} alliances, ` +
      `${Object.keys([...built.players.values()][0].metrics[date]).length} metrics per player`,
  );

  // Merge every file against what is published, so a day from one source never
  // removes a field the other source recorded.
  const snapshotKey = `snapshots/${date}.json`;
  const snapshot = mergeFile('snapshot', await store.get(snapshotKey), built.snapshot);

  const players = await pool([...built.players.values()], args.concurrency, async (player) => {
    const key = `${PLAYERS}/${player.id}.json`;
    const existing = await store.get(key);
    return { key, value: mergeFile('player', existing, carryForward(existing, player, date)) };
  });

  const alliances = await pool([...built.alliances], args.concurrency, async (alliance) => {
    const key = `${ALLIANCES}/${alliance.id}.json`;
    const incoming = allianceFile(alliance, date, built.snapshot.players);
    return { key, value: mergeFile('alliance', await store.get(key), incoming) };
  });

  if (args.dryRun) {
    const metrics = Object.keys([...built.players.values()][0].metrics[date]).length;
    console.log(
      `[SCRAPE] #${server} ${date}: dry run, ${players.length} player files, ` +
        `${alliances.length} alliance files, ${metrics} metrics. Nothing written.`,
    );
    return { date, players: players.length, alliances: alliances.length };
  }

  let bytes = 0;
  const snapshotBytes = await store.put(snapshotKey, snapshot, {
    cacheControl: 'public, max-age=3600',
  });
  bytes += snapshotBytes;
  console.log(`[SCRAPE] wrote ${snapshotKey} · ${describe(snapshotBytes)}`);

  const playerProgress = createProgress({ total: players.length, tag: 'SCRAPE' });
  let playerIndex = 0;
  for (const item of players) {
    playerIndex += 1;
    const itemStarted = Date.now();
    const size = await store.put(item.key, item.value, { cacheControl: 'public, max-age=3600' });
    bytes += size;
    playerProgress.item({
      index: playerIndex,
      id: path.basename(item.key, '.json'),
      name: item.value?.name,
      status: 'done',
      detail: describe(size),
      ms: Date.now() - itemStarted,
    });
  }
  playerProgress.bar();

  const allianceProgress = createProgress({ total: alliances.length, tag: 'SCRAPE' });
  let allianceIndex = 0;
  for (const item of alliances) {
    allianceIndex += 1;
    const itemStarted = Date.now();
    const size = await store.put(item.key, item.value, { cacheControl: 'public, max-age=3600' });
    bytes += size;
    allianceProgress.item({
      index: allianceIndex,
      id: null,
      name: item.value?.name,
      status: 'done',
      detail: `alliance · ${describe(size)}`,
      ms: Date.now() - itemStarted,
    });
  }
  allianceProgress.bar();

  const index = await buildIndex(store, existingIndex, {
    server,
    date,
    serverUrl: collected.serverUrl,
  });
  bytes += await store.put('index.json', index, { cacheControl: 'public, max-age=60' });

  console.log(
    `[SCRAPE] #${server} ${date}: published ${players.length + alliances.length + 2} files, ` +
      `${describe(bytes)}, ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(${index.counts.snapshots} dates, ${index.counts.players} players, ${index.counts.alliances} alliances)`,
  );
  return { date, players: players.length, alliances: alliances.length };
}

/**
 * The index, recounted from the files themselves.
 *
 * Counting the keys rather than incrementing a stored number means a scrape
 * cannot drift from what the bucket holds, even if a run was interrupted after
 * some of the player files were written.
 */
async function buildIndex(store, existing, { server, date, serverUrl }) {
  const [snapshotKeys, playerKeys, allianceKeys] = await Promise.all([
    store.list(`${SNAPSHOTS}/`),
    store.list(`${PLAYERS}/`),
    store.list(`${ALLIANCES}/`),
  ]);

  const dates = [
    ...new Set([
      ...(existing?.dates || []),
      ...snapshotKeys.map((key) => path.basename(key, '.json')),
      date,
    ]),
  ].sort().reverse();

  return {
    version: 1,
    server: existing?.server || { id: String(server), url: serverUrl || `https://dragonstats.com/dashboard/${server}` },
    latest: dates[0],
    dates,
    generatedAt: new Date().toISOString(),
    counts: {
      snapshots: dates.length,
      players: playerKeys.length,
      alliances: allianceKeys.length,
    },
  };
}

/** One alliance's file for one date, in the shape src/roster/archive.js writes. */
function allianceFile(alliance, date, players) {
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
    id: alliance.id,
    name: alliance.name,
    dates: [date],
    byDate: {
      [date]: {
        name: alliance.name,
        rank: alliance.rank,
        power: Number(String(alliance.stats.Power).replace(/,/g, '')) || null,
        memberCount: Number(alliance.stats.Members) || members.length,
        players: members,
      },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out && !args.dryRun && !r2.configured()) {
    throw new Error(
      `R2 is not configured (missing ${r2.describeMissing()}). ` +
        'Add the R2_* variables to .env, or pass --out <dir> to write the files locally.',
    );
  }

  const store = createStore({ dir: args.out });
  const servers = args.servers
    .split(',')
    .map((value) => value.trim().replace(/^#/, ''))
    .filter(Boolean);

  console.log(`[SCRAPE] ${servers.map((server) => `#${server}`).join(', ')} -> ${store.label}`);

  for (const server of servers) {
    await scrapeServer(server, args, args['scan-index'], store);
  }
}

main().catch((err) => {
  console.error(`[SCRAPE] Failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
