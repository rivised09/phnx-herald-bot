const prisma = require('../db');
const { serverId, sourceUrl } = require('./v1');

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
    version: 'v1',
    status,
    detail,
    server: null,
    alliances: [],
    players: [],
    crawledAt: null,
    guild: null,
  };
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
    where: { serverId: server.id },
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

  const alliances = allianceRows.slice(0, MAX_ROWS).map((row) => {
    const stats = {};
    const power = formatStat(row.power);
    if (power) stats.Power = power;
    if (row.memberCount) stats.Members = String(row.memberCount);
    return {
      id: row.alliance.name,
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
    version: 'v1',
    status: alliances.length === 0 && players.length === 0 ? 'parse_empty' : 'ok',
    detail: notes.length ? notes.join(' ') : null,
    server: { id: String(number), url },
    alliances,
    players,
    crawledAt: new Date(snapshot.updatedAt).toISOString(),
    snapshot: {
      date: new Date(snapshot.snapshotDate).toISOString().slice(0, 10),
      ingestedAt: new Date(snapshot.createdAt).toISOString(),
    },
    guild: null,
  };
}

/** Footer/health counts without building the full payload. */
async function getStoredCounts() {
  const latest = await prisma.rosterSnapshot.findFirst({
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

module.exports = { getStoredRoster, getStoredCounts, formatStat };
