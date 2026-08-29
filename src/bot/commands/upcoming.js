const prisma = require('../../db');
const { buildEventEmbed } = require('../events/embeds');
const { isUpcoming } = require('./helpers');

async function upcomingCommand(interaction) {
  const events = await prisma.event.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ACTIVE'] },
      guildId: interaction.guildId || undefined,
    },
    orderBy: { startTime: 'asc' },
  });

  const nextEvent = events.find(isUpcoming);

  if (!nextEvent) {
    await interaction.reply({
      content: '🎉 No upcoming events. Check the dashboard to create one!',
    });
    return;
  }

  const embed = buildEventEmbed(nextEvent);
  await interaction.reply({ embeds: [embed] });
}

module.exports = { upcomingCommand };