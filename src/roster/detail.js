const prisma = require('../db');
const { BASE, withAuthedPage, rotateCredentials, accountCount, refreshSessionIfNeeded } = require('./session');
const { fetchHtml, cookieHeader, looksLikeLogin } = require('./http');
const { withParser } = require('./parse');
const extract = require('./extract');
const v1 = require('./v1');
const {
  SUBJECT,
  saveSubjectMetrics,
  saveAchievements,
  saveNameHistory,
  parseAchievementCompletion,
} = require('./metrics');
const { historyEnabled, scopeLabel } = require('./scope');

/**
 * Detail backfill: every field the source shows, not just the roster columns.
 *
 * The roster crawl reads alliances and members off /server/{id} in one page
 * per date. Everything else - server totals, alliance war stats, a player's
 * own stats, achievements and name history - lives on the other two page
 * types.
 *
 * How far to go differs by subject, because so does what it costs:
 *
 *   server + alliance   every date on the run's list. Two pages per alliance
 *                       per date, so a local history run stays affordable and
 *                       the trends are worth having.
 *   players             newest date only. It is ~300 pages per date, which
 *                       over a month is the overwhelming majority of the
 *                       requests, and the roster the site displays is the
 *                       newest one. Older dates keep their rank and power,
 *                       which is what the roster view shows for them.
 *
 * At the default pace that is roughly 1,000 requests rather than 9,450, which
 * matters because the source rate-limits: it invalidates the session of an
 * account it decides is scraping too hard and eventually refuses it outright.
 *
 * Which dates the pass looks at is the ROSTER_HISTORY switch (./scope.js).
 * Off - the deployed default - it takes the newest snapshot only, for every
 * subject, and stops. On, it walks back through the stored dates in batches of
 * SNAPSHOTS_PER_RUN. Server and alliance detail follow whichever list that
 * produces, so filling in history is a matter of running this pass locally
 * with the switch on rather than the deployed bot working backward forever.
 *
 * Three rules keep the run tractable:
 *
 *  1. Fetch with plain HTTP and parse in one reused browser (see http.js and
 *     parse.js). Pages are server-rendered, so a navigation buys nothing.
 *  2. Record completion per subject in `scannedAt` and resume from it. A run
 *     that hits its budget stops; the next one continues where it stopped
 *     rather than starting the date over.
 *  3. Stop on a wall-clock budget instead of a page count, so a slow or
 *     degraded source costs less of the run rather than more.
 *
 * Historical dates are immutable once written, so only the newest snapshot is
 * ever refreshed - and only after ROSTER_DETAIL_REFRESH_MS, because the roster
 * itself is rewritten hourly and would otherwise pay for a full detail pass
 * every time its ranks shifted.
 */

const DEFAULT_BUDGET_MS = 600000;
/**
 * The source answers a burst of requests by invalidating the session and, for
 * an account that keeps going, by refusing it altogether. Pacing is therefore
 * a correctness requirement rather than a politeness setting: the gap is the
 * interval between request *starts*, enforced across every concurrent worker,
 * so the whole run reads at a fixed rate no matter how much is in flight.
 *
 * Measured, not guessed: at 500 ms the source served 13 pages and then
 * answered every later request - for all three configured accounts, and even
 * for a browser freshly logged in by hand - with a 303 to /. Public endpoints
 * kept working, so it is the application refusing data pages, not Cloudflare.
 * The defaults are therefore deliberately slow, and are worth raising only
 * once a backfill has run through without tripping it.
 */
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_CHUNK = 12;
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;
/**
 * How long to stay quiet after a run gives up.
 *
 * Re-running immediately would just re-issue the requests that were refused,
 * which teaches the source nothing and keeps the refusal in place for longer.
 */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
/**
 * How many accounts one refusal may cycle through.
 *
 * With a long account list the ladder below would otherwise launch a Chromium
 * login per account - over a dozen on a single refused run, every hour - for
 * a refusal that a couple of accounts is already enough to diagnose.
 */
const DEFAULT_MAX_ROTATIONS = 3;
const SNAPSHOTS_PER_RUN = 30;

function envInt(name, fallback, minimum = 1) {
  const parsed = parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function disabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ROSTER_DETAIL_DISABLED || ''));
}

