const prisma = require('../db');
const { serverId, sourceUrl } = require('./v1');
const { buildInsights } = require('./insights');

/**
 * Read path for the v1 home roster: the database only.
 *
 * The old v1 path launched Chromium per refresh, which made every visitor a
 * scrape and tied site availability to source availability. Snapshots are now
 * ingested ahead of time by ./ingest, so this module only reads the newest one
 * and answers in the exact payload shape the web already renders
 * (`src/roster/v1.js` documents it).
 *
 * STATUS VALUES:
 *   ok             - a snapshot was found and served
 *   awaiting_sync  - nothing has been ingested yet (cold start)
 *   not_configured - the source URL could not be resolved
 */

const MAX_ROWS = 500;

/**
 * Source figures are rendered with thousands separators ("773,371,680") and
 * the web prints them verbatim (`PlayerRoster` does `String(value)`), so power
 * is converted back into that display form here rather than exposing a raw
 * BigInt, which would also break JSON serialisation.
 */
function formatStat(value) {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value).toLocaleString('en-US');
  } catch {
    return String(value);
  }
}

function failure(status, detail) {
  return {
    status,
    detail,
    server: null,
    alliances: [],
    players: [],
    crawledAt: null,
    guild: null,
  };
}

/**
 * The source hands out one shared "no picture yet" asset. Storing it is
 * harmless, but serving it would show the same face for every player, so the
 * reads here skip it and fall through to the player's real history.
 */
const PLACEHOLDER_AVATAR = /codweb_all_three_avatar|\/static\/images\//;

function usableAvatar(value) {
  return value && !PLACEHOLDER_AVATAR.test(value) ? value : null;
}

async function historicalAvatarMap(serverIdValue, lordIds) {
  if (!lordIds.length) return new Map();
  const rows = await prisma.lordSnapshot.findMany({
    where: {
      lordId: { in: lordIds },
      avatarUrl: { not: null },
      snapshot: { serverId: serverIdValue, status: 'COMPLETE' },
    },
    select: { lordId: true, avatarUrl: true },
    orderBy: { snapshot: { snapshotDate: 'desc' } },
  });
  const result = new Map();
  for (const row of rows) {
    const value = usableAvatar(row.avatarUrl);
    if (value && !result.has(row.lordId)) result.set(row.lordId, value);
  }
  return result;
}

