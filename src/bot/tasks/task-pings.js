const { CONFIG } = require('../../config');
const prisma = require('../../db');
const { listTasks, getTaskUpdates, getHelperNames, getGuild } = require('../../sheets');

let pingedKeys = new Set();

function settingKey(guildId) {
  return `tasks_assigned_pinged:${guildId}`;
}

async function loadPinged(guildId) {
  try {
    const stored = await prisma.setting.findUnique({ where: { key: settingKey(guildId) } });
    if (stored?.value) pingedKeys = new Set(JSON.parse(stored.value));
  } catch (err) {
    console.warn('[TASK-PINGS] Failed to load pinged set:', err.message);
  }
}

async function persistPinged(guildId) {
  try {
    await prisma.setting.upsert({
      where: { key: settingKey(guildId) },
      update: { value: JSON.stringify([...pingedKeys]) },
      create: { key: settingKey(guildId), value: JSON.stringify([...pingedKeys]) },
    });
  } catch (err) {
    console.warn('[TASK-PINGS] Failed to persist pinged set:', err.message);
  }
}

async function sendAssignedPing(client, task, assignerId) {
  const channelId = CONFIG.CHANNELS.PERSONAL_PINGS;
  const guildId = CONFIG.DISCORD.GUILD_ID;
  if (!channelId || !task.assignedTo) return;

  const key = `${task.id}:${task.assignedTo}`;
  if (pingedKeys.has(key)) return; // ping exactly once per task+assignee

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn('[TASK-PINGS] PERSONAL_PINGS_CHANNEL not found in cache.');
    return;
  }

  const guild = client.guilds.cache.get(guildId) || null;
  const helperNames = await getHelperNames().catch(() => new Map());
  const nameFor = (id) => {
    const member = guild?.members.cache.get(id);
    const helper = helperNames.get(id);
    return helper || member?.nickname || member?.user?.username || String(id);
  };

  // Assignee: always a true @mention so Discord notifies them, annotated with their helper name.
  const assignee = `<@${task.assignedTo}> (${nameFor(task.assignedTo)})`;

  // Assigner: mention when known, otherwise fall back to their helper name.
  let assigner = 'someone';
  if (assignerId) {
    assigner = guild?.members.cache.has(assignerId)
      ? `<@${assignerId}> (${nameFor(assignerId)})`
      : nameFor(assignerId);
  }

  try {
    const taskChannel = CONFIG.CHANNELS.TASKS ? `<#${CONFIG.CHANNELS.TASKS}>` : 'the To-Do channel spreadsheet';
    const due = task.dueDate
      ? `\n> 📅 Due ${new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';
    const lines = [
      '**New Task Assigned!**',
      '',
      `${assignee} you've been assigned a new task by ${assigner}.`,
      '',
      `> ${task.title}${due}`,
      '',
      `To view your tasks, use \`/phnx-mytasks\` to see your personal task list, or check ${taskChannel}.`,
    ];
    await channel.send(lines.join('\n'));
    pingedKeys.add(key);
    await persistPinged(guildId);
  } catch (err) {
    console.warn(`[TASK-PINGS] Could not send assignment ping: ${err.message}`);
  }
}

async function checkSheetAssignments(client, tasks) {
  for (const task of tasks) {
    if (!(task.assignedTo && task.status === 'IN_PROGRESS')) continue;
    if (pingedKeys.has(`${task.id}:${task.assignedTo}`)) continue;
    let assignerId = null;
    try {
      const updates = await getTaskUpdates(task.id, client.guilds.cache.get(CONFIG.DISCORD.GUILD_ID) || null);
      const last = [...updates].reverse().find((u) => u.userId) || null;
      assignerId = last?.userId || null;
    } catch {
      assignerId = null;
    }
    await sendAssignedPing(client, task, assignerId);
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