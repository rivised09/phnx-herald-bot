const prisma = require('./db');
const { serverId, sourceUrl } = require('./v1');

/**
 * The roster as flat files.
 *
 * Postgres is the scraping workspace: it is where a partially finished backfill
 * is resumed from, where a page can be re-read without losing what was already
 * collected, and where the `scannedAt` markers live. The site does not need any
 * of that. It needs one date's roster, one player's history, and one alliance's
 * members - three shapes that are each complete on their own.
 *
 * So this module turns the database into exactly those shapes, and nothing
 * else: an index, one file per snapshot, one per player, one per alliance.
 * Whoever writes them (scripts/export.js) decides whether they land in a
 * directory or in Cloudflare R2; the shapes here are the contract the read path
 * on the other side expects.
 *
 * Two rules keep the files small and the reader simple:
 *
 *  1. Numbers stay numbers. The database stores `power` as BigInt and the old
 *     read path formatted it back into "773,371,680" because the roster prints
 *     the string verbatim, but a file has no such constraint - the reader can
 *     format, and a chart can add up. `stats` keeps the rendered form anyway so
 *     an unchanged UI still has it.
 *  2. Nothing is derived twice. `history` is not stored next to `byDate`
 *     because it *is* `byDate` read one field at a time, and staleness ("this
 *     snapshot is 3 days old") depends on when it is read, not when it was
 *     written.
 */

const MAX_ROWS = 500;

/**
 * The source hands out one shared "no picture yet" asset. Storing it is
 * harmless, but serving it would show the same face for every player, so the
 * archive skips it exactly like the read path does.
 */
const PLACEHOLDER_AVATAR = /codweb_all_three_avatar|\/static\/images\//;

/**
 * The four troop-type merit counts the source prints under "Advanced War
 * Stats". The labels are fixed game vocabulary (the source's "archer" is
 * called Marksman), so they are keyed here rather than discovered.
 */
const MERIT_LABELS = {
  'Infantry Merits': 'infantry',
  'Cavalry Merits': 'cavalry',
  'Mage Merits': 'mage',
  'Marksman Merits': 'marksman',
};

function isoDay(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function usableAvatar(value) {
  return value && !PLACEHOLDER_AVATAR.test(value) ? value : null;
}

/** The display form the roster prints, kept for an unchanged UI. */
function formatStat(value) {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value).toLocaleString('en-US');
  } catch {
    return String(value);
  }
}

/** A metric row as the profile tabs render it: the string, not the number. */
function valueOf(row) {
  return row.valueNumber !== null ? row.valueNumber : row.valueText;
}

function emptyMerits() {
  return { infantry: 0, cavalry: 0, mage: 0, marksman: 0 };
}

/**
 * Every stored date, newest first, keeping one snapshot per date.
 *
 * A date can be ingested twice - a failed read is retried, a gap is re-scraped
 * - and both rows are COMPLETE by the time they are here. The newest ingest is
 * the one the read path serves, so it is also the one the archive keeps; the
 * older row's metrics are simply left out of the files.
 */
function oneRowPerDate(rows) {
  const seen = new Map();
  for (const row of rows) {
    const iso = isoDay(row.snapshotDate);
    if (!seen.has(iso)) seen.set(iso, row);
  }
  return [...seen.values()];
}

/** Grouped as the profile shows them, in the order the source prints them. */
function sectionsOf(metrics) {
  const bySection = new Map();
  for (const row of metrics) {
    if (row.section === 'Playstyle') continue;
    if (!bySection.has(row.section)) bySection.set(row.section, []);
    bySection.get(row.section).push({ label: row.label, value: row.valueText });
  }
  return [...bySection].map(([section, rows]) => ({ section, rows }));
}

/**
 * Splits one lord's metrics into the three shapes the profile reads.
 *
 * `Playstyle` is kept apart because its `Merits` is a percentile while the War
 * Stats `Merits` is an absolute count - the same word, two different series.
 */
function bucketLordMetrics(metrics, into) {
  for (const row of metrics) {
    const value = valueOf(row);
    if (value === null || value === undefined) continue;
    const bucket = row.section === 'Playstyle' ? into.radar : into.metrics;
    // The source prints a label once per section, so a repeat means a second
    // block rendered the same field; the first one is the one the page leads
    // with, and the later copy is dropped rather than overwriting it.
    if (!(row.label in bucket)) bucket[row.label] = value;
  }
}

/**
 * One date's roster, in the shape the home page already renders.
 *
 * `status` is `parse_empty` when a completed snapshot somehow has no rows; the
 * page uses it to show "the source returned nothing" rather than an empty
 * list that looks like a quiet server.
 */
