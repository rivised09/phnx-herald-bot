/**
 * Roster storage tests. Run with:  npm test
 *
 * Uses a throwaway server number (999999) against the real database and
 * removes it again afterwards, so nothing real is touched.
 */
const assert = require('assert');

process.env.CALLOFSTATS_SERVER_ID = '999999';

const prisma = require('../src/db');
const ingest = require('../src/roster/ingest');
const { saveSnapshot, planWork } = ingest;
const { getStoredRoster, getStoredCounts, formatStat } = require('../src/roster/store');
const metrics = require('../src/roster/metrics');
const extract = require('../src/roster/extract');
const { accountCount, rotateCredentials } = require('../src/roster/session');
const detail = require('../src/roster/detail');

const SERVER = 999999;
const DATE = '1999-01-01';
const isoDate = (d) => new Date(`${d}T00:00:00.000Z`);

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${err.message}`);
  }
}

// ---------------------------------------------------------------- values ---

const VALUE_CASES = [
  ['18,300,813', 18300813, null],
  ['48,597,999,465', 48597999465, null],
  ['1,179,663,001', 1179663001, null],
  ['0.31%', 0.31, '%'],
  ['92.83%', 92.83, '%'],
  ['635.0%', 635, '%'],
  ['985,968 Sec', 985968, 'Sec'],
  ['0d', 0, 'd'],
  ['10,695.98', 10695.98, null],
  ['0.34', 0.34, null],
  ['186', 186, null],
  ['0', 0, null],
  // Values that must stay text: parsing these would invent facts.
  ['None - 0d', null, null],
  ['Silver III \u22651600', null, null],
  ['S3-2638 | Season 3', null, null],
  ['2026-10-04', null, null],
  ['2026-10-04 05:51:52 UTC', null, null],
  ['1B+', null, null],
  ['60M\u201380M', null, null],
  ['#973', null, null],
  ['League of Order', null, null],
  ['', null, null],
  [null, null, null],
];

check('value parsing matches source samples', () => {
  VALUE_CASES.forEach(([input, wantNumber, wantUnit]) => {
    const got = metrics.parseMetricValue(input);
    const wantText = input === null || input === undefined ? null : String(input).trim() || null;
    assert.deepStrictEqual(
      [got.valueText, got.valueNumber, got.unit],
      [wantText, wantNumber, wantUnit],
      `parse(${JSON.stringify(input)}) -> ${JSON.stringify(got)}`,
    );
  });
});

check('1B is never recorded as the number 1', () => {
  assert.strictEqual(metrics.parseMetricValue('1B').valueNumber, null);
});

check('achievement completion distinguishes goal from date', () => {
  const unfinished = metrics.parseAchievementCompletion('Not Completed (50,000,000)');
  assert.strictEqual(unfinished.target, 50000000n);
  assert.strictEqual(unfinished.completedAt, null);

  const done = metrics.parseAchievementCompletion('2026-09-14');
  assert.strictEqual(done.target, null);
  assert.ok(done.completedAt.toISOString().startsWith('2026-09-14'));
});

// ------------------------------------------------------------ plan work ---

const now = new Date();
const staleAt = new Date(now.getTime() - 10 * 60 * 60 * 1000);
const days = (n) =>
  Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 11, 1) + i * 86400000).toISOString().slice(0, 10));
const all40 = days(40);
const recent30 = all40.slice(-30);
const mapWith = (keys, at) => new Map(keys.map((k) => [k, at]));

check('sync planning decides when a browser is needed', () => {
  const cases = [
    [null, new Map(), true, false],
    [all40, new Map(), true, true],
    [recent30, mapWith(recent30, now), false, false],
    [recent30, mapWith(recent30, staleAt), true, false],
    [recent30, mapWith(recent30.slice(-1), now), false, true],
    [all40, mapWith(recent30, now), false, false],
    [[], new Map(), true, false],
    [recent30, new Map(), true, true],
  ];
  cases.forEach(([dates, existing, wantLatest, wantBackfill]) => {
    const plan = planWork(dates, existing);
    assert.deepStrictEqual(
      [plan.needLatest, plan.needBackfill],
      [wantLatest, wantBackfill],
      `planWork(${JSON.stringify(dates && dates.length)}, ${existing.size} existing)`,
    );
  });
});

// ------------------------------------------------------- source quirks ---

check('alliance names reduce to queries the search accepts', () => {
  const bracketed = extract.queryVariants('[PHW2] Phoenix of the War');
  assert.strictEqual(bracketed[0], 'PHW2', 'the tag must be tried first');
  assert.ok(bracketed.includes('[PHW2] Phoenix of the War'));
  assert.strictEqual(new Set(bracketed).size, bracketed.length, 'variants must not repeat');

  assert.deepStrictEqual(extract.queryVariants('Plain Alliance'), ['Plain Alliance']);
});

check('several accounts can be listed as comma-separated pairs', () => {
  delete process.env.CALLOFSTATS_USERNAMES;
  delete process.env.CALLOFSTATS_PASSWORDS;
  process.env.CALLOFSTATS_USERNAME = 'first,second,third';
  process.env.CALLOFSTATS_PASSWORD = 'pw1,pw2,pw3';
  assert.strictEqual(accountCount(), 3);
});

check('a lone password containing commas is left whole', () => {
  process.env.CALLOFSTATS_USERNAME = 'one-user';
  process.env.CALLOFSTATS_PASSWORD = 'has,commas,inside';
  assert.strictEqual(accountCount(), 1);
});

check('rotation cycles accounts and refuses to loop on one', () => {
  process.env.CALLOFSTATS_USERNAME = 'only-one';
  process.env.CALLOFSTATS_PASSWORD = 'pw';
  assert.strictEqual(rotateCredentials(), null);

  process.env.CALLOFSTATS_USERNAME = 'a,b';
  process.env.CALLOFSTATS_PASSWORD = 'p1,p2';
  assert.strictEqual(accountCount(), 2);
  assert.ok(rotateCredentials());
  assert.ok(rotateCredentials(), 'wraps back to the first account');
});

// ------------------------------------------------------------- databases ---

const ALLIANCES = [
  { id: '[AAA] Alpha', name: '[AAA] Alpha', rank: 1, stats: { Power: '43,874,924,159', Members: '3' } },
  { id: '[BBB] Beta', name: '[BBB] Beta', rank: 2, stats: { Power: '773,371,680', Members: '2' } },
];
const PLAYERS = [
  { id: '1001', name: 'Zed', rank: 1, allianceId: '[AAA] Alpha', stats: { Rank: '1', Power: '40,000,000,000' }, avatar: 'https://cdn.example/zed.webp' },
  { id: '1002', name: 'Yan', rank: 2, allianceId: '[AAA] Alpha', stats: { Rank: '2', Power: '3,874,924,159' }, avatar: null },
  { id: '1003', name: 'Max', rank: 3, allianceId: '[BBB] Beta', stats: { Rank: '1', Power: '773,371,680' }, avatar: null },
  { id: '1004', name: 'Solo', rank: 4, allianceId: 'Not In An Alliance', stats: { Rank: '1', Power: '0' }, avatar: null },
];

async function main() {
  try {
    check('bigint formatting survives JSON', () => {
      assert.strictEqual(metrics.parseMetricValue('43,874,924,159').valueNumber, 43874924159);
      assert.strictEqual(formatStat(43874924159n), '43,874,924,159');
    });

    const server = await prisma.sourceServer.upsert({
      where: { serverNumber: SERVER },
      create: { serverNumber: SERVER },
      update: {},
    });

    await saveSnapshot({ server, isoDate: DATE, status: 'COMPLETE', url: 'u', alliances: ALLIANCES, players: PLAYERS });
    await saveSnapshot({ server, isoDate: DATE, status: 'COMPLETE', url: 'u', alliances: ALLIANCES, players: PLAYERS.slice(0, 2) });

    const snapshot = await prisma.rosterSnapshot.findFirst({
      where: { serverId: server.id },
      include: { _count: { select: { allianceRows: true, lordRows: true } } },
    });

    check('re-ingest replaces rows instead of duplicating them', () => {
      assert.strictEqual(snapshot._count.allianceRows, 2);
      assert.strictEqual(snapshot._count.lordRows, 2);
    });

    const payload = await getStoredRoster();

    check('stored roster is served in the shape the web renders', () => {
      assert.strictEqual(payload.status, 'ok');
      assert.strictEqual(payload.alliances.length, 2);
      assert.strictEqual(payload.players.length, 2);
      assert.strictEqual(payload.snapshot.date, DATE);
      assert.strictEqual(payload.alliances[0].stats.Power, '43,874,924,159');
      assert.strictEqual(payload.players[0].avatar, 'https://cdn.example/zed.webp');
      assert.strictEqual(payload.players[1].avatar, null);
      JSON.stringify(payload);
    });

    // A later ingest that sees no avatar must not erase one already collected.
    await saveSnapshot({
      server, isoDate: DATE, status: 'COMPLETE', url: 'u', alliances: ALLIANCES,
      players: PLAYERS.slice(0, 2).map((p) => ({ ...p, avatar: null })),
    });
    const afterReingest = await getStoredRoster();

    check('avatar survives a re-ingest that saw none', () => {
      assert.strictEqual(afterReingest.players[0].avatar, 'https://cdn.example/zed.webp');
    });

    const counts = await getStoredCounts();
    check('footer counts come from the stored snapshot', () => {
      assert.deepStrictEqual(counts, { alliances: 2, players: 2, snapshotDate: DATE });
    });

    // A snapshot is replaced wholesale, so a source that refuses us once
    // already overwrote a roster of 300 players with 10.
    const degraded = await ingest.isDegraded(server, { iso: DATE, alliances: [], players: [] });
    const intact = await ingest.isDegraded(server, { iso: DATE, alliances: ALLIANCES, players: PLAYERS });
    check('a read far smaller than what is stored is discarded', () => {
      assert.strictEqual(degraded, true);
      assert.strictEqual(intact, false);
    });

    // --- metrics ---
    await metrics.saveSubjectMetrics(snapshot.id, 'SERVER', '', [
      { section: 'Server War Stats', label: 'Total Power', value: '4,062,807,339' },
      { section: 'Power Spread', label: '60M\u201380M', value: '2' },
      { section: '', label: 'Exact time scanned', value: '2026-10-04 05:51:52 UTC' },
    ]);
    await metrics.saveSubjectMetrics(snapshot.id, 'SERVER', '', [
      { section: 'Server War Stats', label: 'Total Power', value: '4,062,807,339' },
      { section: '', label: 'King', value: 'Is Not Wearing' },
    ]);

    const read = await metrics.readSubjectMetrics(snapshot.id, 'SERVER', '');
    check('metrics store raw text alongside parsed numbers', () => {
      assert.strictEqual(read['Server War Stats'][0].number, 4062807339);
      assert.strictEqual(read['Server War Stats'][0].text, '4,062,807,339');
      assert.strictEqual(read[''][0].label, 'King');
      assert.strictEqual(read[''][0].text, 'Is Not Wearing');
      assert.strictEqual(read[''][0].number, null);
    });
    check('re-ingest drops metrics the source no longer shows', () => {
      assert.strictEqual(read['Server War Stats'].length, 1);
      assert.strictEqual(read['Power Spread'], undefined);
    });

    // --- achievements ---
    const lord = await prisma.lord.upsert({
      where: { serverId_sourceId: { serverId: server.id, sourceId: 25615899n } },
      create: { serverId: server.id, sourceId: 25615899n, name: '\u798friv' },
      update: {},
    });
    const lordSnapshot = await prisma.lordSnapshot.upsert({
      where: { snapshotId_lordId: { snapshotId: snapshot.id, lordId: lord.id } },
      create: { snapshotId: snapshot.id, lordId: lord.id, power: 18300813n, rank: 1 },
      update: {},
    });

    await metrics.saveAchievements(lordSnapshot.id, [
      { name: 'Infantry Merits', progress: '329,203', ...metrics.parseAchievementCompletion('Not Completed (50,000,000)') },
      { name: 'Full T5', progress: '4', ...metrics.parseAchievementCompletion('Not Completed (5)') },
    ]);
    const achievements = await prisma.lordAchievement.findMany({ where: { lordSnapshotId: lordSnapshot.id } });

    check('achievements keep progress and goal as exact integers', () => {
      assert.strictEqual(achievements.length, 2);
      const infantry = achievements.find((a) => a.name === 'Infantry Merits');
      assert.strictEqual(infantry.progress, 329203n);
      assert.strictEqual(infantry.target, 50000000n);
    });

    // --- name history ---
    await metrics.saveNameHistory(lord.id, ['riv', 'OldName', 'riv']);
    const history = await prisma.lordNameHistory.findMany({ where: { lordId: lord.id } });
    check('name history de-duplicates', () => {
      assert.strictEqual(history.length, 2);
    });

    // --- player detail depth ---
    check('player detail defaults to the newest date', () => {
      delete process.env.ROSTER_DETAIL_PLAYERS;
      assert.strictEqual(detail.playerDepth(), 'latest');
      process.env.ROSTER_DETAIL_PLAYERS = 'all';
      assert.strictEqual(detail.playerDepth(), 'all');
      delete process.env.ROSTER_DETAIL_PLAYERS;
    });
  } catch (err) {
    failed += 1;
    console.log(`FAIL  unexpected error\n      ${err.stack}`);
  } finally {
    await prisma.sourceServer.deleteMany({ where: { serverNumber: SERVER } }).catch(() => {});
    const left = await prisma.sourceServer.findUnique({ where: { serverNumber: SERVER } });
    if (left !== null) {
      failed += 1;
      console.log('FAIL  cleanup removed the test server');
    } else {
      passed += 1;
      console.log('PASS  cleanup removed the test server');
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
