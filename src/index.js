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
const { setClient, ensureHeaders, syncMembers, listTasksAndArchive, isConfigured } = require('./sheets');
const { updateTasksPanel } = require('./bot/tasks/task-panel');
const { ensureAssignedPings, checkSheetAssignments } = require('./bot/tasks/task-pings');
const { getAutoRefreshConfig } = require('./settings');

validateEnv();

let scheduler = null;

// Spreadsheet auto-refresh loop state (toggled from the web dashboard).
const SHEET_IDLE_POLL_MS = 15000;
let sheetRefreshTimer = null;
let sheetRefreshActive = null;

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
  if (sheetRefreshTimer) {
    clearTimeout(sheetRefreshTimer);
    sheetRefreshTimer = null;
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
        ensureAssignedPings(client).catch(() => {});
        console.log('[SHEETS] Sync ready, spreadsheet configured.');

        let lastSignature = '';
        let membersTick = 0;
        const refreshBoardFromSheet = async () => {
          try {
            const { tasks, archived } = await listTasksAndArchive(guild);
            const signature = JSON.stringify(
              [...tasks, ...archived].map((t) => [t.id, t.title, t.description, t.assignedTo, t.status, t.dueDate]),
            );
            if (signature !== lastSignature) {
              lastSignature = signature;
              await updateTasksPanel(client);
              await checkSheetAssignments(client, tasks).catch(() => {});
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

        // Auto-refresh is toggled from the web dashboard (persisted in the settings table).
        // While disabled we only poll the DB (cheap) and skip all Sheets/Discord API work.
        const waitFor = (ms) =>
          new Promise((resolve) => {
            sheetRefreshTimer = setTimeout(() => {
              sheetRefreshTimer = null;
              resolve();
            }, ms);
          });

        const sheetLoop = async () => {
          while (!shuttingDown) {
            let delayMs = SHEET_IDLE_POLL_MS;
            try {
              const cfg = await getAutoRefreshConfig();
              if (cfg.enabled) {
                await refreshBoardFromSheet();
                delayMs = cfg.intervalMs;
                if (sheetRefreshActive === false) console.log('[SHEETS] Auto-refresh resumed.');
                sheetRefreshActive = true;
              } else {
                if (sheetRefreshActive === true) console.log('[SHEETS] Auto-refresh paused via dashboard.');
                sheetRefreshActive = false;
              }
            } catch (err) {
              console.warn('[SHEETS] Auto-refresh loop error:', err.message);
            }
            await waitFor(delayMs);
          }
          console.log('[SHEETS] Auto-refresh loop stopped.');
        };

        const initialCfg = await getAutoRefreshConfig();
        sheetRefreshActive = initialCfg.enabled;
        if (initialCfg.enabled) await refreshBoardFromSheet();
        sheetLoop().catch((err) => console.warn('[SHEETS] Auto-refresh loop crashed:', err.message));
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