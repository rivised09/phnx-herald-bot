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

  // Per-interval progression, keyed by date: the lord ids that showed
  // measurable progress between that date and the previous usable snapshot.
  // Filled while the timeline is built, then split into activity bands below.
  const progressedByDate = new Map();

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

    // KvK merits reset when a new round starts, so `last - first` over the
    // window is negative for exactly the lords who are earning the most right
    // now - which made the overview say "No merit growth this window" while
    // two lords held 91K and 74K. A drop in the series means the counter
    // restarted, and then the current value *is* the growth since the reset.
    const meritSeries = metricObservations
      .map((item) => item.values.merits)
      .filter((value) => value !== null && value !== undefined);
    if (meritSeries.length < 2) changes.merits = null;
    else {
      let resetSeen = false;
      let gained = 0;
      for (let i = 1; i < meritSeries.length; i += 1) {
        if (meritSeries[i] >= meritSeries[i - 1]) gained += meritSeries[i] - meritSeries[i - 1];
        else resetSeen = true;
      }
      changes.merits = resetSeen ? meritSeries[meritSeries.length - 1] : gained;
    }

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
    // Current KvK merits and the merits-to-power ratio the lists show: the
    // same figure and rounding as the web reader (`ratioFields` in
    // phoenix-herald-web/src/lib/roster/files.js). KvK Merits leads; lifetime
    // `Total Merits` is not used, since it never resets.
    const meritValue = Number(
      lastMetrics['KvK Merits'] ?? lastMetrics.Merits ?? lastMetrics['PvP Points'],
    );
    const meritsTotal = Number.isFinite(meritValue) ? meritValue : null;
    const mpRatio =
      meritsTotal !== null && (snapPlayer.power ?? 0) > 0
        ? Math.round((meritsTotal / snapPlayer.power) * 10000) / 100
        : null;
    players.push({
      id: playerId,
      name: snapPlayer.name,
      powerFull: snapPlayer.power ?? null,
      powerValue: snapPlayer.power ?? 0,
      merits: snapPlayer.merits || null,
      meritsTotal,
      mpRatio,
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

  // id -> the alliance the players table shows for that lord (window-end
  // entry, snapshot as fallback). Used to bucket the activity timeline so the
  // dashboard can filter the trend by alliance; the same rule as
  // `players[].alliance` keeps the buckets and the table in agreement.
  const allianceByLord = new Map();
  for (const [id, file] of playerFiles) {
    const fileAlliance = file.byDate?.[latestDate]?.alliance;
    const snapEntry = latestSnapPlayers.get(id);
    allianceByLord.set(
      id,
      (typeof fileAlliance === 'string' && fileAlliance.trim()) ||
        snapEntry?.alliance ||
        'Not In An Alliance',
    );
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
    // Per-alliance counts for the dashboard's alliance filter.
    const byAlliance = {};
    const progressedIds = new Set();
    for (const [id, file] of playerFiles) {
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
        progressedIds.add(id);
        const alliance = allianceByLord.get(id) || 'Not In An Alliance';
        byAlliance[alliance] = (byAlliance[alliance] || 0) + 1;
      }
    }
    progressedByDate.set(entry.date, progressedIds);
    return { date: entry.date, activePlayers, gap: false, reason: null, byAlliance };
  });

  // A lord's band is how many intervals they progressed in - the same count
  // behind `players[].activity` - so the three band counts add up to the
  // interval total, including lords no longer in the newest snapshot.
  const bandByLord = new Map();
  for (const ids of progressedByDate.values()) {
    for (const id of ids) bandByLord.set(id, (bandByLord.get(id) || 0) + 1);
  }
  const bandOf = (intervals) =>
    intervals >= 6 ? 'Highly Active' : intervals >= 4 ? 'Active' : 'Low Activity';
  for (const point of timeline) {
    const ids = progressedByDate.get(point.date);
    if (!ids) continue;
    point.highlyActive = 0;
    point.active = 0;
    point.lowActivity = 0;
    // The same split per alliance, so filtering the trend by alliance keeps the
    // three band lines instead of dropping to a single total for the selection.
    const bandsByAlliance = {};
    for (const id of ids) {
      const band = bandOf(bandByLord.get(id) || 0);
      const alliance = allianceByLord.get(id) || 'Not In An Alliance';
      const bucket =
        bandsByAlliance[alliance] ||
        (bandsByAlliance[alliance] = { highlyActive: 0, active: 0, lowActivity: 0 });
      if (band === 'Highly Active') {
        point.highlyActive += 1;
        bucket.highlyActive += 1;
      } else if (band === 'Active') {
        point.active += 1;
        bucket.active += 1;
      } else {
        point.lowActivity += 1;
        bucket.lowActivity += 1;
      }
    }
    point.bandsByAlliance = bandsByAlliance;
  }

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
