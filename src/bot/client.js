const { Client, GatewayIntentBits } = require('discord.js');
const { CONFIG } = require('../config');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    // Required to read the text of messages the bot did not author.
    // Must also be enabled for the application in the Discord dev portal.
    GatewayIntentBits.MessageContent,
  ],
});

async function loginWithRetry(retries = 5, delayMs = 10_000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await client.login(CONFIG.DISCORD.TOKEN);
      return true;
    } catch (err) {
      console.error(`[BOT] Login failed (attempt ${attempt}/${retries}): ${err.message}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  console.error('[BOT] Giving up after multiple failed login attempts.');
  return false;
}

module.exports = { client, loginWithRetry };