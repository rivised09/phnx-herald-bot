const prisma = require('../db');
const { withAuthedPage, BASE } = require('./session');
const {
  serverId,
  sourceUrl,
  open,
  isLoginPage,
  extractEntities,
} = require('./v1');

/**
 * Ingest: turns the stats site into dated snapshots in the database.
 *
 * The site keeps a daily history behind `?selected_date=YYYY-MM-DD`, so every
 * date is a separate browser page load. That makes ingestion worth doing well
 * away from a request handler:
 *
 *   - one browser context covers every date in a run (launching Chromium per
 *     date would roughly double the cost of a batch),
 *   - a run only fetches dates we do not already have, oldest first, capped at
 *     a small batch so a cold start cannot outlive Railway's request timeout,
 *   - a date that is already stored and current costs nothing at all.
 *
 * STATUS VALUES (written to roster_snapshots.status):
 *   COMPLETE        - the page carried a date we could confirm
 *   UNVERIFIED_DATE - rows were stored but the source never named the date
 */

const MAX_POWER = 1000000000000;

function envInt(name, fallback) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

/** How many missing dates a single run will fill in. */
const BACKFILL_BATCH = envInt('ROSTER_BACKFILL_BATCH', 3);
/** How many of the newest dates are eligible for backfill at all. */
const BACKFILL_LIMIT = envInt('ROSTER_BACKFILL_LIMIT', 30);
/** Re-read the newest date at least this often. */
const REFRESH_MS = envInt('ROSTER_REFRESH_MINUTES', 240) * 60 * 1000;
/** How long discovered dates are reused before asking the source again. */
const DISCOVERY_TTL_MS = envInt('ROSTER_DISCOVERY_TTL_MS', 30 * 60 * 1000);

function minimumPower() {
  return envInt('ROSTER_MINIMUM_POWER', 0);
}

function serverNumber() {
  const parsed = Number(serverId());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const err = new Error('CALLOFSTATS_SERVER_ID is not a valid server number');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return parsed;
}

/**
 * Builds a server URL carrying the filters this ingest always uses.
 *
 * A URL API is used rather than string concatenation because PLAYER_STATS_
 * SOURCE_URL may already carry a query string, and because the date filter has
 * to replace - not append to - any date already present.
 */
function serverUrl({ date } = {}) {
  const url = new URL(sourceUrl());
  url.searchParams.set('minimum_power', String(minimumPower()));
  if (date) url.searchParams.set('selected_date', date);
  else url.searchParams.delete('selected_date');
  return url.toString();
}

const toIso = (value) => new Date(value).toISOString().slice(0, 10);
const toDate = (iso) => new Date(`${iso}T00:00:00.000Z`);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * "773,371,680" / "1.2M" -> BigInt.
 *
 * The source renders power with thousands separators, so the commas are
 * stripped rather than parsed as a float: a 10-digit figure would lose digits
 * through Number before it ever reached the BIGINT column.
 */
function toBigIntStat(value) {
  if (value === null || value === undefined) return 0n;
  const digits = String(value).replace(/[^\d]/g, '');
  if (!digits) return 0n;
  const big = BigInt(digits);
  return big > BigInt(MAX_POWER) ? BigInt(MAX_POWER) : big;
}

