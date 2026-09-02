const { Events } = require('discord.js');
const { phnxMenu } = require('../commands/phnx-menu');
const { todayCommand } = require('../commands/today');
const { upcomingCommand } = require('../commands/upcoming');
const { pingReset } = require('../commands/ping-reset');
const { handleButtonInteraction, handleModalSubmit } = require('./buttons');

const EPHEMERAL_FLAG = 64;

function onInteractionCreate(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        switch (interaction.commandName) {
          case 'phnx-menu':
            await phnxMenu(interaction);
            break;
          case 'phnx-today':
            await todayCommand(interaction);
            break;
          case 'phnx-upcoming':
            await upcomingCommand(interaction);
            break;
          case 'phnx-ping-reset':
            await pingReset(interaction);
            break;
          default:
            await interaction.reply({
              content: 'Unknown command.',
              flags: EPHEMERAL_FLAG,
            });
        }
        return;
      }

      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await handleButtonInteraction(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction);
        return;
      }
    } catch (err) {
      console.error('[INTERACTIONS] Handler error:', err.message);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: '⚠️ Something went wrong.',
            flags: EPHEMERAL_FLAG,
          });
        }
      } catch {
        /* ignore secondary errors */
      }
    }
  });
}

module.exports = { onInteractionCreate };