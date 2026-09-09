const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const prisma = require('../../db');
const { CONFIG } = require('../../config');
const { statusCounts } = require('./task-actions');

const EPHEMERAL_FLAG = 64;
const TABLE_PAGE_SIZE = 6;

const DEFAULT_PANEL_FILTER = 'ACT';
const PANEL_FILTER_LABELS = {
  ACT: '📋 All Active',
  ALL: '🧾 Everything',
  OPEN: '🔵 Open',
  INPROG: '🟡 In Progress',
  DONE: '🟢 Done',
};

function settingKey(guildId) {
  return `tasks_panel_message_id:${guildId}`;
}

async function getPanelCounts(guildId) {
  const tasks = await prisma.task.findMany({ where: { guildId }, select: { status: true } });
  return statusCounts(tasks);
}

function buildPanelEmbed(counts) {
  const embed = new EmbedBuilder()
    .setColor(0xfb923c)
    .setDescription(
      '## 🐦‍🔥 Phoenix of War 973\n\n'
        + `\`📋 Active Tasks: ${counts.active}\`\n`
        + `\`🟡 In Progress: ${counts.inProgress}\`\n`
        + `\`🔵 Open: ${counts.open}\``,
    );

  return embed;
}

const TASK_W = 16;
const ASSIGN_W = 11;
const PROG_W = 7;
const STATUS_W = 9;

function padCell(text, width) {
  const str = typeof text === 'string' ? text : String(text);
  if (str.length > width) return `${str.slice(0, width - 1)}…`;
  return str.padEnd(width);
}

function displayMember(guild, id) {
  if (!id) return '—';
  const member = guild?.members?.cache?.get(id);
  if (member) return `@${(member.nickname || member.user.username).slice(0, 11)}`;
  return `@${id}`;
}

function displayNameColumn(guild, t) {
  const title = padCell(t.title, TASK_W);
  const assignee = padCell(t.assignedTo ? displayMember(guild, t.assignedTo) : '—', ASSIGN_W);
  const status = t.status === 'COMPLETED' ? '🟢 Done' : t.status === 'IN_PROGRESS' ? '🟡 Active' : '🔵 Open';
  return `${title}│${assignee}│${padCell(`${t.progress}%`, PROG_W)}│${status}`;
}

function tableHeader() {
  return `${padCell('TASK', TASK_W)}│${padCell('ASSIGNED', ASSIGN_W)}│${padCell('PROGRESS', PROG_W)}│${padCell('STATUS', STATUS_W)}`;
}

function tableSeparator() {
  return `${'─'.repeat(TASK_W)}┼${'─'.repeat(ASSIGN_W)}┼${'─'.repeat(PROG_W)}┼${'─'.repeat(STATUS_W)}`;
}

function filterTasks(tasks, filter) {
  if (filter === 'OPEN') return tasks.filter((t) => t.status === 'OPEN');
  if (filter === 'INPROG') return tasks.filter((t) => t.status === 'IN_PROGRESS');
  if (filter === 'DONE') return tasks.filter((t) => t.status === 'COMPLETED');
  if (filter === 'ALL') return tasks;
  return tasks.filter((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS');
}

function buildTaskTableEmbed(guild, tasks, page, filter) {
  const list = filterTasks(tasks, filter);
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / TABLE_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = list.slice(safePage * TABLE_PAGE_SIZE, (safePage + 1) * TABLE_PAGE_SIZE);

  const lines = [tableHeader(), tableSeparator()];

  if (slice.length === 0) {
    lines.push(
      filter === 'ACT' ? '(no tasks yet)' : `(no tasks — ${PANEL_FILTER_LABELS[filter] || 'filter'})`,
    );
  } else {
    for (const t of slice) {
      lines.push(displayNameColumn(guild, t));
    }
  }

  const label = PANEL_FILTER_LABELS[filter] || 'Active';
  return new EmbedBuilder()
    .setColor(0xfb923c)
    .addFields({
      name: `📋 Task Board · ${label} · Page ${safePage + 1}/${totalPages}`,
      value: `\`\`\`\n${lines.join('\n')}\n\`\`\``,
    });
}

function actionRowButtons() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('phnxt_open_new')
      .setStyle(ButtonStyle.Success)
      .setLabel('➕ New Task'),
    new ButtonBuilder()
      .setCustomId('phnxt_open_assign')
      .setStyle(ButtonStyle.Primary)
      .setLabel('👤 Assign Task'),
    new ButtonBuilder()
      .setCustomId('phnxt_open_claim')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('🙋 Claim Task'),
    new ButtonBuilder()
      .setCustomId('phnxt_open_sheet')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('📊 View Spreadsheet'),
  );
  return row;
}

function filterButtonsRow(activeFilter) {
  const keys = ['ACT', 'ALL', 'OPEN', 'INPROG', 'DONE'];
  const row = new ActionRowBuilder();
  for (const key of keys) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`phnxt_panel_filter:f${key}`)
        .setStyle(key === activeFilter ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setLabel(PANEL_FILTER_LABELS[key]),
    );
  }
  return row;
}

