const cron = require('node-cron');
const prisma = require('../../db');
const { CONFIG } = require('../../config');
const { msUntil } = require('../../utils/time');
const { sendPing, updateEventMessage } = require('./posting');

const STARTING_PING_THRESHOLD_MS = 0;
const MAX_START_PING_DELAY_MS = 5 * 60 * 1000;

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

    for (const windowInfo of CONFIG.BEHAVIOR.PING_WINDOWS) {
      if (event[windowInfo.key]) continue;
      if (remainingMs > windowInfo.msBefore) continue;

      try {
        const windowLabel = windowInfo.label;
        await sendPing(client, event, windowLabel);
        await prisma.event.update({
          where: { id: event.id },
          data: { [windowInfo.key]: true },
        });
        await updateEventMessage(client, event, {
          pingNote: `Starts in ${windowLabel}`,
        });
        console.log(`[PINGS] Sent "${windowLabel}" ping for event "${event.title}"`);
      } catch (err) {
        console.error(`[PINGS] Failed to send "${windowInfo.label}" ping for "${event.title}":`, err.message);
      }
    }

    if (!event.pingStarted && remainingMs <= STARTING_PING_THRESHOLD_MS) {
      if (remainingMs >= -MAX_START_PING_DELAY_MS) {
        try {
          await sendPing(client, event, 'starting');
          const updated = await prisma.event.update({
            where: { id: event.id },
            data: { pingStarted: true, status: 'ACTIVE' },
          });
          await updateEventMessage(client, updated);
          console.log(`[PINGS] Event "${event.title}" marked ACTIVE and start ping sent.`);
        } catch (err) {
          console.error(`[PINGS] Failed to start event "${event.title}":`, err.message);
        }
      }
    }
  }
}

async function completeEndedEvents(client) {
  const now = new Date();

  const ended = await prisma.event.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ACTIVE'] },
      OR: [{ endTime: { lt: now } }, { AND: [{ endTime: null }, { startTime: { lt: now } }] }],
    },
  });

  for (const event of ended) {
    try {
      const updated = await prisma.event.update({
        where: { id: event.id },
        data: { status: 'COMPLETED' },
      });
      await updateEventMessage(client, updated);
      console.log(`[PINGS] Event "${updated.title}" marked COMPLETED and embed updated.`);
    } catch (err) {
      console.error(`[PINGS] Failed to complete event "${event.title}":`, err.message);
    }
  }
}

function startPingScheduler(client) {
  const task = cron.schedule('* * * * *', async () => {
    try {
      await checkEventPings(client);
    } catch (err) {
      console.error('[PINGS] Scheduler tick error:', err.message);
    }
    try {
      await completeEndedEvents(client);
    } catch (err) {
      console.error('[PINGS] Completion check error:', err.message);
    }
  });
  console.log('[PINGS] Auto-ping scheduler started (every minute).');
  return task;
}

module.exports = { startPingScheduler, checkEventPings, completeEndedEvents };