function snapshotPayload(snapshot, metrics, serverNumber, avatarByLord) {
  const allianceRows = [...snapshot.allianceRows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const lordRows = [...snapshot.lordRows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  const meritsByLord = new Map();
  for (const row of metrics) {
    if (row.subjectType !== 'LORD' || row.section !== 'Advanced War Stats') continue;
    const key = MERIT_LABELS[row.label];
    if (!key) continue;
    if (!meritsByLord.has(row.subjectId)) meritsByLord.set(row.subjectId, emptyMerits());
    meritsByLord.get(row.subjectId)[key] = row.valueNumber == null ? 0 : Number(row.valueNumber);
  }

  const alliances = allianceRows.slice(0, MAX_ROWS).map((row) => {
    const stats = {};
    const power = formatStat(row.power);
    if (power) stats.Power = power;
    if (row.memberCount) stats.Members = String(row.memberCount);
    return { id: row.alliance.id, name: row.name || row.alliance.name, rank: row.rank, stats };
  });

  const players = lordRows.slice(0, MAX_ROWS).map((row) => {
    const stats = {};
    if (row.rank) stats.Rank = String(row.rank);
    const power = formatStat(row.power);
    if (power) stats.Power = power;
    return {
      id: row.lord.sourceId.toString(),
      name: row.name || row.lord.name,
      index: row.rank,
      allianceId: row.alliance ? row.alliance.name : null,
      avatar: usableAvatar(row.avatarUrl) || avatarByLord.get(row.lordId) || null,
      stats,
      merits: meritsByLord.get(row.lordId) || null,
    };
  });

  return {
    status: alliances.length === 0 && players.length === 0 ? 'parse_empty' : 'ok',
    server: { id: String(serverNumber), url: sourceUrl() },
    alliances,
    players,
    crawledAt: new Date(snapshot.updatedAt).toISOString(),
    snapshot: {
      date: isoDay(snapshot.snapshotDate),
      ingestedAt: new Date(snapshot.createdAt).toISOString(),
    },
  };
}

/** One date's entry in a player's or an alliance's file. */
function datedEntry({ name, rank, power, avatar, alliance, achievements, metrics }) {
  const entry = {
    name,
    rank: rank ?? null,
    power: power === null || power === undefined ? null : Number(power),
  };
  if (avatar) entry.avatar = avatar;
  if (alliance) entry.alliance = alliance;
  if (achievements && achievements.length) {
    entry.achievements = achievements.map((item) => ({
      name: item.name,
      progress: item.progress === null ? null : item.progress.toString(),
      target: item.target === null ? null : item.target.toString(),
      completedAt: item.completedAt ? item.completedAt.toISOString().slice(0, 10) : null,
    }));
  }
  if (metrics.length) entry.sections = sectionsOf(metrics);
  return entry;
}

function emptyPlayer(sourceId) {
  return {
    id: sourceId,
    name: null,
    dates: [],
    byDate: {},
    metrics: {},
    radar: {},
    nameHistory: [],
    otherServers: [],
  };
}

function emptyAlliance(id) {
  return { id, name: null, dates: [], byDate: {} };
}

/**
 * Builds every file for one server.
 *
 * The whole archive is assembled in memory before anything is written: a file
 * that is half a snapshot is worse than no file, so the write step only ever
 * sees complete objects. Metrics are read one snapshot at a time rather than
 * in one query - a full history reaches six figures of rows, and a single
 * `findMany` for all of them spends memory on the same data the per-date read
 * spends on one date.
 */
async function buildArchive({ number = Number(serverId()) } = {}) {
  const server = await prisma.sourceServer.findUnique({ where: { serverNumber: number } });
  if (!server) throw new Error(`Server ${number} has never been ingested.`);

  const stored = await prisma.rosterSnapshot.findMany({
    where: { serverId: server.id, status: 'COMPLETE' },
    orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
    include: {
      allianceRows: { include: { alliance: true } },
      lordRows: { include: { lord: true, alliance: true, achievements: true } },
    },
  });
  const snapshots = oneRowPerDate(stored);
  if (!snapshots.length) throw new Error(`Server ${number} has no completed snapshots.`);

  const snapshotsOut = new Map();
  const players = new Map();
  const alliances = new Map();

  /**
   * The newest picture each player has, whichever date it came from.
   *
   * The database read falls back to this when a date's row has no avatar, which
   * is most dates - the source only publishes a picture on a player's page, so
   * the roster crawl rarely sees one. Resolving the fallback here means the
   * roster file is complete on its own, and the reader does not have to walk
   * other dates to fill one field in.
   */
  const avatarByLord = new Map();
  for (const snapshot of snapshots) {
    for (const row of snapshot.lordRows) {
      const value = usableAvatar(row.avatarUrl);
      if (value && !avatarByLord.has(row.lordId)) avatarByLord.set(row.lordId, value);
    }
  }

  for (const snapshot of snapshots) {
    const iso = isoDay(snapshot.snapshotDate);
    const metrics = await prisma.snapshotMetric.findMany({
      where: { snapshotId: snapshot.id },
      select: {
        subjectType: true,
        subjectId: true,
        section: true,
        label: true,
        valueNumber: true,
        valueText: true,
      },
      orderBy: [{ section: 'asc' }, { label: 'asc' }],
    });

    snapshotsOut.set(iso, snapshotPayload(snapshot, metrics, number, avatarByLord));

    const lordMetrics = new Map();
    const allianceMetrics = new Map();
    for (const row of metrics) {
      if (row.subjectType === 'LORD') {
        if (!lordMetrics.has(row.subjectId)) lordMetrics.set(row.subjectId, []);
        lordMetrics.get(row.subjectId).push(row);
      } else if (row.subjectType === 'ALLIANCE') {
        if (!allianceMetrics.has(row.subjectId)) allianceMetrics.set(row.subjectId, []);
        allianceMetrics.get(row.subjectId).push(row);
      }
    }

    for (const row of snapshot.lordRows) {
      const sourceId = row.lord.sourceId.toString();
      if (!players.has(sourceId)) players.set(sourceId, emptyPlayer(sourceId));
      const player = players.get(sourceId);
      const rows = lordMetrics.get(row.lordId) || [];
      player.dates.push(iso);
      player.byDate[iso] = datedEntry({
        name: row.name || row.lord.name,
        rank: row.rank,
        power: row.power,
        avatar: usableAvatar(row.avatarUrl),
        alliance: row.alliance ? row.alliance.name : null,
        achievements: row.achievements,
        metrics: rows,
      });
      if (rows.length) {
        if (!player.metrics[iso]) player.metrics[iso] = {};
        if (!player.radar[iso]) player.radar[iso] = {};
        bucketLordMetrics(rows, {
          metrics: player.metrics[iso],
          radar: player.radar[iso],
        });
      }
    }

    for (const row of snapshot.allianceRows) {
      if (!alliances.has(row.allianceId)) alliances.set(row.allianceId, emptyAlliance(row.allianceId));
      const alliance = alliances.get(row.allianceId);
      alliance.dates.push(iso);
      const members = snapshot.lordRows
        .filter((lord) => lord.allianceId === row.allianceId)
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
        .map((lord) => ({
          id: lord.lord.sourceId.toString(),
          name: lord.name || lord.lord.name,
          rank: lord.rank,
          power: lord.power === null ? null : Number(lord.power),
        }));
      alliance.byDate[iso] = {
        name: row.name || row.alliance.name,
        rank: row.rank ?? null,
        power: Number(row.power),
        memberCount: row.memberCount || members.length,
        players: members,
        ...(allianceMetrics.get(row.allianceId)?.length
          ? { sections: sectionsOf(allianceMetrics.get(row.allianceId)) }
          : {}),
      };
    }
  }

  // Names and other servers are per player, not per date, and are read after
  // the loop so one query covers all of them.
  const lordRows = await prisma.lord.findMany({
    where: { serverId: server.id },
    select: { sourceId: true, name: true, nameHistory: { select: { name: true } } },
  });
  const otherServers = await prisma.lord.findMany({
    where: { sourceId: { in: lordRows.map((row) => row.sourceId) }, serverId: { not: server.id } },
    select: { sourceId: true, server: { select: { serverNumber: true } } },
    orderBy: { server: { serverNumber: 'asc' } },
  });
  const otherServersByLord = new Map();
  for (const row of otherServers) {
    const key = row.sourceId.toString();
    if (!otherServersByLord.has(key)) otherServersByLord.set(key, []);
    otherServersByLord.get(key).push(row.server.serverNumber);
  }

  for (const row of lordRows) {
    const sourceId = row.sourceId.toString();
    if (!players.has(sourceId)) players.set(sourceId, emptyPlayer(sourceId));
    const player = players.get(sourceId);
    player.name = player.byDate[player.dates[0]]?.name || row.name;
    player.nameHistory = row.nameHistory.map((item) => item.name);
    player.otherServers = otherServersByLord.get(sourceId) || [];
    // Dates are appended newest first because the snapshots are walked that
    // way; a player who was absent on a date simply has no entry for it.
    player.byDate = Object.fromEntries(
      player.dates.map((date) => [date, player.byDate[date]]),
    );
  }

  for (const alliance of alliances.values()) {
    alliance.name = alliance.byDate[alliance.dates[0]]?.name || null;
  }

  const dates = snapshots.map((snapshot) => isoDay(snapshot.snapshotDate));
  const index = {
    version: 1,
    server: { id: String(number), url: sourceUrl() },
    latest: dates[0],
    dates,
    generatedAt: new Date().toISOString(),
    counts: {
      snapshots: dates.length,
      players: players.size,
      alliances: alliances.size,
    },
  };

  return { index, snapshots: snapshotsOut, players, alliances };
}

module.exports = { buildArchive, isoDay, formatStat };
