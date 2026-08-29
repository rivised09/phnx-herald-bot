const { CONFIG, validateEnv } = require('./config');
const prisma = require('./db');
const { client, loginWithRetry } = require('./bot/client');
const { createApp } = require('./api/server');
const { registerCommands } = require('./bot/deploy-commands');
const { enableScheduledEventSync } = require('./bot/events/guild-sync');
const { enableChannelSync, syncChannels } = require('./bot/events/channel-sync');
const { startPingScheduler } = require('./bot/events/pings');
const { onInteractionCreate } = require('./bot/interactions/handler');

validateEnv();

let scheduler = null;

const app = createApp({ client });

const server = app.listen(CONFIG.APP.PORT, () => {
  console.log(`[API] Phoenix Herald API listening on port ${CONFIG.APP.PORT}`);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} received, shutting down gracefully...`);
  try {
    if (scheduler) scheduler.stop();
  } catch {
    /* ignore */
  }
  server.close();
  try {
    await client.destroy();
  } catch {
    /* ignore */
  }
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

client.once('clientReady', async () => {
  console.log(`[BOT] Logged in as ${client.user.tag} (${client.user.id})`);

  const guild = await client.guilds.fetch(CONFIG.DISCORD.GUILD_ID).catch((err) => {
    console.error('[BOT] Failed to fetch guild:', err.message);
    return null;
  });

  if (guild) {
    await guild.members.fetch().catch(() => {});
    await registerCommands();
    scheduler = startPingScheduler(client);
  }
  await syncChannels(client);
  enableChannelSync(client);
  await enableScheduledEventSync(client);
});

client.on('error', (err) => {
  console.error('[BOT] Discord client error:', err.message);
});

onInteractionCreate(client);

(async () => {
  const ok = await loginWithRetry();
  if (!ok) {
    console.warn('[BOT] Bot is offline, but API server continues running.');
  }
})();