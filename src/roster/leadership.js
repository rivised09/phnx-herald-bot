/**
 * Builds the leadership window summary the web page reads instead of
 * downloading every player's history file.
 *
 * The web's `assembleLeadership()` (phoenix-herald-web/src/lib/roster/files.js)
 * is the single place the final payload shape is decided; this module only
 * produces the per-window facts it needs: the per-player rows, the activity
 * timeline, the snapshot health block and the baseline. The per-player loop
 * is a deliberate port of the web's full-read path - `web/scripts/
 * test-dashboard-parity.mjs` runs both against one fixture bucket and fails
 * if they ever disagree.
 *
 *   const summary = await buildLeadershipSummary(store, '2026-11-10');
 *   await store.put('leadership/2026-11-10.json', summary);
 *
 * `store` is any object with `get(key)` returning parsed JSON or null (the
 * R2 store in scrape.js/repair, or a directory store in tests). `files` is an
 * optional Map of already-loaded `players/<id>.json` documents, keyed by id,
 * so callers that just touched every player file do not fetch them again.
 */
const WINDOW_DAYS = 7;

/** Fetch many keys with a concurrency limit, null-safe per entry. */
async function pool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await work(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function powerOf(stats) {
  return Number(String(stats?.Power ?? '').replace(/,/g, '')) || null;
}

function isDragonSnapshot(snap) {
  return String(snap?.server?.url || '').includes('dragonstats');
}

async function buildLeadershipSummary(store, endDate, { files = null, concurrency = 20 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) return null;

  // Every calendar day of the window, so missing days surface as gaps.
  const windowDates = [];
  {
    let cursor = new Date(`${endDate}T00:00:00.000Z`);
    const start = new Date(cursor.getTime() - WINDOW_DAYS * 86400000);
    for (cursor = start; cursor <= new Date(`${endDate}T00:00:00.000Z`); cursor = new Date(cursor.getTime() + 86400000)) {
      windowDates.push(cursor.toISOString().slice(0, 10));
    }
  }

  const snapshots = new Map();
  for (const date of windowDates) {
    snapshots.set(date, await store.get(`snapshots/${date}.json`).catch(() => null));
  }

  // The same trust rule as the web reader: a DragonStats snapshot filed under
  // another day's scan is a copy, not a day, and callofstats history was
  // legitimately scraped late, so only DragonStats days are checked.
  const meta = windowDates.map((date) => {
    const snap = snapshots.get(date);
    if (!snap) return { date, valid: false, reason: 'missing', crawledAt: null };
    const crawled = String(snap.crawledAt || '').slice(0, 10);
    if (isDragonSnapshot(snap) && crawled && crawled !== date) {
      return { date, valid: false, reason: 'wrong-scan', crawledAt: snap.crawledAt || null };
    }
    return { date, valid: true, reason: null, crawledAt: snap.crawledAt || null };
  });
  const validDates = meta.filter((entry) => entry.valid).map((entry) => entry.date);
  if (!validDates.length) return null;

  const latestDate = validDates[validDates.length - 1];
  const baselineDate = validDates[0];
  const gaps = meta.filter((entry) => !entry.valid);

  // date -> playerId -> {power, alliance, name, merits}
  const snapshotData = new Map();
  const allIds = new Set(); // union across the window: the timeline counts
  // players who progressed on a day and are absent from the newest snapshot
  for (const date of windowDates) {
    const snap = snapshots.get(date);
    const byId = new Map();
    for (const row of snap?.players || []) {
      const id = String(row.id);
      byId.set(id, {
        power: powerOf(row.stats),
        alliance: row.allianceId || null,
        name: row.name,
        merits: row.merits || null,
      });
      allIds.add(id);
    }
    snapshotData.set(date, byId);
  }
  const latestSnapPlayers = snapshotData.get(latestDate);
  if (!latestSnapPlayers || !latestSnapPlayers.size) return null;
  const baselineSnapPlayers = snapshotData.get(baselineDate);

  // Player histories: reuse whatever the caller already loaded.
  const ids = [...allIds];
  const loaded = await pool(ids, concurrency, async (id) => {
    if (files && files.has(id)) return files.get(id);
    return store.get(`players/${id}.json`).catch(() => null);
  });
  const playerFiles = new Map();
  ids.forEach((id, i) => {
    if (loaded[i]) playerFiles.set(id, loaded[i]);
  });

  const players = [];
  let playersWithoutFile = 0;
  for (const [playerId, snapPlayer] of latestSnapPlayers) {
    const file = playerFiles.get(playerId);
    if (!file) {
      playersWithoutFile += 1;
      continue;
    }

    const observations = validDates
      .map((date, index) => {
        const m = file.metrics?.[date] || {};
        const snapEntry = snapshotData.get(date)?.get(playerId);
        return {
          index,
          date,
          values: {
            kills: m['Units Killed'] ?? null,
            deaths: m['Units Dead'] ?? null,
            healing: m['Units Healed'] ?? null,
            merits: m['Merits'] ?? null,
          },
          power: snapEntry?.power ?? m['Current Power'] ?? null,
        };
      })
      .filter(
        (item) =>
          Object.values(item.values).some((value) => value !== null) || item.power !== null,
      );
    if (!observations.length) continue;

    const first = observations[0] || null;
    const metricObservations = observations.filter((item) =>
      Object.values(item.values).some((value) => value !== null),
    );
    const firstMetric = metricObservations[0] || null;
    const lastMetric = metricObservations[metricObservations.length - 1] || null;
    const current = lastMetric?.values || {};
    const previousValues = firstMetric?.values || {};

    const powerChange =
      first?.power === null || first?.power === undefined || snapPlayer.power === null
        ? null
        : snapPlayer.power - first.power;

    const changes = Object.fromEntries(
      Object.keys(current).map((key) => [
        key,
        current[key] !== null && previousValues[key] !== null
          ? current[key] - previousValues[key]
          : null,
      ]),
    );

    const activeObservations = observations.slice(1).filter((observation, index) => {
      const before = observations[index].values;
      return (
        ['kills', 'merits', 'healing'].some(
          (key) =>
            before[key] !== null &&
            observation.values[key] !== null &&
            observation.values[key] > before[key],
        ) ||
        (observation.power !== null &&
          before.power !== null &&
          observation.power > before.power)
      );
    }).length;

    const activity =
      activeObservations >= 6
        ? 'Highly Active'
        : activeObservations >= 4
          ? 'Active'
          : activeObservations >= 1
            ? 'Low Activity'
            : 'Dormant';
    const status =
      activity === 'Highly Active'
        ? 'Core Fighter'
        : activity === 'Active'
          ? 'Support'
          : activity === 'Dormant'
            ? 'Dormant'
            : 'Monitor';

    // Same as the web reader: the observation rows only carry the four change
    // counters, so RoW/ToC metrics come from the full metric set of the last
    // observed day (see phoenix-herald-web files.js - both sides must agree).
    const lastMetrics = lastMetric ? (file.metrics?.[lastMetric.date] || lastMetric.values) : {};
    const rowMetrics = {
      score: lastMetrics['Highest RoW Score'] ?? null,
      wins: lastMetrics['RoW Wins'] ?? null,
      matches: lastMetrics['RoW Matches Played'] ?? null,
    };
    const tocMetrics = {
      wins: lastMetrics['ToC Wins'] ?? null,
      battles: lastMetrics['ToC Battles'] ?? null,
      winRate: lastMetrics['ToC Winrate'] ?? null,
    };

    const fileAlliance = file.byDate?.[latestDate]?.alliance;
    players.push({
      id: playerId,
      name: snapPlayer.name,
      powerFull: snapPlayer.power ?? null,
      powerValue: snapPlayer.power ?? 0,
      merits: snapPlayer.merits || null,
      activity,
      status,
      powerChange,
      changes,
      activityDays: activeObservations,
      alliance:
        (typeof fileAlliance === 'string' && fileAlliance.trim()) ||
        snapPlayer.alliance ||
        'Not In An Alliance',
      row:
        rowMetrics.score !== null || rowMetrics.wins !== null || rowMetrics.matches !== null
          ? rowMetrics
          : undefined,
      toc:
        tocMetrics.wins !== null || tocMetrics.battles !== null || tocMetrics.winRate !== null
          ? tocMetrics
          : undefined,
    });
  }

  // Baseline power over the same cohort as the current rows (see files.js).
  let baselinePower = 0;
  let baselineKnown = false;
  if (baselineSnapPlayers) {
    for (const player of players) {
      const entry = baselineSnapPlayers.get(player.id);
      if (entry?.power) {
        baselinePower += entry.power;
        baselineKnown = true;
      }
    }
  }

  const timeline = meta.map((entry, index) => {
    if (!entry.valid) {
      return { date: entry.date, activePlayers: null, gap: true, reason: entry.reason };
    }
    if (index === 0) {
      return { date: entry.date, activePlayers: null, gap: false, reason: 'first' };
    }
    const previous = meta[index - 1];
    if (!previous.valid) {
      return { date: entry.date, activePlayers: null, gap: true, reason: 'after-gap' };
    }
    let activePlayers = 0;
    for (const [, file] of playerFiles) {
      const currentM = file.metrics?.[entry.date] || {};
      const previousM = file.metrics?.[previous.date] || {};
      const progressed = ['Units Killed', 'Merits', 'Units Healed'].some((label) => {
        const current = currentM[label];
        const before = previousM[label];
        return current !== null && current !== undefined && before !== null && before !== undefined && current > before;
      });
      const currentPower = currentM['Current Power'];
      const previousPower = previousM['Current Power'];
      if (
        progressed ||
        (currentPower !== null &&
          currentPower !== undefined &&
          previousPower !== null &&
          previousPower !== undefined &&
          currentPower > previousPower)
      ) {
        activePlayers += 1;
      }
    }
    return { date: entry.date, activePlayers, gap: false, reason: null };
  });

  const latestMeta = meta.find((entry) => entry.date === latestDate);

  return {
    version: 1,
    endDate,
    windowDates,
    snapshotDate: latestDate,
    periodStart: windowDates[0],
    periodEnd: windowDates[windowDates.length - 1],
    players,
    timeline,
    health: {
      lastSnapshot: latestDate,
      lastCrawledAt: latestMeta?.crawledAt || null,
      count: validDates.length,
      total: windowDates.length,
      gaps: gaps.map((entry) => ({ date: entry.date, reason: entry.reason })),
      playersWithoutFile,
    },
    baseline: {
      known: baselineKnown,
      power: baselinePower,
      date: baselineKnown ? baselineDate : null,
      playerCount: baselineSnapPlayers ? baselineSnapPlayers.size : null,
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildLeadershipSummary, WINDOW_DAYS };
