const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { CONFIG } = require('../config');

const commands = [
  new SlashCommandBuilder()
    .setName('phnx-menu')
    .setDescription('📋 Show the alliance event menu with today/upcoming events'),

  new SlashCommandBuilder()
    .setName('phnx-today')
    .setDescription('📅 Show events happening today'),

  new SlashCommandBuilder()
    .setName('phnx-upcoming')
    .setDescription('⏰ Show the nearest upcoming event'),

  new SlashCommandBuilder()
    .setName('phnx-ping-reset')
    .setDescription('🔁 Re-arm reminder pings for upcoming events (leadership only)'),

  new SlashCommandBuilder()
    .setName('phnx-complete')
    .setDescription('✅ Mark an event as completed and notify everyone (leadership only)'),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD.TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(CONFIG.DISCORD.CLIENT_ID, CONFIG.DISCORD.GUILD_ID),
      { body: commands.map((c) => c.toJSON()) },
    );
    console.log('[COMMANDS] Registered guild slash commands.');
  } catch (err) {
    console.error('[COMMANDS] Failed to register slash commands:', err.message);
  }
}

module.exports = { commands, registerCommands };