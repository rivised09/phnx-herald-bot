const { EmbedBuilder } = require('discord.js');
const { CONFIG } = require('../../config');
const { formatDiscordRelative, formatDiscordDateTime, formatUtc, isSameUtcDay } = require('../../utils/time');

function eventLine(event) {
  return `**${event.title}**\n${formatDiscordDateTime(event.startTime)} (${formatDiscordRelative(event.startTime)})${event.location ? `\n📍 ${event.location}` : ''}`;
}

function buildEventListEmbed(events, { title, description, fieldName } = {}) {
  const embed = new EmbedBuilder()
    .setColor(CONFIG.BEHAVIOR.EMBED_COLORS.SCHEDULED)
    .setTitle(title || '📋 Alliance Events')
    .setTimestamp(new Date());

  if (description) embed.setDescription(description);

  if (events.length === 0) {
    embed.setDescription('🎉 No events found.');
  } else {
    embed.addFields({
      name: fieldName ?? `Events (${events.length})`,
      value: events.map(eventLine).join('\n\n'),
    });
  }

  return embed;
}

function filterToday(events) {
  return events.filter((e) => isSameUtcDay(e.startTime, new Date()));
}

function isUpcoming(event) {
  return new Date(event.startTime).getTime() > Date.now();
}

function sortByStart(events) {
  return [...events].sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

module.exports = { eventLine, buildEventListEmbed, filterToday, isUpcoming, sortByStart };