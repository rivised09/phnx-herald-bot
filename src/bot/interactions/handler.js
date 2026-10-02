const { Events } = require('discord.js');
const { phnxMenu } = require('../commands/phnx-menu');
const { todayCommand } = require('../commands/today');
const { upcomingCommand } = require('../commands/upcoming');
const { pingReset } = require('../commands/ping-reset');
const { completeCommand } = require('../commands/complete');
const { playersInfoCommand } = require('../commands/players-info');
const { handleButtonInteraction, handleModalSubmit } = require('./buttons');
const {
  handleTaskInteraction,
  handleTaskModal,
  taskBoardCommand,
  taskMyTasksCommand,
  taskSetupCommand,
  openHelpCommand,
} = require('../tasks/task-flows');

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
          case 'phnx-complete':
            await completeCommand(interaction);
            break;
          case 'phnx-tasks':
            await taskBoardCommand(interaction);
            break;
          case 'phnx-mytasks':
            await taskMyTasksCommand(interaction);
            break;
          case 'phnx-tasks-setup':
            await taskSetupCommand(interaction);
            break;
          case 'phnx-tasks-help':
            await openHelpCommand(interaction);
            break;
          case 'phnx-players-info':
            await playersInfoCommand(interaction);
            break;
          default:
            await interaction.reply({
              content: 'Unknown command.',
              flags: EPHEMERAL_FLAG,
            });
        }
        return;
      }

      if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
        if (interaction.customId.startsWith('phnxt_')) {
          await handleTaskInteraction(interaction);
          return;
        }
        await handleButtonInteraction(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('phnxt_modal_')) {
          await handleTaskModal(interaction);
          return;
        }
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