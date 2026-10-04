const prisma = require('../db');
const { withAuthedPage, BASE } = require('./session');
const { open, isLoginPage } = require('./v1');

/**
 * Fills in player avatars that the roster page did not supply.
 *
 * The main ingest reads whatever the server page renders for free. When a
 * player's picture only exists on their own detail page, walking every player
 * would multiply page loads by the population of the server - so instead this
 * job peels off a small, bounded number per run and stops.
 *
 * The avatar is written to every snapshot row for that player that is still
 * missing one. The source only exposes a player's current picture, so there is
 * no historical value to preserve; writing it across dates costs no extra page
 * loads, and a genuine per-date value read by the ingest always wins because
 * those rows are never null.
 */

function envInt(name, fallback) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function batchLimit() {
  return envInt('ROSTER_AVATAR_BATCH', 25);
}

function lordUrl(sourceId) {
  return new URL(`/lord/${sourceId}`, BASE).toString();
}

/**
 * Runs inside the browser on a player's detail page.
 *
 * `.profile-picture` is the element we were told about, so it is checked
 * first; a generic avatar image is accepted as a fallback. Anything that looks
 * like site chrome (logo, discord, flags) is rejected rather than stored as if
 * it were a player.
 */
function readLordAvatar() {
  const absolute = (value) => {
    try {
      return new URL(value, location.href).toString();
    } catch {
      return value;
    }
  };

  const from = (el) => {
    if (!el) return null;
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    const src = img && (img.getAttribute('src') || img.getAttribute('data-src'));
    if (src && !/logo|discord|flag/i.test(src)) return absolute(src);

    const style = getComputedStyle(el).backgroundImage || '';
    const match = style.match(/url\((['"]?)(.*?)\1\)/);
    if (match && match[2] && !/logo|discord|flag/i.test(match[2])) return absolute(match[2]);
    return null;
  };

  return (
    from(document.querySelector('.profile-picture')) ||
    from(document.querySelector('img[class*="avatar"]')) ||
    null
  );
}

let running = false;

/** Players on the newest snapshot that still have no picture. */
async function missingAvatars(limit) {
  const latest = await prisma.rosterSnapshot.findFirst({
    orderBy: { snapshotDate: 'desc' },
    select: { id: true, snapshotDate: true },
  });
  if (!latest) return { snapshot: null, rows: [] };

  const rows = await prisma.lordSnapshot.findMany({
    where: { snapshotId: latest.id, avatarUrl: null },
    select: { lordId: true, lord: { select: { sourceId: true, name: true } } },
    orderBy: { rank: 'asc' },
    take: limit,
  });

  return {
    snapshot: {
      date: new Date(latest.snapshotDate).toISOString().slice(0, 10),
    },
    rows,
  };
}

async function fillMissingAvatars({ reason = 'manual' } = {}) {
  if (envFlag('ROSTER_AVATAR_DISABLED')) return { skipped: true, reason: 'disabled' };
  if (running) return { skipped: true, reason: 'already_running' };
  running = true;

  const started = Date.now();
  try {
    const limit = batchLimit();
    const pending = await missingAvatars(limit);
    if (!pending.rows.length) {
      return { skipped: false, reason, upToDate: true, durationMs: Date.now() - started };
    }

    const outcome = await withAuthedPage(async (page) => {
      const filled = [];
      const stillMissing = [];

      for (const row of pending.rows) {
        const sourceId = row.lord.sourceId.toString();
        try {
          await open(page, lordUrl(sourceId));
          if (isLoginPage(page)) {
            const err = new Error('The session lapsed while reading a player page.');
            err.code = 'BAD_CREDENTIALS';
            throw err;
          }
          const avatar = await page.evaluate(readLordAvatar);
          if (avatar) {
            // Every snapshot for this player, but never one the ingest already
            // populated with a genuine per-date value.
            await prisma.lordSnapshot.updateMany({
              where: { lordId: row.lordId, avatarUrl: null },
              data: { avatarUrl: avatar },
            });
            filled.push(sourceId);
          } else {
            stillMissing.push(sourceId);
          }
        } catch (err) {
          if (err.code === 'BAD_CREDENTIALS') throw err;
          // One broken player page must not stop the batch.
          stillMissing.push(sourceId);
        }
      }

      return { filled, stillMissing };
    });

    const summary = {
      skipped: false,
      reason,
      snapshot: pending.snapshot,
      attempted: pending.rows.length,
      filled: outcome.filled.length,
      noAvatarFound: outcome.stillMissing.length,
      durationMs: Date.now() - started,
    };
    console.log('[ROSTER] avatars', JSON.stringify(summary));
    return summary;
  } catch (err) {
    const code = err.code || 'AVATAR_FAILED';
    console.warn(`[ROSTER] avatar job failed (${code}): ${err.message}`);
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

async function getAvatarState() {
  try {
    const latest = await prisma.rosterSnapshot.findFirst({
      orderBy: { snapshotDate: 'desc' },
      select: { id: true, lordCount: true, snapshotDate: true },
    });
    if (!latest) return { running, snapshot: null, missing: 0, filled: 0, total: 0 };

    const missing = await prisma.lordSnapshot.count({
      where: { snapshotId: latest.id, avatarUrl: null },
    });
    return {
      running,
      snapshot: new Date(latest.snapshotDate).toISOString().slice(0, 10),
      missing,
      filled: Math.max(0, latest.lordCount - missing),
      total: latest.lordCount,
    };
  } catch (err) {
    return { running, error: err.message };
  }
}

module.exports = { fillMissingAvatars, getAvatarState };
