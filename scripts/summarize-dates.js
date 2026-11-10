/**
 * Writes `leadership/<date>.json` for dates that were scraped before the
 * summary existed, so the web's fast path covers them too.
 *
 *   npm run summarize -- --server 973 --since 2026-10-25
 *   npm run summarize -- --server 973 --dates 2026-11-03,2026-11-04
 *   npm run summarize -- --server 973 --since 2026-10-25 --dry-run
 *
 * Read-only with respect to everything except the summaries themselves: no
 * snapshots or player files are touched, so it is safe to run at any time.
 * A date whose window has no usable snapshot is skipped (the web falls back
 * to its full read for it anyway).
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');
const { buildLeadershipSummary } = require('../src/roster/leadership');

function parseArgs(argv) {
  const args = { server: null, dates: null, since: null, out: null, dryRun: false, concurrency: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server') args.server = argv[++i];
    else if (arg === '--dates') args.dates = argv[++i];
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]) || 20;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run summarize -- --server 973 (--dates YYYY-MM-DD,.. | --since YYYY-MM-DD) [--out <dir>] [--dry-run]',
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.server) throw new Error('--server is required, for example --server 973');
  if (!args.dates && !args.since) throw new Error('--dates or --since is required.');
  return args;
}

function localStore(dir) {
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
      fs.writeFileSync(file, JSON.stringify(value));
      return Buffer.byteLength(JSON.stringify(value));
    },
  };
}

function remoteStore() {
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
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.out || (args.dryRun ? path.join(__dirname, '..', 'data', 'summarize-out') : null);
  if (!dir && !r2.configured()) {
    throw new Error(
      `R2 is not configured (missing ${r2.describeMissing()}). Add the R2_* variables to .env, or pass --out <dir> / --dry-run.`,
    );
  }
  const store = dir ? localStore(dir) : remoteStore();
  console.log(`[SUMMARIZE] -> ${dir ? store.label : store.label}`);

  let dates;
  if (args.dates) {
    dates = args.dates.split(',').map((d) => d.trim()).sort();
  } else {
    const index = await store.get('index.json');
    if (!index?.dates?.length) throw new Error('index.json has no dates.');
    dates = index.dates.filter((d) => d >= args.since).sort();
  }
  console.log(`[SUMMARIZE] ${dates.length} date(s): ${dates.join(', ')}`);

  let ok = 0;
  let skipped = 0;
  for (const date of dates) {
    const started = Date.now();
    try {
      const summary = await buildLeadershipSummary(store, date, {
        concurrency: args.concurrency,
      });
      if (!summary) {
        skipped += 1;
        console.log(`[SUMMARIZE] ${date}: skipped (no usable snapshot in its window)`);
        continue;
      }
      const size = await store.put(`leadership/${date}.json`, summary, {
        cacheControl: 'public, max-age=3600',
      });
      ok += 1;
      console.log(
        `[SUMMARIZE] ${date}: ${summary.players.length} players, ${summary.health.count}/${summary.health.total} days usable` +
          `, ${size} B, ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      console.error(`[SUMMARIZE] ${date} FAILED: ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`[SUMMARIZE] done: ${ok} written, ${skipped} skipped.`);
}

main().catch((err) => {
  console.error(`[SUMMARIZE] Failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
