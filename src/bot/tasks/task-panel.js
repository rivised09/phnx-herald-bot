const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const prisma = require('../../db');
const { CONFIG } = require('../../config');
const { statusCounts } = require('./task-actions');

const EPHEMERAL_FLAG = 64;

function settingKey(guildId) {
  return `tasks_panel_message_id:${guildId}`;
}

async function getPanelCounts(guildId) {
  const tasks = await prisma.task.findMany({ where: { guildId }, select: { status: true } });
  return statusCounts(tasks);
}

function buildPanelEmbed(counts) {
  const embed = new EmbedBuilder()
    .setColor(0xfb923c)
    .setDescription(
      '## 🐦‍🔥 PHW Tasks\n\n'
        + `\`📋 Active Tasks: ${counts.active}\`\n`
        + `\`🟡 In Progress: ${counts.inProgress}\`\n`
        + `\`🔵 Open: ${counts.open}\``,
    );

  return embed;
}

function panelActionRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('phnxt_open_new')
      .setStyle(ButtonStyle.Success)
      .setLabel('➕ New Task'),
    new ButtonBuilder()
      .setCustomId('phnxt_open_show')
      .setStyle(ButtonStyle.Primary)
      .setLabel('📋 Show Tasks'),
    new ButtonBuilder()
      .setCustomId('phnxt_open_claim')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('🙋 Claim Task'),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('phnxt_open_mine')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('📌 My Tasks'),
    new ButtonBuilder()
      .setCustomId('phnxt_open_archive')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('📚 Archive'),
    new ButtonBuilder()
      .setCustomId('phnxt_open_help')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('❓ Help'),
  );

  return [row1, row2];
}

async function fetchPanelMessage(client) {
  if (!CONFIG.CHANNELS.TASKS) return null;
  const channel = await client.channels.fetch(CONFIG.CHANNELS.TASKS).catch(() => null);
  if (!channel) return null;

  const key = settingKey(CONFIG.DISCORD.GUILD_ID);
  const stored = await prisma.setting.findUnique({ where: { key } });
  if (!stored) return null;

  const message = await channel.messages.fetch(stored.value).catch(() => null);
  if (!message) return null;

  return message;
}

async function updateTasksPanel(client, guildId = CONFIG.DISCORD.GUILD_ID) {
  const message = await fetchPanelMessage(client);
  if (!message) return;

  const counts = await getPanelCounts(guildId);
  await message.edit({
    embeds: [buildPanelEmbed(counts)],
    components: panelActionRows(),
  });
}

async function ensureTasksPanel(client) {
  if (!CONFIG.CHANNELS.TASKS) {
    console.warn('[TASKS] TASKS_CHANNEL_ID not set — task panel will not be posted.');
    return null;
  }

  const channel = await client.channels.fetch(CONFIG.CHANNELS.TASKS).catch((err) => {
    console.error('[TASKS] Failed to fetch tasks channel:', err.message);
    return null;
  });
  if (!channel) return null;

  const key = settingKey(CONFIG.DISCORD.GUILD_ID);
  const stored = await prisma.setting.findUnique({ where: { key } });

  if (stored) {
    const existing = await channel.messages.fetch(stored.value).catch(() => null);
    if (existing) {
      await updateTasksPanel(client);
      console.log(`[TASKS] Task panel exists, counters refreshed (#${channel.name}).`);
      return existing;
    }
  }

  const counts = await getPanelCounts(CONFIG.DISCORD.GUILD_ID);
  const message = await channel.send({
    embeds: [buildPanelEmbed(counts)],
    components: panelActionRows(),
  });

  await prisma.setting.upsert({
    where: { key },
    update: { value: message.id },
    create: { key, value: message.id },
  });

  console.log(`[TASKS] Task panel created in #${channel.name}.`);
  return message;
}

async function rebuildTasksPanel(client) {
  if (!CONFIG.CHANNELS.TASKS) return { ok: false, error: 'TASKS_CHANNEL_ID is not configured.' };

  const channel = await client.channels.fetch(CONFIG.CHANNELS.TASKS).catch(() => null);
  if (!channel) return { ok: false, error: 'Could not find the tasks channel.' };

  const key = settingKey(CONFIG.DISCORD.GUILD_ID);
  const stored = await prisma.setting.findUnique({ where: { key } });
  if (stored) {
    const existing = await channel.messages.fetch(stored.value).catch(() => null);
    if (existing) await existing.delete().catch(() => {});
  }

  const counts = await getPanelCounts(CONFIG.DISCORD.GUILD_ID);
  const message = await channel.send({
    embeds: [buildPanelEmbed(counts)],
    components: panelActionRows(),
  });

  await prisma.setting.upsert({
    where: { key },
    update: { value: message.id },
    create: { key, value: message.id },
  });

  return { ok: true, channel: channel.name };
}

module.exports = {
  EPHEMERAL_FLAG,
  buildPanelEmbed,
  panelActionRows,
  getPanelCounts,
  ensureTasksPanel,
  updateTasksPanel,
  rebuildTasksPanel,
};