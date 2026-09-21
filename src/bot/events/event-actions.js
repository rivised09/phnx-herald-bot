const prisma = require('../../db');
const { CONFIG } = require('../../config');
const { updateEventMessage, deleteEventMessage, deleteReminderMessage, sendNotification } = require('./posting');
const { deleteScheduledEvent, mapEntityType } = require('./scheduled');

async function rearmPingWindows(eventId, startTime) {
  const remainingMs = startTime.getTime() - Date.now();
  const data = {};
  for (const windowInfo of CONFIG.BEHAVIOR.PING_WINDOWS) {
    if (remainingMs > windowInfo.msBefore) {
      data[windowInfo.key] = false;
    }
  }
  if (Object.keys(data).length === 0) return;
  await prisma.event.update({ where: { id: eventId }, data });
}

async function syncEventUpdate(client, updated, { notifyModified = true, previousStartTime = null } = {}) {
  if (
    previousStartTime &&
    updated.startTime &&
    previousStartTime.getTime() !== updated.startTime.getTime()
  ) {
    try {
      await rearmPingWindows(updated.id, updated.startTime);
    } catch (err) {
      console.error('[EVENT-ACTIONS] Failed to rearm ping windows:', err.message);
    }
  }

  try {
    await updateEventMessage(client, updated);
  } catch (err) {
    console.error('[EVENT-ACTIONS] Failed to update Discord message:', err.message);
  }

  try {
    const guild = await client.guilds.fetch(CONFIG.DISCORD.GUILD_ID);
    const scheduledEvent = updated.discordEventId
      ? await guild.scheduledEvents.fetch(updated.discordEventId).catch(() => null)
      : null;
    if (scheduledEvent) {
      await scheduledEvent.edit({
        name: updated.title,
        description: updated.description || undefined,
        scheduledStartTime: updated.startTime,
        scheduledEndTime: updated.endTime,
        entityType: mapEntityType(updated.entityType),
        entityMetadata: updated.location ? { location: updated.location } : undefined,
        channel: updated.channelId || undefined,
      });
    }
  } catch (err) {
    console.error('[EVENT-ACTIONS] Failed to update Discord scheduled event:', err.message);
  }

  if (notifyModified && (updated.status === 'SCHEDULED' || updated.status === 'ACTIVE')) {
    try {
      await sendNotification(
        client,
        updated,
        `@everyone 🔔 **${updated.title}** has been modified — check the updated details!`,
      );
    } catch (err) {
      console.error('[EVENT-ACTIONS] Failed to send modified ping:', err.message);
    }
  }
}

async function cancelEventDiscord(client, updated) {
  try {
    await deleteReminderMessage(client, updated.reminderMessageId);
  } catch (err) {
    console.error('[EVENT-ACTIONS] Failed to delete reminder message:', err.message);
  }

  try {
    await updateEventMessage(client, updated, { cancelled: true });
  } catch (err) {
    console.error('[EVENT-ACTIONS] Failed to update cancelled embed:', err.message);
  }

  try {
    await sendNotification(
      client,
      updated,
      `@everyone ❌ **${updated.title}** has been cancelled.`,
      { cancelled: true },
    );
  } catch (err) {
    console.error('[EVENT-ACTIONS] Failed to send cancel ping:', err.message);
  }

  try {
    const guild = await client.guilds.fetch(CONFIG.DISCORD.GUILD_ID);
    await deleteScheduledEvent(guild, updated.discordEventId);
  } catch (err) {
    console.error('[EVENT-ACTIONS] Failed to remove scheduled event from Discord calendar:', err.message);
  }
}

async function deleteEventDiscord(client, event) {
  try {
    await deleteReminderMessage(client, event.reminderMessageId);
  } catch (err) {
    console.error('[EVENT-ACTIONS] Failed to delete reminder message:', err.message);
  }

  try {
    await deleteEventMessage(client, event);
  } catch (err) {
    console.error('[EVENT-ACTIONS] Failed to delete Discord message:', err.message);
  }

  try {
    const guild = await client.guilds.fetch(CONFIG.DISCORD.GUILD_ID);
    await deleteScheduledEvent(guild, event.discordEventId);
  } catch (err) {
    console.error('[EVENT-ACTIONS] Failed to delete Discord scheduled event:', err.message);
  }

  await prisma.event.delete({ where: { id: event.id } });
}

module.exports = { syncEventUpdate, cancelEventDiscord, deleteEventDiscord };