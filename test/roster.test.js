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
const { getStoredRoster, getStoredCounts, formatStat, loadPlayerMetrics, getPlayerDetail } = require('../src/roster/store');
const metrics = require('../src/roster/metrics');
const extract = require('../src/roster/extract');
const { accountCount, rotateCredentials } = require('../src/roster/session');
const { historyEnabled, scopeLabel } = require('../src/roster/scope');
const detail = require('../src/roster/detail');
const insights = require('../src/roster/insights');

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
    [all40, mapWith(recent30, now), false, true],
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

// Which dates a run may touch is a switch, and the deployed default has to be
// the cheap one: latest only, with history as something a person asks for.
check('history stays off unless a process asks for it', () => {
  delete process.env.ROSTER_HISTORY;
  assert.strictEqual(historyEnabled(), false);
  assert.strictEqual(scopeLabel(), 'latest');

  process.env.ROSTER_HISTORY = '1';
  assert.strictEqual(historyEnabled(), true);
  assert.strictEqual(scopeLabel(), 'history');
  delete process.env.ROSTER_HISTORY;
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

    // --- player detail insights ---
    const insightHistory = [
      { date: '1999-01-01', power: 10000000, rank: 120 },
      { date: '1999-01-08', power: 25000000, rank: 80 },
      { date: '1999-01-15', power: 60000000, rank: 40 },
    ];
    const insightMetrics = {
      '1999-01-08': {
        'Units Killed': 5000000,
        'Units Dead': 1000000,
        'Units Healed': 1000000,
        Merits: 15000,
        Victories: 600,
        Defeats: 250,
        'City Sieges': 100,
        'Times Scouted': 2000,
        'Alliance Donations': 60000,
        'Times Alliance Helps Given': 15000,
        'Total Resources Gathered': 80000000,
        'Building Power': 12000000,
        'Hero Power': 9000000,
        'Legion Power': 12000000,
        'Tech Power': 3000000,
        'Town Hall': 24,
        'Seasons Played': 3,
        'Season Victories': 30,
        'Season Defeats': 18,
        'Historical Highest Merits': 45000,
        'T4/T5 Units Dead': 200000,
      },
      '1999-01-15': {
        'Units Killed': 12000000,
        'Units Dead': 2000000,
        'Units Healed': 3000000,
        Merits: 40000,
        Victories: 1500,
        Defeats: 400,
        'City Sieges': 300,
        'Times Scouted': 5000,
        'Alliance Donations': 150000,
        'Times Alliance Helps Given': 40000,
        'Total Resources Gathered': 200000000,
        'Building Power': 20000000,
        'Hero Power': 15000000,
        'Legion Power': 20000000,
        'Tech Power': 5000000,
        'Town Hall': 25,
        'Seasons Played': 3,
        'Season Victories': 40,
        'Season Defeats': 20,
        'Historical Highest Merits': 60000,
        'T4/T5 Units Dead': 500000,
      },
    };
    const full = insights.buildInsights({
      history: insightHistory,
      metricsByDate: insightMetrics,
      serverNumber: 999999,
      name: 'Test Lord',
    });

    check('insights marks its privacy contract', () => {
      assert.strictEqual(full.available, true);
      assert.strictEqual(full.privacy, 'self-comparison-only');
      assert.ok(/own earlier readings/.test(full.narrative.privacyNote));
    });

    check('insights never emits another player or a percentile', () => {
      const banned = [
        'percentile',
        'rankPercentile',
        'vsKingdom',
        'kingdomAverage',
        'leaderboard',
        'betterThan',
        'percentOfPlayers',
        'otherPlayers',
      ];
      const seen = new Set();
      (function walk(node, path) {
        if (node === null || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          if (banned.includes(key)) seen.add(`${path}.${key}`);
          walk(value, `${path}.${key}`);
        }
      })(full, 'insights');
      assert.deepStrictEqual([...seen], []);
    });

    check('progress measures each metric over the dates it was actually read', () => {
      assert.strictEqual(full.progress.windowDays, 14);
      const power = full.progress.series.find((row) => row.key === 'power');
      assert.strictEqual(power.from, 10000000);
      assert.strictEqual(power.to, 60000000);
      assert.strictEqual(power.delta, 50000000);
      assert.strictEqual(power.direction, 'up');
      const kills = full.progress.series.find((row) => row.key === 'kills');
      assert.strictEqual(kills.fromDate, '1999-01-08');
      assert.strictEqual(kills.delta, 7000000);
      assert.strictEqual(kills.deltaPctText, '+140%');
    });

    check('timeline exposes one point per snapshot', () => {
      assert.strictEqual(full.timeline.length, 3);
      assert.strictEqual(full.timeline[0].power, 10000000);
      assert.strictEqual(full.timeline[0].kills, null);
      assert.strictEqual(full.timeline[2].kills, 12000000);
    });

    check('efficiency ratios are derived from this player alone', () => {
      const killDeath = full.efficiency.find((row) => row.key === 'killDeath');
      assert.strictEqual(killDeath.value, 6);
      const winRate = full.efficiency.find((row) => row.key === 'winRate');
      assert.ok(Math.abs(winRate.value - 1500 / 1900) < 1e-6);
      assert.strictEqual(full.efficiency.find((row) => row.key === 'healDeath').value, 1.5);
    });

    check('playstyle resolves to a known archetype', () => {
      const known = ['Warlord', 'Guardian', 'Architect', 'Rallyer', 'Settler', 'Rising Star', 'All-Rounder'];
      assert.ok(known.includes(full.playstyle.label), `got ${full.playstyle.label}`);
      assert.strictEqual(full.playstyle.available, true);
      assert.ok(full.playstyle.blurb.length > 0);
      assert.ok(full.playstyle.strengths.length > 0);
      assert.ok(full.playstyle.growth.length > 0);
    });

    check('profile signals carry a level and a reason', () => {
      assert.strictEqual(full.profile.length, 5);
      for (const item of full.profile) {
        assert.ok(['strong', 'good', 'steady', 'building', 'new', 'unknown'].includes(item.level));
        assert.ok(item.reason.length > 0);
      }
      assert.ok(full.profile.some((item) => item.key === 'growth' && item.level === 'strong'));
    });

    check('milestones always target round numbers', () => {
      const power = full.milestones.find((row) => row.key === 'power');
      assert.strictEqual(power.current, 60000000);
      assert.strictEqual(power.target, 100000000);
      assert.strictEqual(power.remaining, 40000000);
      assert.ok(power.pct > 0 && power.pct < 100);
      assert.strictEqual(insights.nextRound(60000000), 100000000);
      assert.strictEqual(insights.nextRound(0), 1000);
      assert.ok(insights.nextRound(999999999) > 999999999);
    });

    check('site badges use absolute thresholds only', () => {
      const power50m = full.achievements.find((row) => row.key === 'power-50m');
      assert.strictEqual(power50m.earned, true);
      assert.strictEqual(power50m.earnedOn, '1999-01-15');
      const power1b = full.achievements.find((row) => row.key === 'power-1b');
      assert.strictEqual(power1b.earned, false);
      const kills1m = full.achievements.find((row) => row.key === 'kills-1m');
      assert.strictEqual(kills1m.earnedOn, '1999-01-08');
      const seasons3 = full.achievements.find((row) => row.key === 'seasons-3');
      assert.strictEqual(seasons3.earned, true);
    });

    check('season journey summarises the account record', () => {
      assert.strictEqual(full.seasonJourney.available, true);
      assert.strictEqual(full.seasonJourney.seasonsPlayed, 3);
      assert.strictEqual(full.seasonJourney.winrateText, '67%');
      assert.strictEqual(full.seasonJourney.tier, 'Veteran');
      assert.strictEqual(full.seasonJourney.bestMeritsText, '60K');
    });

    check('gains and comparison stay inside the tracked window', () => {
      assert.ok(full.gains.length >= 2);
      const powerGain = full.gains.find((row) => row.key === 'power');
      assert.strictEqual(powerGain.delta, 50000000);
      assert.strictEqual(full.comparison.available, true);
      assert.ok(full.comparison.periods.every((row) => row.recentDate >= row.previousDate));
      assert.ok(/no other account/.test(full.comparison.narrative));
    });

    check('activity ranks each area against the player own prior pace', () => {
      assert.strictEqual(full.activity.available, true);
      assert.strictEqual(full.activity.areas.length, 5);
      const combat = full.activity.areas.find((row) => row.key === 'combat');
      assert.ok(['surging', 'active', 'steady', 'quiet', 'idle'].includes(combat.level));
    });

    check('a season reset is reported as a reset, not a loss', () => {
      const beforeSeason = {
        '1999-01-08': { Merits: 166571, 'Seasons Played': 2, 'Units Killed': 650889 },
        '1999-01-15': { Merits: 166571, 'Seasons Played': 2, 'Units Killed': 660640 },
      };
      const afterSeason = {
        '1999-01-08': { Merits: 166571, 'Seasons Played': 2, 'Units Killed': 650889 },
        '1999-01-15': { Merits: 0, 'Seasons Played': 3, 'Units Killed': 660640 },
      };
      const rolled = insights.buildInsights({ history: insightHistory, metricsByDate: afterSeason });
      const unchanged = insights.buildInsights({ history: insightHistory, metricsByDate: beforeSeason });

      const merits = rolled.progress.series.find((row) => row.key === 'merits');
      assert.strictEqual(merits.direction, 'reset');
      assert.strictEqual(merits.deltaPctText, 'new season');
      assert.strictEqual(merits.deltaText, null);
      assert.strictEqual(merits.better, null);
      assert.ok(/new season opened/.test(merits.note));

      assert.strictEqual(rolled.coverage.seasonReset, true);
      assert.strictEqual(unchanged.coverage.seasonReset, false);
      assert.ok(/new season opened/.test(rolled.narrative.summary));

      assert.strictEqual(rolled.milestones.find((row) => row.key === 'merits'), undefined);
      assert.strictEqual(rolled.gains.find((row) => row.key === 'merits'), undefined);
      const comparison = rolled.comparison.periods.find((row) => row.key === 'merits');
      assert.strictEqual(comparison.direction, 'reset');
      assert.strictEqual(comparison.better, null);
      assert.strictEqual(rolled.efficiency.find((row) => row.key === 'meritPower'), undefined);

      const k = rolled.comparison.periods.find((row) => row.key === 'kills');
      assert.strictEqual(k.better, true);
      const rank = rolled.progress.series.find((row) => row.key === 'rank');
      assert.strictEqual(rank.better, true);
    });

    check('activity pairs the dates each area was measured', () => {
      const gapped = insights.buildInsights({
        history: [
          { date: '1999-01-01', power: 10000000, rank: 120 },
          { date: '1999-01-08', power: 25000000, rank: 80 },
          { date: '1999-01-15', power: 60000000, rank: 40 },
        ],
        metricsByDate: {
          '1999-01-01': { 'Units Killed': 1000000, Victories: 100, Defeats: 50 },
          '1999-01-15': { 'Units Killed': 3000000, Victories: 400, Defeats: 60 },
        },
      });
      const combat = gapped.activity.areas.find((row) => row.key === 'combat');
      assert.notStrictEqual(combat.level, 'unknown');
      assert.strictEqual(combat.readings, 2);
      assert.strictEqual(gapped.activity.available, true);
    });

    check('power-only history degrades instead of inventing zeros', () => {
      const bare = insights.buildInsights({ history: insightHistory, metricsByDate: {} });
      assert.strictEqual(bare.available, true);
      assert.strictEqual(bare.coverage.hasDetail, false);
      assert.strictEqual(bare.coverage.hasCombat, false);
      assert.deepStrictEqual(bare.coverage.missing, ['combat', 'sustain', 'gathering']);
      assert.strictEqual(bare.efficiency.length, 0);
      assert.strictEqual(bare.seasonJourney.available, false);
      const known = bare.activity.areas.filter((row) => row.level !== 'unknown');
      assert.deepStrictEqual(known.map((row) => row.key), ['growth']);
      assert.strictEqual(bare.playstyle.key, 'riser');
      assert.ok(bare.milestones.find((row) => row.key === 'power'));
      assert.strictEqual(bare.milestones.filter((row) => row.key === 'kills').length, 0);
      assert.strictEqual(bare.progress.series.map((row) => row.key).join(','), 'power,rank');
    });

    check('a single snapshot yields no progress or comparison', () => {
      const one = insights.buildInsights({ history: [insightHistory[0]], metricsByDate: {} });
      assert.strictEqual(one.progress.series.length, 0);
      assert.strictEqual(one.comparison.available, false);
      assert.strictEqual(one.activity.available, false);
      assert.strictEqual(one.available, true);
    });

    check('an empty history reports why rather than throwing', () => {
      assert.deepStrictEqual(insights.buildInsights({}), { available: false, reason: 'no_history' });
    });

    check('flatten accepts both metric shapes', () => {
      const sectioned = { 'War Stats': [{ label: 'Units Killed', number: 12, text: '12', unit: null }] };
      assert.deepStrictEqual(insights.flatten(sectioned), { 'Units Killed': 12 });
      assert.deepStrictEqual(insights.flatten({ 'Units Killed': '1,234' }), { 'Units Killed': 1234 });
      assert.deepStrictEqual(insights.flatten({ Odd: 'Silver III' }), {});
    });

    check('compact abbreviates without losing magnitude', () => {
      assert.strictEqual(insights.compact(60000000), '60M');
      assert.strictEqual(insights.compact(950), '950');
      assert.strictEqual(insights.compact(null), null);
    });

    // --- playstyle hexagon ---
    check('playstyle reader pulls the six hexagon axes', () => {
      const attrs = {
        'data-comparison': 'false',
        'data-merits': '40.0',
        'data-behemoths': '44.53',
        'data-gathering': '20.0',
        'data-peacekeeping': '20.0',
        'data-healing': '60.0',
        'data-engineering': '20.0',
      };
      const chart = { getAttribute: (key) => (key in attrs ? attrs[key] : null) };
      const original = global.document;
      const withDoc = (fn) => {
        global.document = fn;
        try {
          return extract.readPlaystyle();
        } finally {
          if (original === undefined) delete global.document;
          else global.document = original;
        }
      };

      const rows = withDoc({ getElementById: (id) => (id === 'playstyleHexagon' ? chart : null) });
      assert.deepStrictEqual(
        rows.map((row) => row.label),
        ['Merits', 'Behemoths', 'Gathering', 'Peacekeeping', 'Healing', 'Engineering'],
      );
      assert.deepStrictEqual(rows[0], { section: 'Playstyle', label: 'Merits', value: '40%' });
      assert.strictEqual(rows[1].value, '44.53%');
      assert.strictEqual(rows[5].value, '20%');
      assert.strictEqual(rows.length, 6);

      assert.deepStrictEqual(withDoc({ getElementById: () => null }), []);
      assert.deepStrictEqual(
        withDoc({ getElementById: () => ({ getAttribute: () => '' }) }),
        [],
      );
    });

    check('radar stays unavailable until the hexagon has been captured', () => {
      const bare = insights.buildInsights({ history: insightHistory, metricsByDate: insightMetrics });
      assert.strictEqual(bare.radar.available, false);
      assert.strictEqual(bare.radar.reason, 'awaiting_capture');
      assert.deepStrictEqual(bare.radar.readings, []);
      assert.strictEqual(bare.radar.axes.length, 6);
      assert.strictEqual(bare.radar.note, 'Lower percentages indicate a higher KvK ranking.');
      assert.ok(/detail pass/.test(bare.radar.summary));
    });

    check('radar plots the current season against the previous reading', () => {
      const radarByDate = {
        '1999-01-08': {
          Merits: 62,
          Behemoths: 50,
          Gathering: 44,
          Peacekeeping: 30,
          Healing: 70,
          Engineering: 55,
        },
        '1999-01-15': {
          Merits: 40,
          Behemoths: 44.53,
          Gathering: 20,
          Peacekeeping: 20,
          Healing: 60,
          Engineering: 20,
        },
      };
      const withDivision = {
        ...insightMetrics,
        '1999-01-08': { ...insightMetrics['1999-01-08'], Division: 'S2-100 | Season 2' },
        '1999-01-15': { ...insightMetrics['1999-01-15'], Division: 'S3-100 | Season 3' },
      };
      const built = insights.buildInsights({
        history: insightHistory,
        metricsByDate: withDivision,
        radarByDate,
      });

      const radar = built.radar;
      assert.strictEqual(radar.available, true);
      assert.strictEqual(radar.readings.length, 2);
      assert.strictEqual(radar.current.date, '1999-01-15');
      assert.strictEqual(radar.current.season, 3);
      assert.strictEqual(radar.previous.date, '1999-01-08');
      assert.strictEqual(radar.previous.season, 2);
      assert.deepStrictEqual(
        radar.axes.map((axis) => axis.key),
        ['merits', 'behemoths', 'gathering', 'peacekeeping', 'healing', 'engineering'],
      );
      assert.deepStrictEqual(radar.current.values, [40, 44.53, 20, 20, 60, 20]);

      const merits = radar.deltas.find((row) => row.key === 'merits');
      assert.strictEqual(merits.delta, -22);
      // Lower is better here, unlike every other metric in this module.
      assert.strictEqual(merits.direction, 'better');
      assert.strictEqual(radar.improved, 6);
      assert.strictEqual(radar.worsened, 0);
      assert.ok(/^Season 2 → Season 3/.test(radar.summary));
      assert.ok(/improved on merits/.test(radar.summary));
    });

    check('radar falls back to dates when the season is unknown', () => {
      const built = insights.buildInsights({
        history: insightHistory,
        metricsByDate: insightMetrics,
        radarByDate: {
          '1999-01-15': { Merits: 40, Healing: 60 },
        },
      });
      assert.strictEqual(built.radar.available, true);
      assert.strictEqual(built.radar.current.season, null);
      assert.strictEqual(built.radar.previous, null);
      assert.strictEqual(built.radar.deltas.length, 0);
      assert.ok(/^1999-01-15/.test(built.radar.summary));
    });

    await metrics.saveSubjectMetrics(snapshot.id, 'LORD', lord.id, [
      { section: 'War Stats', label: 'Merits', value: '166,571' },
      { section: 'Playstyle', label: 'Merits', value: '40%' },
      { section: 'Playstyle', label: 'Healing', value: '60%' },
      { section: '', label: 'Division', value: 'S2-100 | Season 2' },
    ]);
    const split = await loadPlayerMetrics(server.id, lord.id);

    check('playstyle percentiles never overwrite the merit count', () => {
      const date = split.radar['1999-01-01'];
      assert.ok(date, 'expected playstyle rows for the test snapshot date');
      assert.strictEqual(date.Merits, 40);
      assert.strictEqual(date.Healing, 60);
      assert.strictEqual(split.metrics['1999-01-01'].Merits, 166571);
      assert.strictEqual(split.metrics['1999-01-01'].Division, 'S2-100 | Season 2');
      assert.strictEqual(date.Division, undefined);
    });

    check('raw stat blocks keep the rendered text and leave playstyle to the radar', () => {
      assert.strictEqual(split.sectionsDate, DATE);
      assert.deepStrictEqual(
        split.sections.map((block) => block.section),
        ['', 'War Stats'],
        'Playstyle belongs to the radar, not the tab blocks',
      );
      assert.deepStrictEqual(split.sections[1].rows, [
        { label: 'Merits', value: '166,571' },
      ]);
      assert.deepStrictEqual(split.sections[0].rows, [
        { label: 'Division', value: 'S2-100 | Season 2' },
      ]);
    });

    // The source numbers its lords inside each alliance block and restarts the
    // counter at 1 for every block, so extraction order is "position in the
    // current alliance" rather than a server ranking.
    await saveSnapshot({
      server,
      isoDate: '1999-01-02',
      status: 'COMPLETE',
      url: 'u',
      alliances: [],
      players: [
        { id: '2001', name: 'BlockTail', allianceId: '[BBB] Beta', stats: { Power: '4,700,000' } },
        { id: '2002', name: 'BlockHead', allianceId: '[AAA] Alpha', stats: { Power: '67,000,000' } },
        { id: '2003', name: 'Middle', allianceId: '[BBB] Beta', stats: { Power: '18,000,000' } },
      ],
    });
    const ranked = await prisma.lordSnapshot.findMany({
      where: { snapshot: { serverId: server.id, snapshotDate: isoDate('1999-01-02') } },
      select: { rank: true, power: true, lord: { select: { name: true } } },
      orderBy: { rank: 'asc' },
    });

    check('rank follows power, not the order the source printed rows in', () => {
      assert.deepStrictEqual(ranked.map((row) => row.lord.name), ['BlockHead', 'Middle', 'BlockTail']);
      assert.deepStrictEqual(ranked.map((row) => row.rank), [1, 2, 3]);
      for (let i = 1; i < ranked.length; i += 1) {
        assert.ok(ranked[i].power <= ranked[i - 1].power, 'power must not rise with rank');
      }
    });

    // The profile reads one snapshot at a time. The newest one is what it
    // shows before anyone touches the picker; an older one cuts the series the
    // insights are built from, so that page reads as its own date rather than
    // as today's numbers wearing an old date beside them. The lord here is the
    // one the metric blocks were written for above.
    await saveSnapshot({
      server,
      isoDate: '1999-01-03',
      status: 'COMPLETE',
      url: 'u',
      alliances: ALLIANCES,
      players: [
        { id: '1001', name: 'Zed', rank: 1, allianceId: '[AAA] Alpha', stats: { Rank: '1', Power: '41,000,000,000' } },
        { id: '25615899', name: 'riv', rank: 2, allianceId: '[BBB] Beta', stats: { Rank: '2', Power: '25,000,000' } },
      ],
    });

    const newest = await getPlayerDetail('25615899');
    check('the profile opens on the newest snapshot', () => {
      assert.strictEqual(newest.snapshotDate, '1999-01-03');
      assert.deepStrictEqual(newest.snapshotDates, ['1999-01-03', '1999-01-01']);
      assert.strictEqual(newest.isLatest, true);
      assert.strictEqual(newest.history.length, 2);
      assert.strictEqual(newest.history[newest.history.length - 1].date, '1999-01-03');
      assert.strictEqual(newest.power, '25,000,000');
      assert.strictEqual(newest.sectionsDate, null, 'no detail has been read for the new date');
    });

    const past = await getPlayerDetail('25615899', { date: '1999-01-01' });
    check('an older snapshot cuts the series at its own date', () => {
      assert.strictEqual(past.snapshotDate, '1999-01-01');
      assert.strictEqual(past.isLatest, false);
      assert.deepStrictEqual(past.history.map((point) => point.date), ['1999-01-01']);
      assert.strictEqual(past.power, '18,300,813');
      assert.strictEqual(past.insights.coverage.last, '1999-01-01');
      assert.strictEqual(past.sectionsDate, DATE, 'the raw blocks come from that date too');
      assert.ok(past.sections.length > 0);
    });

    const unknownDate = await getPlayerDetail('25615899', { date: 'not-a-date' });
    const missingDate = await getPlayerDetail('25615899', { date: '2000-01-01' });
    check('a date that does not exist falls back to the newest', () => {
      assert.strictEqual(unknownDate.snapshotDate, '1999-01-03');
      assert.strictEqual(unknownDate.requestedDate, null);
      assert.strictEqual(missingDate.snapshotDate, '1999-01-03');
      assert.strictEqual(missingDate.requestedDate, '2000-01-01');
    });

    // A cookie the source has already discarded answers every request with a
    // 303 to /, so following redirects blindly is an infinite loop. That has to
    // surface as an expired session, which is what triggers the re-login.
    const { createServer } = require('http');
    const { fetchHtml } = require('../src/roster/http');
    const loop = createServer((req, res) => {
      res.writeHead(303, { Location: '/', 'Set-Cookie': 'session_token=; Path=/' });
      res.end();
    });
    const once = createServer((req, res) => {
      if (String(req.url).startsWith('/login')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<form action="/login" method="post"></form>');
        return;
      }
      res.writeHead(303, { Location: '/login' });
      res.end();
    });
    await new Promise((resolve) => loop.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => once.listen(0, '127.0.0.1', resolve));
    try {
      const looped = await fetchHtml(`http://127.0.0.1:${loop.address().port}/lord/1`, {
        cookie: 'session_token=stale',
      });
      const bounced = await fetchHtml(`http://127.0.0.1:${once.address().port}/lord/1`, {
        cookie: null,
      });

      check('a redirect loop reads as an expired session instead of throwing', () => {
        assert.strictEqual(looped.authExpired, true);
        assert.strictEqual(looped.ok, false);
        assert.strictEqual(looped.status, 0);
      });

      check('a single bounce to the login page is still an expired session', () => {
        assert.strictEqual(bounced.status, 200, 'the redirect must resolve, not loop');
        assert.strictEqual(bounced.authExpired, true);
        assert.strictEqual(new URL(bounced.url).pathname, '/login');
      });
    } finally {
      await new Promise((resolve) => loop.close(resolve));
      await new Promise((resolve) => once.close(resolve));
    }
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
