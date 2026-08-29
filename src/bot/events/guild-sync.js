const { Events } = require('discord.js');
const prisma = require('../../db');

const STATUS_MAP = {
  Scheduled: 'SCHEDULED',
  Active: 'ACTIVE',
  Completed: 'COMPLETED',
  Canceled: 'CANCELLED',
};

async function enableScheduledEventSync(client) {
  client.on(Events.GuildScheduledEventUpdate, async (oldEvent, newEvent) => {
    if (!newEvent || !newEvent.id) return;

    try {
      const dbEvent = await prisma.event.findFirst({
        where: { discordEventId: newEvent.id },
      });
      if (!dbEvent) return;

      const newStatus = STATUS_MAP[newEvent.status] || dbEvent.status;
      if (newStatus !== dbEvent.status) {
        await prisma.event.update({
          where: { id: dbEvent.id },
          data: { status: newStatus },
        });
        console.log(`[SYNC] Event "${dbEvent.title}" status synced: ${dbEvent.status} -> ${newStatus}`);
      }
    } catch (err) {
      console.error('[SYNC] Failed to sync scheduled event status:', err.message);
    }
  });

  console.log('[SYNC] Scheduled event status sync enabled.');
}

module.exports = { enableScheduledEventSync };