const budgetMs = () => envInt('ROSTER_DETAIL_BUDGET_MS', DEFAULT_BUDGET_MS, 1000);
const concurrency = () => envInt('ROSTER_DETAIL_CONCURRENCY', DEFAULT_CONCURRENCY);
const delayMs = () => envInt('ROSTER_DETAIL_DELAY_MS', DEFAULT_DELAY_MS, 0);
const chunkSize = () => envInt('ROSTER_DETAIL_CHUNK', DEFAULT_CHUNK);
const refreshMs = () => envInt('ROSTER_DETAIL_REFRESH_MS', DEFAULT_REFRESH_MS, 60000);
const cooldownMs = () => envInt('ROSTER_DETAIL_COOLDOWN_MS', DEFAULT_COOLDOWN_MS, 0);
const maxRotations = () =>
  Math.min(accountCount() - 1, envInt('ROSTER_DETAIL_MAX_ROTATIONS', DEFAULT_MAX_ROTATIONS, 0));

/**
 * Whether player detail covers every date or only the newest.
 *
 * Default is `latest`: players are ~300 pages per date, so they are the whole
 * cost of a full-history pass, and the roster the site displays is the newest
 * date. `ROSTER_DETAIL_PLAYERS=all` restores the exhaustive pass for whoever
 * wants it and accepts the extra hours of fetching.
 */
function playerDepth() {
  return /^(all|every|full)$/i.test(String(process.env.ROSTER_DETAIL_PLAYERS || ''))
    ? 'all'
    : 'latest';
}

function queryDate(isoDate) {
  const url = new URL(`/server/${v1.serverId()}`, BASE);
  url.searchParams.set('minimum_power', '0');
  if (isoDate) url.searchParams.set('selected_date', isoDate);
  return url.toString();
}

function allianceUrl(sourceId, isoDate) {
  const url = new URL(`/alliance/${sourceId}`, BASE);
  url.searchParams.set('minimum_power', '0');
  if (isoDate) url.searchParams.set('selected_date', isoDate);
  return url.toString();
}

function lordUrl(sourceId, isoDate) {
  const url = new URL(`/lord/${sourceId}`, BASE);
  url.searchParams.set('minimum_power', '0');
  if (isoDate) url.searchParams.set('selected_date', isoDate);
  return url.toString();
}

// ---------------------------------------------------------------- session --

let cachedCookie;
let session = { valid: true };
/**
 * Shared across a run: a re-login and an account switch are decisions to make
 * once, not once per failing page, and concurrent workers must not each start
 * their own login.
 */
let attempts = { reauthed: false, rotations: 0 };
let reauthInFlight = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Holds requests apart by at least `ROSTER_DETAIL_DELAY_MS`.
 *
 * A shared deadline rather than a per-request sleep, so workers cannot run
 * ahead of it: the rate stays fixed however much is in flight, which is what
 * keeps the source from treating the run as an abusive burst.
 *
 * The gap is a floor, not a metronome. An identical interval, run after run,
 * is a machine signature of its own - so up to half the gap is added at
 * random, which keeps the configured rate as the slowest possible pace while
 * the cadence reads like someone pausing between pages.
 */
let nextStart = 0;

function nextGap(gap) {
  return gap + Math.floor(Math.random() * gap * 0.5);
}

async function pace() {
  const gap = delayMs();
  if (gap <= 0) return;
  const now = Date.now();
  const start = Math.max(now, nextStart);
  nextStart = start + nextGap(gap);
  if (start > now) await sleep(start - now);
}

async function currentCookie() {
  if (cachedCookie === undefined) cachedCookie = await cookieHeader();
  return cachedCookie;
}

/**
 * Re-runs the browser login path and takes the new cookies.
 *
 * `withAuthedPage` already decides whether a login is needed and persists the
 * result, so this only has to ask it to do that and re-read the cookies the
 * HTTP client will send.
 */
async function reauthenticate() {
  if (reauthInFlight) return reauthInFlight;
  reauthInFlight = (async () => {
    await withAuthedPage(async () => true);
    cachedCookie = await cookieHeader();
  })().finally(() => {
    reauthInFlight = null;
  });
  return reauthInFlight;
}

function isAuthFailure(res) {
  // A challenge is its own kind of failure: not content (an interstitial
  // parses as an empty page) and not proof the account is refused - it is
  // usually the clearance cookie that lapsed, which a renewal repairs.
  return Boolean(res.authExpired || res.challenge || (res.ok && looksLikeLogin(res.html)));
}