function toIntStat(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

/**
 * Runs inside the browser. Reads every date the page offers plus the one it is
 * currently showing.
 *
 * Both `<select>` options and the site's custom date list are scanned, and a
 * date is only accepted in `YYYY-MM-DD` form so nothing is guessed from a
 * locale-dependent string. `available` comes back oldest-first, which is the
 * order a backfill needs.
 */
function readDateState() {
  const found = new Set();
  let active = null;

  const ISO = /\d{4}-\d{2}-\d{2}/;
  const absorb = (text) => {
    if (!text) return;
    const match = String(text).match(ISO);
    if (match) found.add(match[0]);
  };

  document.querySelectorAll('select option').forEach((option) => {
    absorb(option.value);
    absorb(option.textContent);
    if (option.selected && !active) {
      const value = String(option.value || option.textContent || '').match(ISO);
      if (value) active = value[0];
    }
  });

  document.querySelectorAll('input[type="date"]').forEach((input) => {
    absorb(input.value);
    if (input.value && !active) {
      const value = String(input.value).match(ISO);
      if (value) active = value[0];
    }
  });

  document.querySelectorAll('[data-date], [data-value]').forEach((el) => {
    absorb(el.getAttribute('data-date'));
    absorb(el.getAttribute('data-value'));
    if (!active) {
      const cls = ` ${el.className || ''} `;
      if (/selected|active|current/i.test(cls)) {
        const value = `${el.getAttribute('data-date') || ''} ${el.getAttribute('data-value') || ''}`.match(ISO);
        if (value) active = value[0];
      }
    }
  });

  // Catch-all: any date-shaped text near a date picker heading.
  document
    .querySelectorAll('[class*="date"], [class*="Date"], [class*="calendar"], [class*="day"]')
    .forEach((el) => absorb(el.textContent));

  const available = [...found].sort();
  if (!active && available.length) active = available[available.length - 1];

  return { active, available };
}

function credentialError(message) {
  const err = new Error(message);
  err.code = 'BAD_CREDENTIALS';
  return err;
}

async function ensureServer() {
  const number = serverNumber();
  return prisma.sourceServer.upsert({
    where: { serverNumber: number },
    create: { serverNumber: number },
    update: {},
  });
}

/** date (ISO) -> when that snapshot was last written. */
async function loadExisting(server) {
  const rows = await prisma.rosterSnapshot.findMany({
    where: { serverId: server.id },
    select: { snapshotDate: true, updatedAt: true },
    orderBy: { snapshotDate: 'desc' },
  });
  const map = new Map();
  rows.forEach((row) => map.set(toIso(row.snapshotDate), row.updatedAt));
  return map;
}

/** Replaces the snapshot's rows outright, so a re-ingest cannot leave stale ones. */
async function saveSnapshot({ server, isoDate, status, url, alliances, players }) {
  return prisma.$transaction(async (tx) => {
    const snapshot = await tx.rosterSnapshot.upsert({
      where: { serverId_snapshotDate: { serverId: server.id, snapshotDate: toDate(isoDate) } },
      create: {
        serverId: server.id,
        snapshotDate: toDate(isoDate),
        minimumPower: minimumPower(),
        sourceUrl: url,
        status,
        lordCount: players.length,
        allianceCount: alliances.length,
      },
      update: {
        minimumPower: minimumPower(),
        sourceUrl: url,
        status,
        lordCount: players.length,
        allianceCount: alliances.length,
      },
    });

    await tx.allianceSnapshot.deleteMany({ where: { snapshotId: snapshot.id } });
    await tx.lordSnapshot.deleteMany({ where: { snapshotId: snapshot.id } });

    const allianceIds = new Map();
    for (const entity of alliances) {
      const row = await tx.alliance.upsert({
        where: { serverId_name: { serverId: server.id, name: entity.name } },
        create: { serverId: server.id, name: entity.name },
        update: { name: entity.name },
      });
      allianceIds.set(entity.name, row.id);
    }

    const wantedSourceIds = players.map((p) => BigInt(p.id));
    const existing = await tx.lord.findMany({
      where: { serverId: server.id, sourceId: { in: wantedSourceIds } },
      select: { id: true, sourceId: true, name: true },
    });
    const lordIds = new Map(existing.map((row) => [row.sourceId.toString(), row.id]));
    const known = new Map(existing.map((row) => [row.sourceId.toString(), row.name]));

    const fresh = players.filter((p) => !lordIds.has(p.id));
    if (fresh.length) {
      await tx.lord.createMany({
        data: fresh.map((p) => ({ serverId: server.id, sourceId: BigInt(p.id), name: p.name })),
        skipDuplicates: true,
      });
      const created = await tx.lord.findMany({
        where: { serverId: server.id, sourceId: { in: fresh.map((p) => BigInt(p.id)) } },
        select: { id: true, sourceId: true },
      });
      created.forEach((row) => lordIds.set(row.sourceId.toString(), row.id));
    }

    // Only touch names that actually changed; a rename is a real signal.
    for (const p of players) {
      const previous = known.get(p.id);
      if (previous !== undefined && previous !== p.name) {
        await tx.lord.update({ where: { id: lordIds.get(p.id) }, data: { name: p.name } });
      }
    }

    if (alliances.length) {
      await tx.allianceSnapshot.createMany({
        data: alliances.map((entity, i) => ({
          snapshotId: snapshot.id,
          allianceId: allianceIds.get(entity.name),
          power: toBigIntStat(entity.stats?.Power),
          memberCount: toIntStat(entity.stats?.Members),
          rank: entity.rank ?? i + 1,
        })),
      });
    }

    if (players.length) {
      await tx.lordSnapshot.createMany({
        data: players.map((entity, i) => ({
          snapshotId: snapshot.id,
          lordId: lordIds.get(entity.id),
          allianceId: entity.allianceId ? allianceIds.get(entity.allianceId) ?? null : null,
          power: toBigIntStat(entity.stats?.Power),
          rank: entity.rank ?? i + 1,
        })),
      });
    }

    return snapshot;
  });
}

/** Keeps extraction order: the source already renders rows power-ranked. */
function rankInOrder(list) {
  list.forEach((entity, i) => {
    if (!entity.rank) entity.rank = i + 1;
  });
  return list;
}

let discovery = { at: 0, dates: null };
let running = false;

function discoveryFresh() {
  return discovery.dates && Date.now() - discovery.at < DISCOVERY_TTL_MS;
}

/**
 * Whether a run has work that requires touching the source.
 *
 * When the date list is already known and every eligible date is stored and
 * current, a sync should do nothing at all - no Chromium launch, no request.
 * Keys off the age of the newest snapshot rather than today's calendar date,
 * because the source's own latest date is not guaranteed to be today.
 */
function planWork(cachedDates, existing) {
  const haveDates = Array.isArray(cachedDates) && cachedDates.length > 0;
  return {
    haveDates,
    needLatest: !haveDates || isStale(existing),
    needBackfill:
      haveDates && cachedDates.slice(-BACKFILL_LIMIT).some((iso) => !existing.has(iso)),
  };
}

async function runSync({ reason = 'manual', batchSize } = {}) {
  if (running) return { skipped: true, reason: 'already_running' };
  running = true;

  const started = Date.now();
  try {
    const server = await ensureServer();
    const existing = await loadExisting(server);
    const limit = Number.isFinite(batchSize) ? batchSize : BACKFILL_BATCH;

    const cachedDates = discoveryFresh() ? discovery.dates || [] : null;
    const plan = planWork(cachedDates, existing);

    if (!plan.needLatest && !plan.needBackfill) {
      const summary = {
        skipped: false,
        reason,
        server: server.serverNumber,
        discoveredDates: cachedDates.length,
        savedDates: [],
        missingBefore: existing.size,
        durationMs: Date.now() - started,
        upToDate: true,
      };
      console.log('[ROSTER] sync', JSON.stringify(summary));
      return summary;
    }

    const outcome = await withAuthedPage(async (page) => {
      const targets = [];
      let dates = cachedDates;
      let latest = null;

      if (plan.needLatest) {
        const url = serverUrl();
        await open(page, url);
        if (isLoginPage(page)) {
          throw credentialError('Redirected to the login page before any data was read.');
        }
        const state = await page.evaluate(readDateState);
        const extracted = await page.evaluate(extractEntities, { allianceId: null });

        dates = state.available;
        discovery = { at: Date.now(), dates };

        const iso = state.active || dates?.[dates.length - 1] || todayIso();
        latest = {
          iso,
          url,
          alliances: rankInOrder(extracted.alliances),
          players: rankInOrder(extracted.players),
          status: state.active ? 'COMPLETE' : 'UNVERIFIED_DATE',
          meta: extracted.meta,
        };
      }

      const known = dates || [];
      if (!known.length && !latest) {
        throw new Error('The source offered no dates to backfill from.');
      }

      const eligible = known.slice(-BACKFILL_LIMIT);
      const missing = eligible.filter((iso) => !existing.has(iso) && (!latest || iso !== latest.iso));
      const backfill = missing.slice(0, Math.max(0, limit));

      for (const iso of backfill) {
        const url = serverUrl({ date: iso });
        await open(page, url);
        if (isLoginPage(page)) {
          throw credentialError('The session lapsed while backfilling.');
        }
        const state = await page.evaluate(readDateState);
        const extracted = await page.evaluate(extractEntities, { allianceId: null });
        const empty = !extracted.alliances.length && !extracted.players.length;
        targets.push({
          iso,
          url,
          alliances: rankInOrder(extracted.alliances),
          players: rankInOrder(extracted.players),
          status: empty ? 'COMPLETE' : state.active && state.active !== iso ? 'UNVERIFIED_DATE' : 'COMPLETE',
          meta: extracted.meta,
          empty,
        });
      }

      return { latest, backfill: targets, discovered: known.length };
    });

    const saved = [];
    if (outcome.latest) saved.push(outcome.latest);
    saved.push(...outcome.backfill);

    for (const entry of saved.sort((a, b) => (a.iso < b.iso ? -1 : 1))) {
      if (!entry.alliances.length && !entry.players.length) continue;
      await saveSnapshot({
        server,
        isoDate: entry.iso,
        status: entry.status,
        url: entry.url,
        alliances: entry.alliances,
        players: entry.players,
      });
    }

    const summary = {
      skipped: false,
      reason,
      server: server.serverNumber,
      discoveredDates: outcome.discovered,
      savedDates: saved.map((s) => s.iso),
      missingBefore: existing.size,
      durationMs: Date.now() - started,
      upToDate: saved.length === 0,
    };
    console.log('[ROSTER] sync', JSON.stringify(summary));
    return summary;
  } catch (err) {
    const code = err.code || 'SYNC_FAILED';
    console.warn(`[ROSTER] sync failed (${code}): ${err.message}`);
    return {
      skipped: false,
      reason,
      error: code,
      detail: err.message,
      durationMs: Date.now() - started,
    };
  } finally {
    running = false;
  }
}

function isStale(existing) {
  if (!existing.size) return true;
  const newest = [...existing.values()].sort((a, b) => b - a)[0];
  return Date.now() - new Date(newest).getTime() >= REFRESH_MS;
}

async function getSyncState() {
  try {
    const server = await ensureServer();
    const existing = await loadExisting(server);
    const dates = [...existing.keys()].sort();
    return {
      running,
      server: server.serverNumber,
      snapshots: existing.size,
      oldest: dates[0] || null,
      newest: dates[dates.length - 1] || null,
    };
  } catch (err) {
    return { running, error: err.message };
  }
}

/** Boot-time helper: schedules the periodic background sync. */
function startSyncScheduler() {
  if (envFlag('ROSTER_SYNC_DISABLED')) {
    console.log('[ROSTER] Background sync disabled by ROSTER_SYNC_DISABLED.');
    return null;
  }
  // eslint-disable-next-line global-require
  const cron = require('node-cron');
  const expression = process.env.ROSTER_SYNC_CRON || '23 * * * *';
  if (!cron.validate(expression)) {
    console.warn(`[ROSTER] Invalid ROSTER_SYNC_CRON "${expression}", sync not scheduled.`);
    return null;
  }

  const schedule = () =>
    runSync({ reason: 'cron' }).catch((err) => console.warn('[ROSTER] cron sync:', err.message));

  cron.schedule(expression, schedule);
  console.log(`[ROSTER] Background sync scheduled: "${expression}"`);

  // Fill the database as soon as the process is up, but staggered so a redeploy
  // does not race the healthcheck.
  const initialDelay = envInt('ROSTER_SYNC_INITIAL_DELAY_MS', 15000);
  if (initialDelay > 0) setTimeout(schedule, initialDelay).unref?.();
  return true;
}

module.exports = {
  runSync,
  startSyncScheduler,
  getSyncState,
  saveSnapshot,
  ensureServer,
  planWork,
  toBigIntStat,
};
