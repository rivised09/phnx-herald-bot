const cron = require('node-cron');
const prisma = require('../../db');
const { CONFIG } = require('../../config');
const { msUntil } = require('../../utils/time');
const { sendPing, updateEventMessage, deleteReminderMessage, markReminderEnded } = require('./posting');

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

        // Keep only ONE reminder in the channel: delete the previous one before
        // firing the next window, so it stays a single message while still pinging
        // @everyone on a fresh message at every window.
        await deleteReminderMessage(client, event.reminderMessageId);

        const message = await sendPing(client, event, windowLabel);
        const data = { [windowInfo.key]: true, reminderMessageId: message?.id || event.reminderMessageId || null };
        if (windowInfo.key === 'pingStarted' && event.status === 'SCHEDULED') {
          data.status = 'ACTIVE';
        }
        const updated = await prisma.event.update({
          where: { id: event.id },
          data,
        });
        await updateEventMessage(client, updated, {
          pingNote: windowInfo.key === 'pingStarted' ? null : `Starts in ${windowLabel}`,
        });
        console.log(`[PINGS] Sent "${windowLabel}" ping for event "${event.title}" (previous reminder replaced).`);
      } catch (err) {
        console.error(`[PINGS] Failed to send "${windowInfo.label}" ping for "${event.title}":`, err.message);
      }
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
      const updated = await prisma.event.update({
        where: { id: event.id },
        data: { status: 'COMPLETED' },
      });
      await updateEventMessage(client, updated);
      await markReminderEnded(client, updated);
      console.log(`[PINGS] Event "${updated.title}" marked COMPLETED and last reminder edited to "EVENT ENDED".`);
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