async function getStoredRoster() {
  let number;
  let url;
  try {
    number = Number(serverId());
    url = sourceUrl();
  } catch (err) {
    return failure('not_configured', err.message);
  }

  const server = await prisma.sourceServer.findUnique({ where: { serverNumber: number } });
  if (!server) {
    return failure(
      'awaiting_sync',
      'No snapshot has been ingested for this server yet. The first background sync will fill it in.',
    );
  }

  const snapshot = await prisma.rosterSnapshot.findFirst({
    // An unverified read may contain the source homepage shell rather than
    // roster data. Never let it replace the newest complete database snapshot
    // on the public page.
    where: { serverId: server.id, status: 'COMPLETE' },
    orderBy: { snapshotDate: 'desc' },
    include: {
      allianceRows: { include: { alliance: true } },
      lordRows: { include: { lord: true, alliance: true } },
    },
  });

  if (!snapshot) {
    return failure('awaiting_sync', `Server ${number} has no snapshots yet.`);
  }

  // Source order is already power-ranked; rank is assigned at ingest, so the
  // stored value is used as-is and power only decides the tie-break order.
  const allianceRows = [...snapshot.allianceRows].sort(
    (a, b) => (a.rank ?? 0) - (b.rank ?? 0),
  );
  const lordRows = [...snapshot.lordRows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const avatarByLord = await historicalAvatarMap(
    server.id,
    lordRows.slice(0, MAX_ROWS).map((row) => row.lordId),
  );

  const alliances = allianceRows.slice(0, MAX_ROWS).map((row) => {
    const stats = {};
    const power = formatStat(row.power);
    if (power) stats.Power = power;
    if (row.memberCount) stats.Members = String(row.memberCount);
    return {
      id: row.alliance.id,
      name: row.alliance.name,
      rank: row.rank,
      stats,
    };
  });

  const players = lordRows.slice(0, MAX_ROWS).map((row) => {
    const stats = {};
    if (row.rank) stats.Rank = String(row.rank);
    const power = formatStat(row.power);
    if (power) stats.Power = power;
    return {
      id: row.lord.sourceId.toString(),
      name: row.lord.name,
      index: row.rank,
      allianceId: row.alliance ? row.alliance.name : null,
      avatar: usableAvatar(row.avatarUrl) || avatarByLord.get(row.lordId) || null,
      stats,
    };
  });

  const notes = [];
  const staleDays = Math.floor(
    (Date.now() - new Date(snapshot.snapshotDate).getTime()) / 86400000,
  );
  if (staleDays > 2) {
    notes.push(
      `This is the snapshot from ${new Date(snapshot.snapshotDate).toISOString().slice(0, 10)}, ${staleDays} days old.`,
    );
  }

  return {
    status: alliances.length === 0 && players.length === 0 ? 'parse_empty' : 'ok',
    detail: notes.length ? notes.join(' ') : null,
    server: { id: String(number), url },
    alliances,
    players,
    crawledAt: new Date(snapshot.updatedAt).toISOString(),
    snapshot: {
      date: new Date(snapshot.snapshotDate).toISOString().slice(0, 10),
      ingestedAt: new Date(snapshot.createdAt).toISOString(),
      staleDays,
    },
    guild: null,
  };
}

/** Footer/health counts without building the full payload. */
async function getStoredCounts() {
  // Scoped to the configured server like getStoredRoster is: without this the
  // footer reports whichever server happens to hold the newest date, which is
  // someone else's roster as soon as a second server is ever ingested.
  const server = await prisma.sourceServer.findUnique({
    where: { serverNumber: Number(serverId()) },
  });
  if (!server) return { alliances: 0, players: 0, snapshotDate: null };

  const latest = await prisma.rosterSnapshot.findFirst({
    where: { serverId: server.id, status: 'COMPLETE' },
    orderBy: { snapshotDate: 'desc' },
    select: { lordCount: true, allianceCount: true, snapshotDate: true },
  });
  if (!latest) return { alliances: 0, players: 0, snapshotDate: null };
  return {
    alliances: latest.allianceCount,
    players: latest.lordCount,
    snapshotDate: new Date(latest.snapshotDate).toISOString().slice(0, 10),
  };
}

async function latestSnapshot(serverIdValue) {
  return prisma.rosterSnapshot.findFirst({
    where: { serverId: serverIdValue, status: 'COMPLETE' },
    orderBy: { snapshotDate: 'desc' },
  });
}

/**
 * Detail metrics are only ever written for the players whose detail page the
 * background pass has actually read, so a miss here is normal and means "not
 * measured yet" - never zero.
 *
 * Returns three things rather than one: `Playstyle` holds percentiles that
 * reuse the word "Merits", while `War Stats` holds an absolute merit count, so
 * those two are kept apart or one would overwrite the other. `sections` is the
 * newest date's remaining blocks, grouped exactly as the source prints them -
 * the raw figures behind the interpreted insights, for the tabbed page.
 *
 * `snapshotDate` picks which date's blocks come back - the profile page reads
 * one snapshot at a time. Left unset, the newest date that has any is used.
 * `metrics` and `radar` always span every date either way: the interpreted
 * view is built from a series, and a single point is not a series.
 */
async function loadPlayerMetrics(serverIdValue, lordId, { snapshotDate = null } = {}) {
  const rows = await prisma.snapshotMetric.findMany({
    where: {
      subjectType: 'LORD',
      subjectId: lordId,
      snapshot: { serverId: serverIdValue, status: 'COMPLETE' },
    },
    select: {
      section: true,
      label: true,
      valueNumber: true,
      valueText: true,
      snapshot: { select: { snapshotDate: true } },
    },
    orderBy: [{ snapshot: { snapshotDate: 'asc' } }, { section: 'asc' }, { label: 'asc' }],
  });

  const metrics = {};
  const radar = {};
  const byDate = new Map();
  let newestWithRows = null;
  for (const row of rows) {
    const value = row.valueNumber !== null ? row.valueNumber : row.valueText;
    if (value === null || value === undefined) continue;
    const date = row.snapshot.snapshotDate.toISOString().slice(0, 10);
    const playstyle = row.section === 'Playstyle';
    const bucket = playstyle ? radar : metrics;
    if (!bucket[date]) bucket[date] = {};
    bucket[date][row.label] = value;
    if (playstyle) continue;

    // The rendered string is what the tabs show: the number alone would turn
    // "54.49%" and "0.0%" into 54.49 and 0, and "21,520 Sec" into 21520.
    if (!byDate.has(date)) byDate.set(date, new Map());
    const bySection = byDate.get(date);
    if (!bySection.has(row.section)) bySection.set(row.section, []);
    bySection.get(row.section).push({ label: row.label, value: row.valueText });
    newestWithRows = date;
  }

  // Ascending order means the last date seen is the newest one.
  const wanted = snapshotDate || newestWithRows;
  const sections = wanted && byDate.has(wanted)
    ? [...byDate.get(wanted)].map(([section, entries]) => ({ section, rows: entries }))
    : [];

  return { metrics, radar, sections, sectionsDate: sections.length ? wanted : null };
}

/**
 * One date a player can be read at, or null when it is not a date.
 *
 * The profile's picker only offers dates that exist, but a bookmarked or
 * stale URL can ask for anything, and an unparsable one must not reach a query.
 */
function snapshotDateParam(value) {
  const iso = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

function isoDay(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function dayStart(iso) {
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * The row backing one date, or the newest row when `iso` is null.
 *
 * Both reads are the same query apart from the date filter and the ordering,
 * and the profile issues them together rather than one after the other: the
 * picker always needs the full date list, and the body needs whichever date
 * ends up winning. Each round trip here is a network hop, so collapsing them
 * is the cheapest latency this page can buy.
 */
function lordRowFor(lordId, serverIdValue, iso = null) {
  const snapshot = { serverId: serverIdValue, status: 'COMPLETE' };
  if (iso) snapshot.snapshotDate = dayStart(iso);

  return prisma.lordSnapshot.findFirst({
    where: { lordId, snapshot },
    ...(iso ? {} : { orderBy: { snapshot: { snapshotDate: 'desc' } } }),
    include: { lord: true, alliance: true, achievements: true, snapshot: true },
  });
}

/** Keeps only the dates that are at or before `iso`, so nothing later shows. */
function upTo(byDate, iso) {
  const out = {};
  for (const [date, values] of Object.entries(byDate || {})) {
    if (date <= iso) out[date] = values;
  }
  return out;
}

/**
 * A player's profile at one point in time.
 *
 * `date` selects the snapshot to read; unset means the newest one, which is
 * what the page shows before anyone touches the picker. Everything the page
 * derives from a series - the chart, the insights, the raw stat blocks - is
 * cut at the selected date as well, so an older snapshot reads as that snapshot
 * rather than as today's numbers with an old date next to them.
 *
 * The dates the picker offers come from the same player's own rows, newest
 * first; a player who only appears on one date gets one option and the web UI
 * hides the control.
 *
 * The queries are grouped into the fewest stages the result shape allows -
 * three instead of the seven it would take written top to bottom - because the
 * whole route is blocked on this function and every stage is a round trip.
 */
async function getPlayerDetail(sourceId, { date = null } = {}) {
  const serverNumber = Number(serverId());

  // The server row is only ever used for its id, so it is read through the
  // player instead of as a lookup of its own. An unknown server and an unknown
  // player both mean "no such profile" and answer identically.
  const lord = await prisma.lord.findFirst({
    where: { sourceId: BigInt(sourceId), server: { serverNumber } },
    select: { id: true, serverId: true },
  });
  if (!lord) return null;

  const requested = snapshotDateParam(date);
  const [dated, optimisticRow] = await Promise.all([
    prisma.lordSnapshot.findMany({
      where: { lordId: lord.id, snapshot: { serverId: lord.serverId, status: 'COMPLETE' } },
      select: { snapshot: { select: { snapshotDate: true } } },
      orderBy: { snapshot: { snapshotDate: 'desc' } },
    }),
    lordRowFor(lord.id, lord.serverId, requested),
  ]);

  const snapshotDates = [];
  for (const item of dated) {
    const iso = isoDay(item.snapshot.snapshotDate);
    if (snapshotDates[0] !== iso) snapshotDates.push(iso);
  }
  if (!snapshotDates.length) return null;

  // A date with no row for this player falls back to the newest one: the page
  // must still render rather than 404 because a link outlived the snapshot.
  const wanted = requested && snapshotDates.includes(requested) ? requested : snapshotDates[0];
  let row = optimisticRow;
  if (!row || isoDay(row.snapshot.snapshotDate) !== wanted) {
    row = await lordRowFor(lord.id, lord.serverId, wanted);
  }
  if (!row) return null;

  // Nothing below depends on anything else in this group, so they travel
  // together: the avatar history, the power/rank series and the metric rows
  // that feed the insights.
  const [avatarByLord, historyRows, metricBuckets] = await Promise.all([
    historicalAvatarMap(lord.serverId, [row.lordId]),
    prisma.lordSnapshot.findMany({
      where: {
        lordId: row.lordId,
        snapshot: { serverId: lord.serverId, status: 'COMPLETE' },
      },
      select: {
        power: true,
        rank: true,
        snapshot: { select: { snapshotDate: true } },
      },
      orderBy: { snapshot: { snapshotDate: 'asc' } },
    }),
    loadPlayerMetrics(lord.serverId, row.lordId, { snapshotDate: wanted }),
  ]);

  const history = historyRows
    .map((item) => ({
      date: item.snapshot.snapshotDate.toISOString().slice(0, 10),
      power: item.power === null ? null : Number(item.power),
      rank: item.rank || null,
    }))
    .filter((point) => point.date <= wanted);

  const { metrics: allMetrics, radar: allRadar, sections, sectionsDate } = metricBuckets;
  const metricsByDate = upTo(allMetrics, wanted);
  const radarByDate = upTo(allRadar, wanted);
  const insights = buildInsights({
    history,
    metricsByDate,
    radarByDate,
    serverNumber,
    name: row.lord.name,
  });

  return {
    id: row.lord.sourceId.toString(),
    name: row.lord.name,
    rank: row.rank,
    power: formatStat(row.power),
    avatar: usableAvatar(row.avatarUrl) || avatarByLord.get(row.lordId) || null,
    alliance: row.alliance ? { id: row.alliance.name, name: row.alliance.name } : null,
    snapshotDate: wanted,
    snapshotDates,
    requestedDate: requested,
    isLatest: wanted === snapshotDates[0],
    history,
    sections,
    sectionsDate,
    insights,
    achievements: row.achievements.map((item) => ({
      name: item.name,
      progress: item.progress?.toString() || null,
      target: item.target?.toString() || null,
      completedAt: item.completedAt?.toISOString().slice(0, 10) || null,
    })),
  };
}

/**
 * An alliance's newest stored figures and the members in them.
 *
 * The alliance, its latest row and the server they belong to collapse into one
 * read: the relation filters do the scoping that three separate lookups used to
 * do, so an alliance from another server or one with no stored snapshot simply
 * finds nothing and answers 404 like before. Only the member list still needs
 * its own round trip, and it has to wait for the row it hangs off.
 */
async function getAllianceDetail(id) {
  const row = await prisma.allianceSnapshot.findFirst({
    where: {
      allianceId: id,
      alliance: { server: { serverNumber: Number(serverId()) } },
      snapshot: { status: 'COMPLETE' },
    },
    include: { alliance: true, snapshot: true },
    orderBy: { snapshot: { snapshotDate: 'desc' } },
  });
  if (!row) return null;

  const snapshot = row.snapshot;
  const members = await prisma.lordSnapshot.findMany({
    where: { snapshotId: snapshot.id, allianceId: row.allianceId },
    include: { lord: true },
    orderBy: { rank: 'asc' },
  });
  return {
    id: row.alliance.id,
    name: row.alliance.name,
    rank: row.rank || null,
    power: formatStat(row.power),
    memberCount: row.memberCount || members.length,
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    players: members.map((item) => ({
      id: item.lord.sourceId.toString(),
      name: item.lord.name,
      rank: item.rank,
      power: formatStat(item.power),
    })),
  };
}

module.exports = {
  getStoredRoster,
  getStoredCounts,
  getPlayerDetail,
  getAllianceDetail,
  loadPlayerMetrics,
  formatStat,
};
