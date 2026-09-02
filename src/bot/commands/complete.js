const { StringSelectMenuBuilder, ActionRowBuilder } = require('discord.js');
const prisma = require('../../db');
const { isLeadershipUser } = require('../../utils/role-check');
const { formatUtcDateTime } = require('../../utils/time');

const EPHEMERAL_FLAG = 64;

async function completeCommand(interaction) {
  if (!isLeadershipUser(interaction)) {
    await interaction.reply({
      content: '⛔ You need leadership permissions to use this command.',
      flags: EPHEMERAL_FLAG,
    });
    return;
  }

  await interaction.deferReply({ flags: EPHEMERAL_FLAG });

  const events = await prisma.event.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ACTIVE'] },
      guildId: interaction.guildId,
    },
    orderBy: { startTime: 'asc' },
    take: 25,
  });

  if (events.length === 0) {
    await interaction.editReply('No active or scheduled events to complete.');
    return;
  }

  const options = events.map((e) => ({
    label: e.title.substring(0, 100),
    description: `${formatUtcDateTime(e.startTime)} · ${e.status}`,
    value: e.id,
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId('phnx_complete_select')
    .setPlaceholder('Select an event to mark as completed...')
    .setMaxValues(1)
    .setOptions(options);

  const row = new ActionRowBuilder().addComponents(select);

  await interaction.editReply({
    content: 'Select an event to mark as completed:',
    components: [row],
  });
}

module.exports = { completeCommand };