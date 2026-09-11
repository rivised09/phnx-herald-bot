const { CONFIG } = require('../../config');
const prisma = require('../../db');
const { listTasks, getGuild, getHelperNames } = require('../../sheets');

let pingedMap = new Map(); // taskId -> assigneeId that was last pinged for this task

function settingKey(guildId) {
  return `tasks_assigned_pinged:${guildId}`;
}

async function loadPinged(guildId) {
  try {
    const stored = await prisma.setting.findUnique({ where: { key: settingKey(guildId) } });
    if (!stored?.value) return;
    const parsed = JSON.parse(stored.value);
    if (Array.isArray(parsed)) {
      pingedMap = new Map(
        parsed.map((k) => {
          const idx = String(k).lastIndexOf(':');
          return [String(k).slice(0, idx), String(k).slice(idx + 1)];
        }),
      );
    } else {
      pingedMap = new Map(Object.entries(parsed));
    }
  } catch (err) {
    console.warn('[TASK-PINGS] Failed to load pinged map:', err.message);
  }
}

async function persistPinged(guildId) {
  try {
    const value = JSON.stringify(Object.fromEntries(pingedMap));
    await prisma.setting.upsert({
      where: { key: settingKey(guildId) },
      update: { value },
      create: { key: settingKey(guildId), value },
    });
  } catch (err) {
    console.warn('[TASK-PINGS] Failed to persist pinged map:', err.message);
  }
}

async function sendAssignedPing(client, task) {
  const channelId = CONFIG.CHANNELS.PERSONAL_PINGS;
  const guildId = CONFIG.DISCORD.GUILD_ID;
  if (!channelId || !task.assignedTo) return;

  if (pingedMap.get(task.id) === task.assignedTo) return; // assignee unchanged since last ping

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn('[TASK-PINGS] PERSONAL_PINGS_CHANNEL not found in cache.');
    return;
  }

  const guild = client.guilds.cache.get(guildId) || null;
  const helperNames = await getHelperNames().catch(() => new Map());
  const assigneeName = (() => {
    const helper = helperNames.get(task.assignedTo);
    if (helper) return helper;
    const member = guild?.members.cache.get(task.assignedTo);
    return member?.nickname || member?.user?.username || '';
  })();

  try {
    const taskChannel = CONFIG.CHANNELS.TASKS ? `<#${CONFIG.CHANNELS.TASKS}> spreadsheet` : 'To-Do channel spreadsheet';
    const assignee = `<@${task.assignedTo}>${assigneeName ? ` (**${assigneeName}**)` : ''}`;
    const lines = [
      '**New Task Assigned!**',
      '',
      `${assignee} you've been assigned a new task.`,
      '',
      `To view your tasks, use \`/phnx-mytasks\` command to see your personal task list, or check the ${taskChannel}.`,
    ];
    await channel.send(lines.join('\n'));
    pingedMap.set(task.id, task.assignedTo);
    await persistPinged(guildId);
  } catch (err) {
    console.warn(`[TASK-PINGS] Could not send assignment ping: ${err.message}`);
  }
}

async function checkSheetAssignments(client, tasks) {
  for (const task of tasks) {
    if (!(task.assignedTo && task.status === 'IN_PROGRESS')) continue;
    if (pingedMap.get(task.id) === task.assignedTo) continue;
    await sendAssignedPing(client, task);
  }
}

async function ensureAssignedPings(client) {
  const guildId = CONFIG.DISCORD.GUILD_ID;
  if (!CONFIG.CHANNELS.PERSONAL_PINGS) return;
  try {
    await loadPinged(guildId);
    const tasks = await listTasks(getGuild());
    await checkSheetAssignments(client, tasks);
    console.log(`[TASK-PINGS] Assignment pings ensured (${tasks.length} active task(s) checked).`);
  } catch (err) {
    console.warn('[TASK-PINGS] ensureAssignedPings error:', err.message);
  }
}

module.exports = { sendAssignedPing, ensureAssignedPings, checkSheetAssignments };