/**
 * Gets the session working again after a refused request.
 *
 * The first refusal is usually a session that simply aged out, so re-login
 * once with the account in use. Coming straight back means the account itself
 * is being refused - the state a heavily-scraped account ends up in - so move
 * to the next configured account rather than repeating credentials that are
 * already being turned away. With nowhere left to move, the run stops instead
 * of hammering a source that is saying no.
 *
 * Both steps log what they saw, because they answer different questions:
 * "renewal fixed it" means a cookie problem, "still refused after renewal"
 * means the account is blocked and the rotation was right.
 */
async function recover(url, res) {
  if (!attempts.reauthed) {
    attempts.reauthed = true;
    console.warn(
      `[ROSTER] Detail read refused: status=${res.status} challenge=${Boolean(res.challenge)} ` +
        `authExpired=${Boolean(res.authExpired)} url=${res.url}; renewing the session.`,
    );
    await reauthenticate();
    const retry = await fetchHtml(url, { cookie: await currentCookie() });
    if (!isAuthFailure(retry)) {
      console.log('[ROSTER] The renewed session works; the earlier failure was the session, not the account.');
      return retry;
    }
  }

  if (attempts.rotations < maxRotations()) {
    attempts.rotations += 1;
    console.warn(
      `[ROSTER] Still refused after a renewal; switching to the next account (rotation ${attempts.rotations} of ${maxRotations()}).`,
    );
    rotateCredentials();
    await reauthenticate();
    const retry = await fetchHtml(url, { cookie: await currentCookie() });
    if (!isAuthFailure(retry)) return retry;
  }

  session.valid = false;
  return { ok: false, status: 0, authExpired: true, challenge: false, html: '', url };
}

async function getPage(url) {
  await pace();
  const res = await fetchHtml(url, { cookie: await currentCookie() });
  if (isAuthFailure(res)) return recover(url, res);
  return res;
}

// ------------------------------------------------------------------ pool ---

/** Runs `worker` over `items` with at most `limit` in flight. */
async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Runs readers over one document.
 *
 * Sequential on purpose: every reader installs the same HTML into the same
 * page, and overlapping setContent calls would evict each other's document
 * mid-evaluate.
 */
async function parseAll(parser, html, readers) {
  const out = [];
  for (const reader of readers) out.push(await parser.parse(html, reader));
  return out;
}

// ------------------------------------------------------------------ run ---

let state = {
  running: false,
  reason: null,
  startedAt: null,
  finishedAt: null,
  stats: null,
  error: null,
};
/**
 * Until when the source should be left alone after it refused us.
 *
 * In-memory on purpose: the block is a property of this process's traffic, and
 * a restart should be allowed to try again rather than inherit a penalty.
 */
let cooldownUntil = 0;

/**
 * Whether this run may start.
 *
 * A scheduled run waits out the cooldown, because re-issuing the requests that
 * were just refused gains nothing and keeps the refusal in place. A run
 * somebody asked for by hand does not: pressing the button is the request.
 */
function allowedToRun(reason) {
  const now = Date.now();
  if (now >= cooldownUntil) return true;
  if (reason === 'cron') {
    console.log(
      `[ROSTER] The source is still refusing us; waiting ${Math.ceil((cooldownUntil - now) / 60000)} more minute(s).`,
    );
    return false;
  }
  return true;
}

function getDetailState() {
  return {
    ...state,
    scope: scopeLabel(),
    budgetMs: budgetMs(),
    refreshMs: refreshMs(),
    cooldownMs: cooldownMs(),
    cooldownUntil: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
    disabled: disabled(),
    playerDepth: playerDepth(),
    delayMs: delayMs(),
    accounts: accountCount(),
    sessionValid: session.valid,
  };
}

/** Newest snapshot first: the date the site actually displays gets done first. */
async function pendingSnapshots(server, targetDate = null) {
  if (targetDate) {
    return prisma.rosterSnapshot.findMany({
      where: { serverId: server.id, status: 'COMPLETE', snapshotDate: new Date(`${targetDate}T00:00:00.000Z`) },
      select: { id: true, snapshotDate: true, scannedAt: true },
    });
  }
  return prisma.rosterSnapshot.findMany({
    where: { serverId: server.id, status: 'COMPLETE' },
    orderBy: { snapshotDate: 'desc' },
    // Latest-only runs exist to keep the current date current. Older dates are
    // collected by a history run, which asks for a batch of them instead.
    take: historyEnabled() ? SNAPSHOTS_PER_RUN : 1,
    select: { id: true, snapshotDate: true, scannedAt: true },
  });
}

function toIso(date) {
  return date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
}

