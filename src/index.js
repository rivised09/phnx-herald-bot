const { CONFIG, validateEnv } = require('./config');
const prisma = require('./db');
const { client, loginWithRetry } = require('./bot/client');
const { createApp } = require('./api/server');
const { registerCommands } = require('./bot/deploy-commands');
const { enableScheduledEventSync } = require('./bot/events/guild-sync');
const { enableChannelSync, syncChannels } = require('./bot/events/channel-sync');
const { startPingScheduler } = require('./bot/events/pings');
const { ensureTasksPanel } = require('./bot/tasks/task-panel');
const { onInteractionCreate } = require('./bot/interactions/handler');
const { setClient, ensureHeaders, syncMembers, listTasks, listArchiveTasks, isConfigured } = require('./sheets');
const { updateTasksPanel } = require('./bot/tasks/task-panel');

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
    setClient(client);
    await registerCommands();
    scheduler = startPingScheduler(client);

    if (isConfigured()) {
      try {
        await ensureHeaders();
        await Promise.all([syncMembers(guild), ensureTasksPanel(client)]);
        console.log('[SHEETS] Sync ready, spreadsheet configured.');

        let lastSignature = '';
        let membersTick = 0;
        const refreshBoardFromSheet = async () => {
          try {
            const [tasks, archived] = await Promise.all([listTasks(guild), listArchiveTasks(guild)]);
            const signature = JSON.stringify(
              [...tasks, ...archived].map((t) => [
                t.id,
                t.title,
                t.description,
                t.assignedTo,
                t.status,
                t.dueDate,
              ]),
            );
            if (signature !== lastSignature) {
              lastSignature = signature;
              await updateTasksPanel(client);
              console.log(`[SHEETS] Task board refreshed from spreadsheet (${tasks.length} active, ${archived.length} archived).`);
            }
            membersTick++;
            if (membersTick >= 60) {
              membersTick = 0;
              await guild.members.fetch().catch(() => {});
              await syncMembers(guild);
              console.log('[SHEETS] MEMBERS tab refreshed.');
            }
          } catch (err) {
            console.warn('[SHEETS] Panel refresh error:', err.message);
          }
        };

        setTimeout(refreshBoardFromSheet, 2000);
        setInterval(refreshBoardFromSheet, 5000);
        console.log('[SHEETS] Spreadsheet → Discord sync every 5s.');
      } catch (err) {
        console.warn('[SHEETS] Initial sync skipped:', err.message);
      }
    } else {
      await ensureTasksPanel(client);
      console.log('[SHEETS] Google Sheets sync not configured — skipping.');
    }
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