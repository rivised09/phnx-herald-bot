const cron = require('node-cron');
const prisma = require('../../db');
const { CONFIG } = require('../../config');
const { msUntil } = require('../../utils/time');
const { sendPing, updateEventMessage, deleteReminderMessage, markReminderEnded } = require('./posting');

/**
 * Reminder scheduler, hardened against the incident where ended events pinged
 * every minute for hours ("Sent 7 hours ping..." x20, then a storm of
 * "Missing Access" retries).
 *
 * The rules that make that impossible now:
 *
 *  1. Claim before sending. The window flag is flipped with an atomic
 *     `UPDATE ... WHERE flag = false`; exactly one process wins it. Two bot
 *     instances (local dev + Render) racing the same window can no longer
 *     both send it - the in-memory cooldown below never protected across
 *     processes, only the database flag does.
 *
 *  2. Bounded retries. A failed send releases the claim so a later tick can
 *     try again, but only MAX_ATTEMPTS times (per process). After that the
 *     window stays claimed and every instance stops. Broken Discord access
 *     produced one attempt per window per minute, forever, because the flag
 *     was only written on success.
 *
 *  3. Nothing fires for an event that has ended, and a window whose moment
 *     passed more than STALE_GRACE_MS ago is closed without posting. Once an
 *     event has started, every earlier window is stale by definition - the
 *     old code treated them all as "due" at once (remainingMs is negative),
 *     which is why a single tick tried all five windows together.
 *
 *  4. Completion runs before pings in the same tick, so an ended event is
 *     removed from the pinging set before anything is considered for it.
 *
 *  5. A send that finds no channel throws instead of returning null: the old
 *     code logged "Sent ... (previous reminder replaced)" while delivering
 *     nothing, and marked the window as sent anyway.
 */
const PING_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const STALE_GRACE_MS = 15 * 60 * 1000;
const STARTING_LATE_GRACE_MS = 15 * 60 * 1000;

/**
 * How late a window may still fire. Normal operation ticks every minute, so
 * this only matters when the bot was down across a threshold or an event was
 * created with very little lead time: a "10 minutes" ping for an event that
 * starts in 2 minutes is worse than no ping, so small windows get a grace of
 * half their own size instead of the full 15 minutes.
 */
function lateGraceFor(windowInfo) {
  if (windowInfo.msBefore === 0) return STARTING_LATE_GRACE_MS;
  return Math.min(STALE_GRACE_MS, windowInfo.msBefore / 2);
}

const lastPinged = new Map(); // `${eventId}:${windowKey}` -> timestamp (this process)
const failedAttempts = new Map(); // `${eventId}:${windowKey}` -> attempts (this process)

