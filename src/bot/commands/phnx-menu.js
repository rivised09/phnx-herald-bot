const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const prisma = require('../../db');
const { CONFIG } = require('../../config');
const { formatDiscordRelative, formatDiscordDateTime } = require('../../utils/time');
const { filterToday, isUpcoming, sortByStart } = require('./helpers');

const EPHEMERAL_FLAG = 64;

async function phnxMenu(interaction) {
  const guildId = interaction.guildId;

  const events = await prisma.event.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ACTIVE'] },
      guildId: guildId || undefined,
    },
    orderBy: { startTime: 'asc' },
  });

  const upcoming = sortByStart(events.filter(isUpcoming));
  const today = filterToday(upcoming);

  const embed = new EmbedBuilder()
    .setColor(CONFIG.BEHAVIOR.EMBED_COLORS.SCHEDULED)
    .setTitle('📋 Alliance Event Menu')
    .setTimestamp(new Date());

  const recentPast = events.filter((e) => !isUpcoming(e) && e.status === 'ACTIVE').length;

  if (today.length > 0) {
    embed.addFields({
      name: `📅 Today (${today.length})`,
      value: today
        .map((e) => `• **${e.title}** — ${formatDiscordDateTime(e.startTime)} (${formatDiscordRelative(e.startTime)})`)
        .join('\n'),
    });
  } else {
    embed.addFields({ name: '📅 Today', value: 'No events today.' });
  }

  if (upcoming.length > 0) {
    embed.addFields({
      name: '⏳ Next Upcoming',
      value: `**${upcoming[0].title}**\n${formatDiscordDateTime(upcoming[0].startTime)} (${formatDiscordRelative(upcoming[0].startTime)})`,
    });
  }

  embed.setDescription(
    `**${events.filter(isUpcoming).length}** upcoming${today.length > 0 ? ` · **${today.length}** today` : ''}${recentPast > 0 ? ` · **${recentPast}** active now` : ''}`,
  );

  const dashboardButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Secondary)
    .setLabel('🌐 Open Dashboard')
    .setCustomId('phnx_dashboard_open');

  const allEventsButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Primary)
    .setLabel('📋 All Events')
    .setCustomId('phnx_show_all');

  const manageEventsButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Danger)
    .setLabel('🛠️ Manage Events')
    .setCustomId('phnx_manage_events');

  const row = new ActionRowBuilder().addComponents(allEventsButton, dashboardButton, manageEventsButton);

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: EPHEMERAL_FLAG,
  });
}

module.exports = { phnxMenu };