/**
 * Clears completion markers on the newest snapshot once they are old enough.
 *
 * Historical dates never change, so their markers stay forever; only the
 * latest one is worth re-reading, and only at this interval - otherwise the
 * hourly roster refresh would pay for a full detail pass every hour.
 */
async function maybeRefreshLatest(server) {
  const latest = await prisma.rosterSnapshot.findFirst({
    where: { serverId: server.id, status: 'COMPLETE' },
    orderBy: { snapshotDate: 'desc' },
    select: { id: true },
  });
  if (!latest) return false;

  const newest = await prisma.lordSnapshot.aggregate({
    where: { snapshotId: latest.id, scannedAt: { not: null } },
    _max: { scannedAt: true },
  });
  const stamp = newest._max.scannedAt;
  if (stamp && Date.now() - stamp.getTime() < refreshMs()) return false;

  await prisma.lordSnapshot.updateMany({
    where: { snapshotId: latest.id, scannedAt: { not: null } },
    data: { scannedAt: null },
  });
  await prisma.allianceSnapshot.updateMany({
    where: { snapshotId: latest.id, scannedAt: { not: null } },
    data: { scannedAt: null },
  });
  await prisma.rosterSnapshot.update({ where: { id: latest.id }, data: { scannedAt: null } });
  return true;
}

function canContinue(deadline) {
  return session.valid && Date.now() < deadline;
}

async function detailServer(snapshot, parser, deadline, counters) {
  if (snapshot.scannedAt || !canContinue(deadline)) return;

  const page = await getPage(queryDate(toIso(snapshot.snapshotDate)));
  if (!page.ok) return;
  counters.pages += 1;

  const rows = await parser.parse(page.html, extract.readStatSections);
  if (!rows || !rows.length) return;

  await saveSubjectMetrics(snapshot.id, SUBJECT.SERVER, '', rows);
  await prisma.rosterSnapshot.update({ where: { id: snapshot.id }, data: { scannedAt: new Date() } });
  counters.server += 1;
}

/**
 * Whether a write failed because a concurrent re-ingest replaced its rows.
 *
 * `saveSnapshot` replaces a date's rows outright - new ids, with `scannedAt`,
 * avatars and achievement lists carried over - and a second writer exists:
 * the deployed bot re-ingests the newest date hourly while this pass may
 * still hold ids read at its start. The carry-over means whatever this write
 * was about to record is already on the new rows, so skipping the item loses
 * nothing. Letting the error escape - which is what happened - costs the
 * whole pass and every date queued behind it: P2003 is the achievements
 * insert finding its parent gone, P2025 the scan-mark update on that same
 * missing row.
 */
function replacedConcurrently(err) {
  return Boolean(err) && (err.code === 'P2003' || err.code === 'P2025');
}

/**
 * Alliance pages are matched back to ours by membership, not by name.
 *
 * The search endpoint keys on alliance name, which is unique inside a server
 * but not across them. A page whose members are not in this snapshot's roster
 * is the same-named alliance on some other server, and storing its war stats
 * under ours would be wrong in a way no later query could detect.
 */
async function detailAlliances(snapshot, parser, deadline, counters, ourLords, ids) {
  const pending = await prisma.allianceSnapshot.findMany({
    where: { snapshotId: snapshot.id, scannedAt: null },
    include: { alliance: { select: { id: true, name: true } } },
    orderBy: { rank: 'asc' },
  });
  if (!pending.length) return;

  const missing = pending.filter((row) => !ids.has(row.alliance.name));
  if (missing.length) {
    const resolved = await extract.resolveAllianceIds(missing.map((row) => row.alliance.name));
    resolved.forEach((candidates, name) => ids.set(name, candidates));
  }

  const targets = pending.filter((row) => (ids.get(row.alliance.name) || []).length);
  counters.unresolved += pending.length - targets.length;

  let replacedWarned = false;
  for (let i = 0; i < targets.length; i += chunkSize()) {
    if (!canContinue(deadline)) return;
    const chunk = targets.slice(i, i + chunkSize());

    // Fetching overlaps; parsing does not, so the two happen in separate
    // phases - the pool only ever performs network work.
    const fetched = await mapPool(chunk, concurrency(), async (row) => {
      const candidates = ids.get(row.alliance.name) || [];
      for (const candidate of candidates) {
        const page = await getPage(allianceUrl(candidate, toIso(snapshot.snapshotDate)));
        if (!page.ok) return { row, page: null, sourceId: candidate };

        const members = await parser.parse(page.html, extract.readMemberIds);
        const overlap = (members || []).filter((id) => ourLords.has(id)).length;
        if (overlap > 0) return { row, page, sourceId: candidate };
        // Wrong server: try the next same-named candidate rather than
        // recording someone else's alliance as ours.
      }
      return { row, page: null };
    });

    for (const item of fetched) {
      if (!item || !item.page || !item.page.ok || !canContinue(deadline)) continue;
      counters.pages += 1;

      const rows = await parser.parse(item.page.html, extract.readStatSections);
      if (!rows || !rows.length) continue;

      try {
        await saveSubjectMetrics(snapshot.id, SUBJECT.ALLIANCE, item.row.alliance.id, rows);
        await prisma.allianceSnapshot.update({ where: { id: item.row.id }, data: { scannedAt: new Date() } });
      } catch (err) {
        if (!replacedConcurrently(err)) throw err;
        if (!replacedWarned) {
          replacedWarned = true;
          console.log(
            "[ROSTER] A concurrent sync replaced this date's rows mid-pass; the new rows already carry the old data, so this pass continues.",
          );
        }
        continue;
      }
      counters.alliances += 1;
    }
  }
}