async function checkEventPings(client) {
  const now = Date.now();
  const horizon = new Date(now - 24 * 60 * 60 * 1000);

  const upcoming = await prisma.event.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ACTIVE'] },
      startTime: { gte: horizon },
    },
  });

  for (const event of upcoming) {
    const remainingMs = msUntil(event.startTime);
    const ended = Boolean(event.endTime) && new Date(event.endTime).getTime() <= now;
    const staleKeys = [];

    // A started event goes ACTIVE on the clock, not on ping delivery: the
    // status flip used to live only inside the "starting" ping path, so a
    // failed or disabled ping left the card saying "Scheduled" all event.
    if (event.status === 'SCHEDULED' && remainingMs <= 0 && !ended) {
      const activation = await prisma.event.updateMany({
        where: { id: event.id, status: 'SCHEDULED' },
        data: { status: 'ACTIVE' },
      });
      if (activation.count === 1) {
        await updateEventMessage(client, { ...event, status: 'ACTIVE' }).catch((err) => {
          console.error(`[PINGS] Event "${event.title}" activated but its message was not updated:`, err.message);
        });
        console.log(`[PINGS] Event "${event.title}" started - status set to ACTIVE.`);
      }
    }

    for (const windowInfo of CONFIG.BEHAVIOR.PING_WINDOWS) {
      if (event[windowInfo.key]) continue;
      if (ended) {
        // The event is over; completion will handle the row. Close the
        // windows so nothing can fire even if completion fails.
        staleKeys.push(windowInfo.key);
        continue;
      }
      if (remainingMs > windowInfo.msBefore) continue; // not due yet
      if (remainingMs < windowInfo.msBefore - lateGraceFor(windowInfo)) {
        // The moment passed long ago (event started, or this bot was down).
        // A late "7 hours" ping is noise; close it without posting.
        staleKeys.push(windowInfo.key);
        continue;
      }

      const cooldownKey = `${event.id}:${windowInfo.key}`;
      const last = lastPinged.get(cooldownKey);
      if (last !== undefined && now - last < PING_COOLDOWN_MS) continue;
      lastPinged.set(cooldownKey, now);

      // Atomic claim: exactly one process flips false -> true for this window.
      const claim = await prisma.event.updateMany({
        where: { id: event.id, [windowInfo.key]: false },
        data: { [windowInfo.key]: true },
      });
      if (claim.count !== 1) continue; // another instance already owns it

      try {
        await deleteReminderMessage(client, event.reminderMessageId);
        const message = await sendPing(client, event, windowInfo.label);
        if (!message) throw new Error('ping channel unavailable');

        const data = { reminderMessageId: message.id };
        if (windowInfo.key === 'pingStarted' && event.status === 'SCHEDULED') {
          data.status = 'ACTIVE';
        }
        const updated = await prisma.event.update({ where: { id: event.id }, data });

        // Follow-ups are best-effort: a failed embed edit must never resend
        // the ping that was just delivered.
        await updateEventMessage(client, updated, {
          pingNote: windowInfo.key === 'pingStarted' ? null : `Starts in ${windowInfo.label}`,
        }).catch((err) => {
          console.error(`[PINGS] Ping sent for "${event.title}" but the event message was not updated:`, err.message);
        });

        failedAttempts.delete(cooldownKey);
        console.log(`[PINGS] Sent "${windowInfo.label}" ping for event "${event.title}" (previous reminder replaced).`);
      } catch (err) {
        const attempts = (failedAttempts.get(cooldownKey) || 0) + 1;
        failedAttempts.set(cooldownKey, attempts);
        if (attempts >= MAX_ATTEMPTS) {
          // Give up for good: the flag stays claimed, so this instance - and
          // any other one - stops trying. This is what ends the retry storm.
          console.error(
            `[PINGS] Giving up on "${windowInfo.label}" ping for "${event.title}" ` +
              `after ${attempts} attempts (${err.message}). The window is marked sent and will not be retried.`,
          );
        } else {
          // Release the claim so a later tick (or the other instance) can try
          // again once Discord access comes back.
          await prisma.event
            .update({ where: { id: event.id }, data: { [windowInfo.key]: false } })
            .catch(() => {});
          console.error(
            `[PINGS] Attempt ${attempts}/${MAX_ATTEMPTS} - "${windowInfo.label}" ping for "${event.title}" failed: ${err.message}`,
          );
        }
      }
    }

    if (staleKeys.length) {
      const data = Object.fromEntries(staleKeys.map((key) => [key, true]));
      await prisma.event.update({ where: { id: event.id }, data }).catch(() => {});
      console.log(
        `[PINGS] Closed ${staleKeys.length} expired window(s) for "${event.title}" without sending (event started or ended).`,
      );
    }
  }
}

async function completeEndedEvents(client) {
  const now = new Date();

  const ended = await prisma.event.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ACTIVE'] },
      endTime: { lt: now },
    },
  });

  for (const event of ended) {
    try {
      // Status first: once the row says COMPLETED no scheduler (here or in
      // another instance) will ping it again, whatever the Discord side does.
      const updated = await prisma.event.update({
        where: { id: event.id },
        data: { status: 'COMPLETED' },
      });
      console.log(`[PINGS] Event "${updated.title}" marked COMPLETED.`);
      await updateEventMessage(client, updated).catch((err) => {
        console.error(`[PINGS] Event "${updated.title}" completed but its message was not updated:`, err.message);
      });
      await markReminderEnded(client, updated).catch((err) => {
        console.error(`[PINGS] Event "${updated.title}" completed but its reminder was not edited:`, err.message);
      });
    } catch (err) {
      console.error(`[PINGS] Failed to complete event "${event.title}":`, err.message);
    }
  }
}

function startPingScheduler(client) {
  if (CONFIG.BEHAVIOR.PING_SCHEDULER_ENABLED === false) {
    // A second bot instance (typically the local dev one) must never race the
    // deployed scheduler for the same windows. Set PING_SCHEDULER_ENABLED=true
    // locally only when deliberately testing reminders.
    console.log('[PINGS] Auto-ping scheduler disabled (PING_SCHEDULER_ENABLED=false); this instance sends no reminders.');
    return { stop() {} };
  }

  const task = cron.schedule('* * * * *', async () => {
    // Completion first: an event that ended leaves the pinging set before any
    // window is considered.
    try {
      await completeEndedEvents(client);
    } catch (err) {
      console.error('[PINGS] Completion check error:', err.message);
    }
    try {
      await checkEventPings(client);
    } catch (err) {
      console.error('[PINGS] Scheduler tick error:', err.message);
    }
  });
  console.log('[PINGS] Auto-ping scheduler started (every minute).');
  return task;
}

module.exports = {
  startPingScheduler,
  checkEventPings,
  completeEndedEvents,
  /**
   * Clears the in-process cooldown/attempt state. Test-only: the maps model
   * one process's memory, and each test case needs to start with a clean one.
   */
  __resetForTests() {
    lastPinged.clear();
    failedAttempts.clear();
  },
};
