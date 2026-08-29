const { EmbedBuilder } = require('discord.js');
const { CONFIG } = require('../../config');
const {
  formatDiscordDateTime,
  formatDuration,
  formatUtcDateTime,
} = require('../../utils/time');

const SQUARE = '▰';

const STATUS_COLORS = CONFIG.BEHAVIOR.EMBED_COLORS;

function titleFor(event, status) {
  const base = `▰ ${event.title.toUpperCase()}`;
  if (status === 'CANCELLED') return `❌ ${base}`;
  if (status === 'COMPLETED') return `✅ ${base}`;
  return base;
}

function buildEventEmbed(event, { cancelled = false, pingNote = null } = {}) {
  const effectiveStatus = cancelled ? 'CANCELLED' : event.status || 'SCHEDULED';
  const color = STATUS_COLORS[effectiveStatus] || STATUS_COLORS.SCHEDULED;

  const embed = new EmbedBuilder().setColor(color);

  embed.setTitle(titleFor(event, effectiveStatus));

  if (event.description) {
    embed.setDescription(event.description);
  }

  const fields = [];

  fields.push({
    name: 'Scheduled for',
    value: [
      formatUtcDateTime(event.startTime),
      `Your time: ${formatDiscordDateTime(event.startTime)}`,
    ].join('\n'),
  });

  if (event.endTime) {
    fields.push({
      name: 'Duration',
      value: formatDuration(event.startTime, event.endTime),
      inline: true,
    });
  }

  if (event.location) {
    fields.push({ name: 'Location', value: event.location, inline: true });
  }

  if (fields.length > 0) {
    embed.addFields(fields);
  }

  let footer = CONFIG.BRANDING.FOOTER;
  if (effectiveStatus === 'CANCELLED') {
    footer = `❌ Event Cancelled · ${footer}`;
  } else if (effectiveStatus === 'ACTIVE') {
    footer = `🔴 Event in Progress · ${footer}`;
  } else if (effectiveStatus === 'COMPLETED') {
    footer = `✅ Event Completed · ${footer}`;
  }

  embed.setFooter({ text: footer });

  return embed;
}

module.exports = { buildEventEmbed, SQUARE };