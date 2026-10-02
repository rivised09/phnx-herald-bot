const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const PLAYERS_INFO_BUTTON_ID = 'phnx_players_info_open';

/**
 * Posts the trigger button publicly so the whole channel can see it exists.
 * The click handler is leadership-gated, so only authorized members get the link.
 */
async function playersInfoCommand(interaction) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Secondary)
      .setLabel('📋 See Players Info')
      .setCustomId(PLAYERS_INFO_BUTTON_ID),
  );

  await interaction.reply({
    content: '📊 Alliance player information from the latest survey.',
    components: [row],
  });
}

module.exports = { playersInfoCommand, PLAYERS_INFO_BUTTON_ID };