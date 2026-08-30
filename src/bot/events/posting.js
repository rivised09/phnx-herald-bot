const { CONFIG } = require('../../config');
const { buildEventEmbed } = require('./embeds');
const { formatDiscordRelative } = require('../../utils/time');

function countdownContent(event) {
  const status = event.status || 'SCHEDULED';
  if (status !== 'SCHEDULED') return null;
  return `⏳ Starts ${formatDiscordRelative(event.startTime)}`;
}

async function getEventsChannel(client) {
  const channel = await client.channels.fetch(CONFIG.CHANNELS.EVENTS).catch(() => null);
  if (!channel) {
    console.error('[POSTING] Events channel not found:', CONFIG.CHANNELS.EVENTS);
  }
  return channel;
}

async function getRemindersChannel(client) {
  if (CONFIG.CHANNELS.REMINDERS) {
    const channel = await client.channels.fetch(CONFIG.CHANNELS.REMINDERS).catch(() => null);
    if (channel) return channel;
    console.error('[POSTING] Reminders channel not found:', CONFIG.CHANNELS.REMINDERS);
  }
  try {
    const guild = await client.guilds.fetch(CONFIG.DISCORD.GUILD_ID);
    const channels = await guild.channels.fetch();
    const match = channels.find((ch) => ch.isTextBased() && /^reminders?$/i.test(ch.name));
    if (match) {
      console.log('[POSTING] Reminders channel found by name:', match.name, `(${match.id})`);
      return match;
    }
  } catch (err) {
    console.error('[POSTING] Failed to locate reminders channel by name:', err.message);
  }
  return null;
}

async function postEventMessage(client, event) {
  const channel = await getEventsChannel(client);
  if (!channel) return null;
  const embed = buildEventEmbed(event);
  const message = await channel.send({ content: countdownContent(event), embeds: [embed] });
  return message;
}

async function updateEventMessage(client, event, { cancelled = false, pingNote = null } = {}) {
  if (!event.discordMessageId) return null;
  const channel = await getEventsChannel(client);
  if (!channel) return null;
  const message = await channel.messages.fetch(event.discordMessageId).catch(() => null);
  if (!message) return null;
  const embed = buildEventEmbed(event, { cancelled, pingNote });
  await message.edit({ content: countdownContent(event), embeds: [embed] });
  return message;
}

async function deleteEventMessage(client, event) {
  if (!event.discordMessageId) return null;
  const channel = await getEventsChannel(client);
  if (!channel) return null;
  const message = await channel.messages.fetch(event.discordMessageId).catch(() => null);
  if (!message) return null;
  await message.delete();
  return true;
}

async function sendNotification(client, event, content, { cancelled = false } = {}) {
  const channel = (await getRemindersChannel(client)) || (await getEventsChannel(client));
  if (!channel) return null;
  const embed = buildEventEmbed(event, { cancelled });
  const message = await channel.send({ content, embeds: [embed] });
  return message;
}

async function sendPing(client, event, windowLabel) {
  const channel = (await getRemindersChannel(client)) || (await getEventsChannel(client));
  if (!channel) return null;
  const embed = buildEventEmbed(event);
  let content;
  if (windowLabel === 'starting' || windowLabel === 'started') {
    content = `@everyone 🔔 **${event.title}** is starting now!`;
  } else if (windowLabel === '7 hours') {
    content = `@everyone 🔔 Don't forget we have **${event.title}** later!`;
  } else {
    content = `@everyone 🔔 **${event.title}** starts in **${windowLabel}**!`;
  }
  const message = await channel.send({ content, embeds: [embed] });
  return message;
}

module.exports = {
  postEventMessage,
  updateEventMessage,
  deleteEventMessage,
  sendNotification,
  sendPing,
};