/**
 * Fast path vs fallback parity. Run with:  npm test
 *
 * The leadership page has two ways to build the same payload:
 *
 *   fallback - download every player history file (~86MB on #973)
 *   fast     - read one `leadership/<date>.json` summary the bot publishes
 *
 * This builds a fixture bucket, runs the WEB's fallback against it, then runs
 * the BOT's summary builder over the same bucket and asserts the two payloads
 * are identical. If anyone changes one side's window logic without the other,
 * this fails instead of the dashboard quietly disagreeing with itself.
 *
 * The fixture also pins the tricky behaviours: a wrong-scan day is a gap (not
 * a zero), a player who drops out of the newest snapshot still counts in the
 * timeline, a snapshot player with no history file is reported rather than
 * silently dropped, and a known-active player has a non-zero kill delta.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { buildLeadershipSummary } = require('../src/roster/leadership');

// The app's modules use extensionless relative imports (a bundler convention);
// this loader resolves them so files.js can be imported directly.
register('./esm-ext-loader.mjs', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_FILES = path.resolve(HERE, '..', '..', 'phoenix-herald-web', 'src', 'lib', 'roster', 'files.js');

const DATES = ['2026-11-03', '2026-11-04', '2026-11-05'];
const DRAGON = 'https://dragonstats.com/dashboard/973';

function writeJson(dir, rel, value) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function snapshotRow(id, name, power, allianceId) {
  return {
    id,
    name,
    index: 1,
    allianceId,
    avatar: null,
    stats: { Rank: '1', Power: power.toLocaleString('en-US') },
    merits: { infantry: 1, cavalry: 2, mage: 3, marksman: 4 },
  };
}

function snapshot(date, crawledAt, players) {
  return {
    status: 'ok',
    server: { id: '973', url: DRAGON },
    alliances: [{ id: 'a1', name: '[PHW-] TEST', rank: 1, stats: { Power: '1,000', Members: '3' } }],
    players,
    crawledAt,
    snapshot: { date, ingestedAt: crawledAt },
  };
}

function playerFile(id, name, series) {
  const dates = series.map((entry) => entry.date).sort().reverse();
  const byDate = {};
  const metrics = {};
  for (const entry of series) {
    byDate[entry.date] = {
      name,
      rank: 1,
      power: entry.power,
      avatar: null,
      alliance: entry.alliance ?? null,
      sections: entry.sections || [],
      albums: [],
    };
    metrics[entry.date] = entry.metrics;
  }
  return { id, name, dates, byDate, metrics, radar: {}, nameHistory: [], otherServers: [] };
}

function buildFixture(bucket) {
  writeJson(bucket, 'index.json', {
    version: 1,
    server: { id: '973', url: DRAGON },
    latest: '2026-11-05',
    dates: [...DATES].reverse(),
    generatedAt: new Date().toISOString(),
    counts: { snapshots: 3, players: 4, alliances: 1 },
  });

  // 2026-11-03 is filed under another day's scan: a gap, not a day.
  writeJson(
    bucket,
    'snapshots/2026-11-03.json',
    snapshot('2026-11-03', '2026-11-10T03:00:00.000Z', [
      snapshotRow('1', 'Alpha', 1000, '[PHW-] TEST'),
      snapshotRow('2', 'Beta', 500, null),
      snapshotRow('3', 'Ghost', 100, null),
      snapshotRow('4', 'NoFile', 50, null),
    ]),
  );
  writeJson(
    bucket,
    'snapshots/2026-11-04.json',
    snapshot('2026-11-04', '2026-11-04T03:03:00.000Z', [
      snapshotRow('1', 'Alpha', 1100, '[PHW-] TEST'),
      snapshotRow('2', 'Beta', 500, null),
      snapshotRow('3', 'Ghost', 100, null),
    ]),
  );
  writeJson(
    bucket,
    'snapshots/2026-11-05.json',
    snapshot('2026-11-05', '2026-11-05T03:05:00.000Z', [
      snapshotRow('1', 'Alpha', 1200, '[PHW-] TEST'),
      snapshotRow('2', 'Beta', 500, null),
      snapshotRow('4', 'NoFile', 60, null),
    ]),
  );

  // Alpha: progresses every day -> real deltas, active bands, RoW metrics.
  writeJson(
    bucket,
    'players/1.json',
    playerFile('1', 'Alpha', [
      {
        date: '2026-11-03',
        power: 1000,
        alliance: '[PHW-] TEST',
        metrics: { 'Units Killed': 100, 'Units Dead': 10, 'Units Healed': 5, Merits: 10, 'Current Power': 1000 },
      },
      {
        date: '2026-11-04',
        power: 1100,
        alliance: '[PHW-] TEST',
        metrics: { 'Units Killed': 200, 'Units Dead': 12, 'Units Healed': 8, Merits: 20, 'Current Power': 1100 },
      },
      {
        date: '2026-11-05',
        power: 1200,
        alliance: '[PHW-] TEST',
        metrics: {
          'Units Killed': 300,
          'Units Dead': 14,
          'Units Healed': 9,
          Merits: 30,
          'Current Power': 1200,
          'Highest RoW Score': 68133,
          'RoW Wins': 1,
          'RoW Matches Played': 2,
          'ToC Wins': 183,
          'ToC Battles': 186,
          'ToC Winrate': '98.39%',
        },
      },
    ]),
  );

  // Beta: completely flat -> zero deltas (legitimately) and Dormant.
  writeJson(
    bucket,
    'players/2.json',
    playerFile('2', 'Beta', [
      { date: '2026-11-03', power: 500, metrics: { 'Units Killed': 50, Merits: 1, 'Current Power': 500 } },
      { date: '2026-11-04', power: 500, metrics: { 'Units Killed': 50, Merits: 1, 'Current Power': 500 } },
      { date: '2026-11-05', power: 500, metrics: { 'Units Killed': 50, Merits: 1, 'Current Power': 500 } },
    ]),
  );

  // Ghost: absent from the newest snapshot but still progressing in its
  // history - the timeline must count it (both sides read the union of ids).
  writeJson(
    bucket,
    'players/3.json',
    playerFile('3', 'Ghost', [
      { date: '2026-11-03', power: 100, metrics: { 'Units Killed': 10, 'Current Power': 100 } },
      { date: '2026-11-04', power: 100, metrics: { 'Units Killed': 20, 'Current Power': 100 } },
      { date: '2026-11-05', power: 100, metrics: { 'Units Killed': 40, 'Current Power': 100 } },
    ]),
  );

  // NoFile: in the snapshot, no players/4.json at all.
}

async function main() {
  const bucket = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-leadership-'));
  buildFixture(bucket);

  // Serve the bucket over HTTP: the web reader fetches, it does not read disk.
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
    const file = path.resolve(bucket, rel);
    if (!file.startsWith(path.resolve(bucket)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ROSTER_DATA_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  // The web prisma client constructs at import; it is never queried here.
  process.env.DATABASE_URL ||= 'postgresql://user:pass@127.0.0.1:5432/unused';

  const normalize = (value) => JSON.parse(JSON.stringify(value));
  let passed = 0;
  let failed = 0;
  const check = (label, fn) => {
    try {
      fn();
      passed += 1;
      console.log(`PASS  ${label}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${label}`);
      console.log(`      ${err.message}`);
    }
  };

  try {
    const files = await import(pathToFileURL(WEB_FILES).href);

    // 1. The fallback path, with no summary published yet.
    const slow = normalize(await files.getLeadershipDashboard({ endDate: '2026-11-05' }));
    check('fallback builds a payload', () => assert.ok(slow && slow.players));
    check('players with a history file become rows (NoFile excluded)', () =>
      assert.strictEqual(slow.players.length, 2));
    check('playersWithoutFile counts the history-less lord', () =>
      assert.strictEqual(slow.snapshotHealth.playersWithoutFile, 1));
    check('missing and wrong-scan days are gaps, never zeros', () => {
      // The window is the eight calendar days ending on the pinned date, so
      // the five days before the fixture's first snapshot are gaps too.
      assert.strictEqual(slow.snapshotHealth.count, 2);
      assert.deepStrictEqual(
        slow.activityTimeline.map((t) => [t.date, t.activePlayers, t.gap]),
        [
          ['2026-10-29', null, true],
          ['2026-10-30', null, true],
          ['2026-10-31', null, true],
          ['2026-11-01', null, true],
          ['2026-11-02', null, true],
          ['2026-11-03', null, true], // wrong-scan copy
          ['2026-11-04', null, true], // previous day is a gap: no comparison
          ['2026-11-05', 2, false], // Alpha + Ghost (Ghost is not in this snapshot)
        ],
      );
    });
    check('a known-active player has a non-zero kill delta', () => {
      const alpha = slow.players.find((p) => p.id === '1');
      // The window's usable days are 11-04 -> 11-05, so the delta spans one day.
      assert.strictEqual(alpha.changes.kills, 100);
      assert.strictEqual(alpha.powerChange, 100);
      assert.strictEqual(alpha.alliance, '[PHW-] TEST');
      assert.deepStrictEqual(alpha.merits, { infantry: 1, cavalry: 2, mage: 3, marksman: 4 });
      assert.strictEqual(alpha.row.score, 68133);
    });
    check('a flat player reads zero deltas and Dormant', () => {
      const beta = slow.players.find((p) => p.id === '2');
      assert.strictEqual(beta.changes.kills, 0);
      assert.strictEqual(beta.activity, 'Dormant');
    });

    // 2. Publish the bot's summary over the same bucket, read again.
    const dirStore = {
      async get(key) {
        try {
          return JSON.parse(fs.readFileSync(path.join(bucket, key), 'utf8'));
        } catch {
          return null;
        }
      },
    };
    const summary = await buildLeadershipSummary(dirStore, '2026-11-05');
    check('bot builds a summary for the window', () =>
      assert.ok(summary && summary.players.length === 2));
    writeJson(bucket, 'leadership/2026-11-05.json', summary);

    const fast = normalize(await files.getLeadershipDashboard({ endDate: '2026-11-05' }));
    check('fast path payload is byte-identical to the fallback', () =>
      assert.deepStrictEqual(fast, slow));

    // 3. The newest window (no pinned date) also hits the fast path. Only
    //    requestedDate may differ - null means "the newest window".
    const latest = normalize(await files.getLeadershipDashboard());
    const { requestedDate: pinnedDate, ...slowRest } = slow;
    const { requestedDate: latestDate, ...latestRest } = latest;
    check('unpinned window uses the summary too', () => {
      assert.strictEqual(pinnedDate, '2026-11-05');
      assert.strictEqual(latestDate, null);
      assert.deepStrictEqual(latestRest, slowRest);
    });
  } catch (err) {
    failed += 1;
    console.log('FAIL  parity harness');
    console.log(`      ${err.stack || err.message}`);
  } finally {
    server.close();
    fs.rmSync(bucket, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
