/**
 * Publishes the roster as JSON files.
 *
 *   npm run export -- --out ./.export       write the files to a directory
 *   npm run export                          upload them to Cloudflare R2
 *   npm run export -- --date 2026-10-15     just that date's snapshot
 *   npm run export -- --no-players          snapshots and index only
 *
 * The archive itself is built by src/roster/archive.js; this script only
 * decides where the files go. A directory is a supported target on purpose:
 * the shapes are worth checking against a real export before anything is
 * uploaded, and it makes the whole thing testable without credentials.
 *
 * Order matters. Snapshot, player and alliance files go first and
 * `index.json` last, so a reader that picks up the new index never finds a
 * date the bucket does not have yet. The reverse - index first - would publish
 * a date for the length of the upload.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { buildArchive } = require('../src/roster/archive');
const r2 = require('../src/roster/r2');

function parseArgs(argv) {
  const args = { out: null, date: null, players: true, alliances: true, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = argv[++i];
    else if (arg === '--date') args.date = argv[++i];
    else if (arg === '--no-players') args.players = false;
    else if (arg === '--no-alliances') args.alliances = false;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run export -- [--out <dir>] [--date YYYY-MM-DD] [--no-players] [--no-alliances] [--dry-run]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
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

/**
 * One writer for both targets, so the file list and the order are decided once.
 *
 * A directory write is synchronous and cheap; an upload is a network round trip
 * per file, so the two are reported the same way and progress is printed for
 * the slow one only.
 */
function createWriter({ out, dryRun, total }) {
  let written = 0;
  let bytes = 0;
  let lastLog = Date.now();

  const log = () => {
    if (Date.now() - lastLog < 5000 && written < total) return;
    lastLog = Date.now();
    process.stdout.write(`\r[EXPORT] ${written}/${total} files, ${describe(bytes)}   `);
  };

  return {
    async write(key, value, options) {
      const body = JSON.stringify(value);
      if (dryRun) {
        written += 1;
        bytes += Buffer.byteLength(body);
        return;
      }
      if (out) {
        const file = path.join(out, key);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
        bytes += Buffer.byteLength(body);
      } else {
        bytes += await r2.putJson(key, value, options);
      }
      written += 1;
      log();
    },
    summary() {
      return { files: written, bytes };
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

  console.log(
    args.out
      ? `[EXPORT] Building the archive, writing to ${path.resolve(args.out)}`
      : args.dryRun
        ? '[EXPORT] Building the archive, writing nothing (--dry-run)'
        : `[EXPORT] Building the archive, uploading to R2 bucket "${r2.config().bucket}"`,
  );

  const started = Date.now();
  const archive = await buildArchive();
  console.log(
    `[EXPORT] Built ${archive.index.counts.snapshots} snapshots, ` +
      `${archive.index.counts.players} players, ${archive.index.counts.alliances} alliances ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  const snapshotKeys = args.date
    ? [...archive.snapshots.keys()].filter((date) => date === args.date)
    : [...archive.snapshots.keys()];
  if (!snapshotKeys.length) {
    throw new Error(`No complete snapshot exists for ${args.date}.`);
  }
  // A single-date export patches that one file. Player and alliance files span
  // every date, so rewriting them from a one-date export would be a lie - they
  // are left alone unless the whole archive is being published.
  const players = args.players && !args.date ? [...archive.players.values()] : [];
  const alliances = args.alliances && !args.date ? [...archive.alliances.values()] : [];

  const writer = createWriter({
    out: args.out,
    dryRun: args.dryRun,
    total: snapshotKeys.length + players.length + alliances.length + 1,
  });

  // Long-lived immutable content first: a historical snapshot is fetched by a
  // reader that already knows its date, so a stale copy costs an hour of
  // freshness, never correctness.
  for (const date of snapshotKeys) {
    await writer.write(`snapshots/${date}.json`, archive.snapshots.get(date), {
      cacheControl: 'public, max-age=3600',
    });
  }
  for (const player of players) {
    await writer.write(`players/${player.id}.json`, player, {
      cacheControl: 'public, max-age=3600',
    });
  }
  for (const alliance of alliances) {
    await writer.write(`alliances/${alliance.id}.json`, alliance, {
      cacheControl: 'public, max-age=3600',
    });
  }
  await writer.write('index.json', archive.index, { cacheControl: 'public, max-age=60' });

  const summary = writer.summary();
  if (!args.dryRun) process.stdout.write('\r');
  console.log(
    `[EXPORT] Done: ${summary.files} files, ${describe(summary.bytes)}, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

main().catch((err) => {
  console.error(`[EXPORT] Failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
