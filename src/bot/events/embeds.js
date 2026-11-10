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

  // Terminal states get an unmissable status line first - the same
  // green-check / red-cross language the web calendar cards use, so a card
  // that was built while the event was still running reads correctly after
  // the fact (the reminder edit relies on this).
  if (effectiveStatus === 'COMPLETED') {
    fields.push({
      name: 'Status',
      value: event.endTime
        ? `✅ **Completed** · ended ${formatDiscordDateTime(event.endTime)}`
        : '✅ **Completed**',
    });
  } else if (effectiveStatus === 'CANCELLED') {
    fields.push({ name: 'Status', value: '❌ **Cancelled**' });
  }

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