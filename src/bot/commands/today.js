const prisma = require('../../db');
const { buildEventListEmbed, filterToday, isUpcoming, sortByStart } = require('./helpers');

async function todayCommand(interaction) {
  const events = await prisma.event.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ACTIVE'] },
      guildId: interaction.guildId || undefined,
    },
    orderBy: { startTime: 'asc' },
  });

  const today = sortByStart(filterToday(events.filter(isUpcoming)));

  const embed = buildEventListEmbed(today, {
    title: '📅 Today\'s Events',
    description: today.length > 0 ? undefined : 'No events scheduled for today.',
    fieldName: today.length > 0 ? '\u200B' : undefined,
  });

  await interaction.reply({ embeds: [embed] });
}

module.exports = { todayCommand };