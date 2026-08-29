const { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, GuildScheduledEventStatus } = require('discord.js');
const { CONFIG } = require('../../config');

function mapEntityType(entityType) {
  switch ((entityType || 'EXTERNAL').toUpperCase()) {
    case 'STAGE_INSTANCE':
    case 'STAGE':
      return GuildScheduledEventEntityType.StageInstance;
    case 'VOICE':
      return GuildScheduledEventEntityType.Voice;
    case 'EXTERNAL':
    default:
      return GuildScheduledEventEntityType.External;
  }
}

async function createScheduledEvent(guild, event) {
  const entityType = mapEntityType(event.entityType);
  const options = {
    name: event.title,
    description: event.description || undefined,
    scheduledStartTime: event.startTime,
    scheduledEndTime: event.endTime,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType,
    reason: 'Created by Phoenix Herald',
  };

  if (event.image && event.image.buffer) {
    options.image = event.image.buffer;
  }

  if (entityType === GuildScheduledEventEntityType.External) {
    options.entityMetadata = { location: event.location || 'No location specified' };
  } else {
    options.channel = event.channelId;
  }

  return guild.scheduledEvents.create(options);
}

async function cancelScheduledEvent(guild, discordEventId) {
  if (!discordEventId) return null;
  const guildEvent = await guild.scheduledEvents.fetch(discordEventId).catch(() => null);
  if (!guildEvent) return null;

  if (guildEvent.status === GuildScheduledEventStatus.Scheduled) {
    await guildEvent.setStatus(GuildScheduledEventStatus.Canceled, 'Event cancelled by Phoenix Herald');
  }
  return guildEvent;
}

async function deleteScheduledEvent(guild, discordEventId) {
  if (!discordEventId) return null;
  const guildEvent = await guild.scheduledEvents.fetch(discordEventId).catch(() => null);
  if (!guildEvent) return null;
  await guildEvent.delete('Event deleted by Phoenix Herald');
  return true;
}

module.exports = { createScheduledEvent, cancelScheduledEvent, deleteScheduledEvent, mapEntityType };