function paginationButtonsRow(page, totalPages, filter) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`phnxt_panel_prev:p${Math.max(0, page - 1)}:f${filter}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('◀ Prev')
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`phnxt_panel_next:p${Math.min(totalPages - 1, page + 1)}:f${filter}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Next ▶')
      .setDisabled(page >= totalPages - 1),
  );
  return row;
}

async function fetchPanelMessage(client) {
  if (!CONFIG.CHANNELS.TASKS) return null;
  const channel = await client.channels.fetch(CONFIG.CHANNELS.TASKS).catch(() => null);
  if (!channel) return null;

  const key = settingKey(CONFIG.DISCORD.GUILD_ID);
  const stored = await prisma.setting.findUnique({ where: { key } });
  if (!stored) return null;

  const message = await channel.messages.fetch(stored.value).catch(() => null);
  if (!message) return null;

  return message;
}

async function refreshPanelMessage(client, page = 0, filter = DEFAULT_PANEL_FILTER, guildId = CONFIG.DISCORD.GUILD_ID) {
  const message = await fetchPanelMessage(client);
  if (!message) return null;

  const safeFilter = PANEL_FILTER_LABELS[filter] ? filter : DEFAULT_PANEL_FILTER;
  const tasks = await prisma.task.findMany({
    where: { guildId },
    orderBy: { taskNumber: 'asc' },
  });
  const counts = statusCounts(tasks);

  const board = filterTasks(tasks, safeFilter);
  const totalPages = Math.max(1, Math.ceil(board.length / TABLE_PAGE_SIZE));
  const guild = message.channel.guild;

  const components = [
    actionRowButtons(),
    filterButtonsRow(safeFilter),
    paginationButtonsRow(page, totalPages, safeFilter),
  ];

  await message.edit({
    embeds: [buildPanelEmbed(counts), buildTaskTableEmbed(guild, tasks, page, safeFilter)],
    components,
  });

  return totalPages;
}

async function updateTasksPanel(client, guildId = CONFIG.DISCORD.GUILD_ID) {
  return refreshPanelMessage(client, 0, DEFAULT_PANEL_FILTER, guildId);
}

async function ensureTasksPanel(client) {
  if (!CONFIG.CHANNELS.TASKS) {
    console.warn('[TASKS] TASKS_CHANNEL_ID not set — task panel will not be posted.');
    return null;
  }

  const channel = await client.channels.fetch(CONFIG.CHANNELS.TASKS).catch((err) => {
    console.error('[TASKS] Failed to fetch tasks channel:', err.message);
    return null;
  });
  if (!channel) return null;

  const key = settingKey(CONFIG.DISCORD.GUILD_ID);
  const stored = await prisma.setting.findUnique({ where: { key } });

  if (stored) {
    const existing = await channel.messages.fetch(stored.value).catch(() => null);
    if (existing && existing.editable) {
      await updateTasksPanel(client);
      console.log(`[TASKS] Task panel exists, counters refreshed (#${channel.name}).`);
      return existing;
    }
  }

  const tasks = await prisma.task.findMany({
    where: { guildId: CONFIG.DISCORD.GUILD_ID },
    orderBy: { taskNumber: 'asc' },
  });
  const counts = statusCounts(tasks);
  const components = [
    actionRowButtons(),
    filterButtonsRow(DEFAULT_PANEL_FILTER),
    paginationButtonsRow(0, Math.max(1, Math.ceil(counts.active / TABLE_PAGE_SIZE)), DEFAULT_PANEL_FILTER),
  ];

  const message = await channel.send({
    embeds: [
      buildPanelEmbed(counts),
      buildTaskTableEmbed(channel.guild, tasks, 0, DEFAULT_PANEL_FILTER),
    ],
    components,
  });

  await prisma.setting.upsert({
    where: { key },
    update: { value: message.id },
    create: { key, value: message.id },
  });

  console.log(`[TASKS] Task panel created in #${channel.name}.`);
  return message;
}

async function rebuildTasksPanel(client) {
  if (!CONFIG.CHANNELS.TASKS) return { ok: false, error: 'TASKS_CHANNEL_ID is not configured.' };

  const channel = await client.channels.fetch(CONFIG.CHANNELS.TASKS).catch(() => null);
  if (!channel) return { ok: false, error: 'Could not find the tasks channel.' };

  const key = settingKey(CONFIG.DISCORD.GUILD_ID);
  const stored = await prisma.setting.findUnique({ where: { key } });
  if (stored) {
    const existing = await channel.messages.fetch(stored.value).catch(() => null);
    if (existing) await existing.delete().catch(() => {});
  }

  const message = await ensureTasksPanel(client);
  if (!message) return { ok: false, error: 'Could not create the task panel.' };

  return { ok: true, channel: channel.name };
}

module.exports = {
  EPHEMERAL_FLAG,
  DEFAULT_PANEL_FILTER,
  PANEL_FILTER_LABELS,
  buildPanelEmbed,
  buildTaskTableEmbed,
  getPanelCounts,
  ensureTasksPanel,
  updateTasksPanel,
  rebuildTasksPanel,
  refreshPanelMessage,
};