/**
 * The player pass: stats, achievements, previous names and the picture.
 *
 * All four come from one page, so a player whose fetch or parse fails simply
 * stays marked as pending and is picked up by the next run.
 */
async function detailLords(snapshot, parser, deadline, counters) {
  const targets = await prisma.lordSnapshot.findMany({
    where: { snapshotId: snapshot.id, scannedAt: null },
    select: { id: true, lordId: true, lord: { select: { sourceId: true } } },
    orderBy: { rank: 'asc' },
  });
  if (!targets.length) return;

  let replacedWarned = false;
  for (let i = 0; i < targets.length; i += chunkSize()) {
    if (!canContinue(deadline)) return;
    const chunk = targets.slice(i, i + chunkSize());

    const fetched = await mapPool(chunk, concurrency(), async (target) => {
      const page = await getPage(lordUrl(target.lord.sourceId.toString(), toIso(snapshot.snapshotDate)));
      return { target, page: page.ok ? page.html : null };
    });

    for (const item of fetched) {
      if (!item || !item.page || !canContinue(deadline)) continue;
      counters.pages += 1;

      const [stats, achievements, history, avatar, playstyle] = await parseAll(parser, item.page, [
        extract.readStatSections,
        extract.readAchievements,
        extract.readNameHistory,
        extract.readAvatar,
        extract.readPlaystyle,
      ]);

      try {
        if (stats && stats.length) {
          // Playstyle rides along with the rest so the delete-then-insert keeps
          // the two in step: a page that stopped rendering the hexagon must stop
          // leaving stale percentiles behind.
          await saveSubjectMetrics(snapshot.id, SUBJECT.LORD, item.target.lordId, [
            ...stats,
            ...(playstyle || []),
          ]);
        }
        if (achievements && achievements.length) {
          await saveAchievements(
            item.target.id,
            achievements.map((row) => ({
              name: row.name,
              progress: row.progressText,
              ...parseAchievementCompletion(row.completedText),
            })),
          );
        }
        if (history && history.length) {
          await saveNameHistory(item.target.lordId, history);
        }

        const now = new Date();
        await prisma.lordSnapshot.update({
          where: { id: item.target.id },
          data: { scannedAt: now, ...(avatar ? { avatarUrl: avatar } : {}) },
        });
      } catch (err) {
        if (!replacedConcurrently(err)) throw err;
        if (!replacedWarned) {
          replacedWarned = true;
          console.log(
            "[ROSTER] A concurrent sync replaced this date's rows mid-pass; the new rows already carry the old data, so this pass continues.",
          );
        }
        continue;
      }
      counters.lords += 1;
    }
  }
}

/**
 * Fills in detail for snapshots that are still missing it.
 *
 * Exported for the scheduler and for /sync's manual trigger. The single-run
 * lock mirrors runSync: two triggers arriving together should share one pass
 * rather than fetch the same pages twice.
 */
let detailRunning = false;

async function runDetail({ reason = 'manual', targetDate } = {}) {
  if (disabled()) return { skipped: 'disabled', ...getDetailState() };
  if (detailRunning) return { skipped: 'already_running', ...getDetailState() };
  if (!allowedToRun(reason)) return { skipped: 'cooldown', ...getDetailState() };

  detailRunning = true;
  const startedAt = new Date().toISOString();
  session = { valid: true };
  attempts = { reauthed: false, rotations: 0 };
  // Renew on the clock rather than after the first refusal: a lapsed
  // Cloudflare clearance shows up mid-pass as a failed read, and recovering
  // from that walks the account ladder over what is only an expired cookie.
  await refreshSessionIfNeeded('detail pass');
  // Re-read rather than trust the previous run: a login in between may have
  // rotated the session, and the pace deadline must not carry over.
  cachedCookie = undefined;
  nextStart = 0;

  const deadline = Date.now() + budgetMs();
  const counters = {
    pages: 0,
    server: 0,
    alliances: 0,
    lords: 0,
    unresolved: 0,
    dates: 0,
    playerDatesSkipped: 0,
    refreshed: false,
  };

  state = { running: true, reason, startedAt, finishedAt: null, stats: null, error: null };

  try {
    const server = await prisma.sourceServer.findFirst({
      where: { serverNumber: parseInt(v1.serverId(), 10) },
    });
    if (!server) {
      state = { ...state, running: false, finishedAt: new Date().toISOString(), error: 'no_server' };
      return getDetailState();
    }

    if (targetDate) {
      const target = await prisma.rosterSnapshot.findFirst({
        where: {
          serverId: server.id,
          status: 'COMPLETE',
          snapshotDate: new Date(`${targetDate}T00:00:00.000Z`),
        },
        select: { id: true },
      });
      if (!target) throw new Error(`No stored roster snapshot exists for ${targetDate}.`);
      await Promise.all([
        prisma.rosterSnapshot.update({ where: { id: target.id }, data: { scannedAt: null } }),
        prisma.lordSnapshot.updateMany({ where: { snapshotId: target.id }, data: { scannedAt: null } }),
        prisma.allianceSnapshot.updateMany({ where: { snapshotId: target.id }, data: { scannedAt: null } }),
      ]);
    }

    counters.refreshed = targetDate ? false : await maybeRefreshLatest(server);
    const snapshots = await pendingSnapshots(server, targetDate);
    // Ordered newest first, so the head of the list is the date players are
    // detailed for when depth is limited to the newest one. Server and
    // alliance detail runs for every date regardless.
    const newestId = snapshots.length ? snapshots[0].id : null;
    const detailPlayers = playerDepth() === 'all';
    const ids = new Map();
    let stoppedEarly = false;

    await withParser(async (parser) => {
      for (const snapshot of snapshots) {
        if (!canContinue(deadline)) {
          stoppedEarly = true;
          break;
        }

        const rows = await prisma.lordSnapshot.findMany({
          where: { snapshotId: snapshot.id },
          select: { lord: { select: { sourceId: true } } },
        });
        const ourLords = new Set(rows.map((row) => row.lord.sourceId.toString()));

        await detailServer(snapshot, parser, deadline, counters);
        await detailAlliances(snapshot, parser, deadline, counters, ourLords, ids);

        if (detailPlayers || snapshot.id === newestId) {
          await detailLords(snapshot, parser, deadline, counters);
        } else {
          counters.playerDatesSkipped += 1;
        }

        counters.dates += 1;
        if (!session.valid) break;
      }
    });

    if (!session.valid) {
      // Every configured account was refused, so this is not one account going
      // stale - the source has stopped serving us. Back off rather than repeat
      // the same requests on the next scheduled run.
      cooldownUntil = Date.now() + cooldownMs();
      console.log(
        `[ROSTER] The source refused the detail pass; not retrying for ${Math.round(cooldownMs() / 60000)} minute(s).`,
      );
    }

    state = {
      running: false,
      reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      stats: { ...counters, budgetHit: stoppedEarly || Date.now() >= deadline },
      error: session.valid ? null : 'session_expired',
    };
    return getDetailState();
  } catch (err) {
    // A refused login ladder throws rather than clearing `session.valid`, so
    // the back-off above never sees it. Without this the next scheduled run
    // walks every configured account through a browser login again - a dozen
    // logins at the source that has just turned all of them away.
    if (err.code === 'SOURCE_ACCESS_DENIED') {
      cooldownUntil = Date.now() + cooldownMs();
      console.log(
        `[ROSTER] Every configured account was refused; not retrying for ${Math.round(cooldownMs() / 60000)} minute(s).`,
      );
    }
    state = {
      running: false,
      reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      stats: { ...counters },
      error: err.message,
    };
    throw err;
  } finally {
    detailRunning = false;
  }
}

module.exports = { runDetail, getDetailState, budgetMs, refreshMs, playerDepth, disabled };
