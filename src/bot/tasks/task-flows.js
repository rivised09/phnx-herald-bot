const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { CONFIG } = require('../../config');
const { invalidateAllReadCache } = require('../../sheets');
const { isLeadershipUser } = require('../../utils/role-check');
const {
  TASK_STATUS,
  TASK_STATUS_LABELS,
  UPDATE_STATUSES,
  normalizeStatus,
  taskTag,
  statusCounts,
  sheetTasks,
  archiveTasks,
  findTask,
  createTask,
  claimTask,
  assignTaskToUser,
  applyTaskUpdate,
  releaseTask,
  editTask,
  completeTask,
  getUpdates,
  deleteTask,
} = require('./task-actions');
const { updateTasksPanel, rebuildTasksPanel, refreshPanelMessage } = require('./task-panel');

const EPHEMERAL_FLAG = 64;
const PAGE_SIZE = 10;
const FILTERS = { A: 'ALL', O: 'OPEN', I: 'IN_PROGRESS' };
const FILTER_REVERSE = { ALL: 'A', OPEN: 'O', IN_PROGRESS: 'I' };

const STATUS_PROGRESS = { OPEN: 0, IN_PROGRESS: 50, BLOCKED: 40, COMPLETED: 100, CANCELLED: 0 };

const BOARD_CONFIG = {
  show: { title: '📋 Active Tasks', selectPrefix: 'phnxt_show_select', placeholder: 'Open a task…', filterable: true },
  claim: { title: '🙋 Claim a Task', selectPrefix: 'phnxt_claim_select', placeholder: 'Select a task to claim…', filterable: false },
  mine: { title: '📌 My Tasks', selectPrefix: 'phnxt_mine_select', placeholder: 'Select a task…', filterable: false },
  archive: { title: '📚 Archive', selectPrefix: 'phnxt_archive_select', placeholder: 'View a completed task…', filterable: false },
};

function shortDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function progressBar(p) {
  const filled = Math.round(p / 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function parseBoardParts(customId) {
  const parts = customId.split(':');
  let page = 0;
  let filter = 'A';
  for (const part of parts) {
    if (part.startsWith('p')) page = parseInt(part.slice(1), 10) || 0;
    if (part.startsWith('f')) filter = part.slice(1);
  }
  return { page, filter };
}

function parseAssignee(interaction, raw) {
  const value = String(raw || '').trim();
  if (!value) return { id: null };
  const id = value.replace(/[<@!>]/g, '');
  if (/^\d+$/.test(id)) {
    const member = interaction.guild.members.cache.get(id);
    return member ? { id: member.id } : { error: `Could not find member \`${value}\`.` };
  }
  const member = interaction.guild.members.cache.find(
    (m) => m.user.tag === value || m.user.username === value || (m.nickname && m.nickname === value),
  );
  return member ? { id: member.id } : { error: `Could not find member \`${value}\`.` };
}

function parseDueDate(raw) {
  const value = String(raw || '').trim();
  if (!value) return { date: null };
  const matches = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!matches) return { error: 'Due date must be in YYYY-MM-DD format.' };
  const [year, month, day] = [Number(matches[1]), Number(matches[2]), Number(matches[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return { error: 'Due date looks invalid.' };
  return { date: new Date(Date.UTC(year, month - 1, day)) };
}

async function taskCountsEmbed() {
  const [tasks, archived] = await Promise.all([sheetTasks(), archiveTasks()]);
  const counts = statusCounts(tasks);
  const done = statusCounts(archived).completed;
  return `📋 **Active Tasks:** ${counts.active}  ·  🟡 **In Progress:** ${counts.inProgress}  ·  🔵 **Open:** ${counts.open}  ·  🔴 **Blocked:** ${counts.blocked}  ·  ✅ **Done:** ${done}`;
}

async function queryBoard(flow, filter, userId) {
  if (flow === 'archive') return archiveTasks();
  const tasks = await sheetTasks();
  if (flow === 'show') {
    if (filter && filter !== 'A') return tasks.filter((t) => t.status === filter);
    return tasks.filter((t) => t.status === TASK_STATUS.OPEN || t.status === TASK_STATUS.IN_PROGRESS || t.status === TASK_STATUS.BLOCKED);
  }
  if (flow === 'claim') return tasks.filter((t) => t.status === TASK_STATUS.OPEN && !t.assignedTo);
  return tasks.filter(
    (t) => t.assignedTo === userId && t.status !== TASK_STATUS.COMPLETED && t.status !== TASK_STATUS.CANCELLED,
  );
}

function renderBoard({ flow, tasks, page, filter }) {
  const cfg = BOARD_CONFIG[flow];
  const counts = statusCounts(tasks);
  const total = tasks.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = tasks.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const filterToken = FILTER_REVERSE[filter] || 'A';

  let lines = [`${flow === 'show' ? counts.active : total} task(s) · Page ${safePage + 1} of ${totalPages}`, ''];
  if (total === 0) {
    lines.push(flow === 'claim' ? '**No tasks are available to claim right now.**' : '**Nothing here yet.**');
  } else {
    for (const t of slice) {
      if (flow === 'claim') {
        lines.push(`${taskTag(t)} **${t.title}** — Due ${shortDate(t.dueDate)}`);
      } else {
        lines.push(
          `${taskTag(t)} **${t.title}** — ${t.assignedTo ? `<@${t.assignedTo}>` : '—'} ${
            TASK_STATUS_LABELS[t.status] ? TASK_STATUS_LABELS[t.status].split(' ')[0] : '🔵'
          }`,
        );
      }
    }
  }

  const embed = {
    color: flow === 'archive' ? 0x22c55e : 0xfb923c,
    title: cfg.title,
    description: lines.join('\n'),
  };

  const components = [];

  const options = slice.slice(0, 25).map((t) => ({
    label: `${taskTag(t)} ${t.title}`.slice(0, 100),
    description:
      flow === 'claim'
        ? `Due ${shortDate(t.dueDate)}`.slice(0, 100)
        : `${TASK_STATUS_LABELS[t.status]} · ${t.dueDate ? `Due ${shortDate(t.dueDate)}` : 'No due date'}`.slice(0, 100),
    value: t.id,
  }));

  const selectRow = new ActionRowBuilder();
  if (options.length > 0) {
    selectRow.addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${cfg.selectPrefix}:${flow === 'show' ? `p${safePage}:f${filterToken}` : `p${safePage}`}`)
        .setPlaceholder(cfg.placeholder)
        .setMaxValues(1)
        .addOptions(options),
    );
    components.push(selectRow);
  }

  const navRow = new ActionRowBuilder();

  if (flow === 'show') {
    const filterButtons = ['A', 'O', 'I'].map((key) =>
      new ButtonBuilder()
        .setCustomId(`phnxt_show_filter:f${key}`)
        .setStyle(filterToken === key ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setLabel(key === 'A' ? '📋 All' : key === 'O' ? '🔵 Open' : '🟡 In Progress')
        .setDisabled(filterToken === key),
    );

    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`phnxt_show_prev:p${safePage}:f${filterToken}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('◀')
        .setDisabled(safePage === 0),
      ...filterButtons,
      new ButtonBuilder()
        .setCustomId(`phnxt_show_next:p${safePage}:f${filterToken}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('▶')
        .setDisabled(safePage >= totalPages - 1),
    );
  } else {
    const prefix = `phnxt_${flow}_`;
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}prev:p${safePage}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('◀ Prev')
        .setDisabled(safePage === 0),
      new ButtonBuilder()
        .setCustomId(`${prefix}next:p${safePage}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Next ▶')
        .setDisabled(safePage >= totalPages - 1),
    );
  }

  components.push(navRow);

  return { embeds: [embed], components };
}

async function openBoard(interaction, flow, page = 0, filter = 'A') {
  const tasks = await queryBoard(flow, filter, interaction.user.id);
  const payload = renderBoard({ flow, tasks, page, filter });
  await interaction.reply({ flags: EPHEMERAL_FLAG, ...payload });
}

async function rerenderBoard(interaction, flow, page, filter) {
  const tasks = await queryBoard(flow, filter, interaction.user.id);
  const payload = renderBoard({ flow, tasks, page, filter });
  await interaction.update(payload);
}

function buildDetailEmbed(task, updates) {
  const color =
    task.status === 'COMPLETED' ? 0x22c55e : task.status === 'BLOCKED' ? 0xef4444 : task.status === 'IN_PROGRESS' ? 0xf59e0b : 0x3b82f6;
  const embed = {
    color,
    title: `📋 ${taskTag(task)} ${task.title}`,
    fields: [],
  };

  if (task.description) {
    embed.fields.push({ name: 'Description', value: task.description.slice(0, 1024) });
  }

  embed.fields.push({
    name: 'Details',
    value: [
      `${TASK_STATUS_LABELS[task.status] || task.status}`,
      `👤 ${task.assignedTo ? `<@${task.assignedTo}>` : 'Nobody'}`,
      `📅 ${shortDate(task.dueDate)}`,
    ].join(' · '),
  });

  const history = updates
    .filter((u) => u.createdAt && (u.note || u.status))
    .slice(0, 4)
    .map((u) => {
      const by = u.userId ? `<@${u.userId}>` : 'system';
      return `**${shortDate(u.createdAt)}** — ${u.note || TASK_STATUS_LABELS[u.status] || ''} (${by})`;
    })
    .join('\n');
  if (history) {
    embed.fields.push({ name: 'History', value: history.slice(0, 1024) });
  }

  return embed;
}

async function showDetail(interaction, task, backCustomId, actionRows) {
  const updates = await getUpdates(task.id);
  const components = [];
  if (actionRows) {
    const rows = Array.isArray(actionRows) ? actionRows : [actionRows];
    for (const row of rows) components.push(row);
  }
  if (backCustomId) {
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(backCustomId).setStyle(ButtonStyle.Secondary).setLabel('⬅️ Back to list'),
    );
    components.push(backRow);
  }
  await interaction.update({ embeds: [buildDetailEmbed(task, updates)], components });
}

async function openAssigneeFlow(interaction) {
  const tasks = (await sheetTasks()).filter(
    (t) => t.status === TASK_STATUS.OPEN || t.status === TASK_STATUS.IN_PROGRESS || t.status === TASK_STATUS.BLOCKED,
  );

  if (tasks.length === 0) {
    await interaction.reply({
      content: 'No active tasks to assign.',
      flags: EPHEMERAL_FLAG,
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('phnxt_assign_task_select')
    .setPlaceholder('Pick a task to assign…')
    .setMaxValues(1)
    .addOptions(
      tasks.slice(0, 25).map((t) => ({
        label: `${taskTag(t)} ${t.title}`.slice(0, 100),
        description: `${TASK_STATUS_LABELS[t.status]} · ${t.dueDate ? `Due ${shortDate(t.dueDate)}` : 'No due date'}`.slice(0, 100),
        value: t.id,
      })),
    );

  const row = new ActionRowBuilder().addComponents(select);
  await interaction.reply({
    flags: EPHEMERAL_FLAG,
    embeds: [
      {
        color: 0xfb923c,
        title: '👤 Assign a Task',
        description: 'Select a task, then choose who to assign it to.',
      },
    ],
    components: [row],
  });
}

function userPickRow(customId, placeholder) {
  const row = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder || 'Select a member…')
      .setMaxValues(1),
  );
  return row;
}

async function applyAssignment(interaction, taskId) {
  const task = await findTask(taskId);
  if (!task) {
    await interaction.update({ content: '⚠️ That task no longer exists.', embeds: [], components: [] });
    return;
  }
  if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CANCELLED) {
    await interaction.update({ content: '⚠️ A completed or cancelled task cannot be reassigned.', embeds: [], components: [] });
    return;
  }

  const userId = interaction.values?.[0];
  if (!userId) {
    await interaction.reply({ content: 'No member selected.', flags: EPHEMERAL_FLAG });
    return;
  }

  const result = await assignTaskToUser(task, userId, interaction.user.id);
  if (!result.ok) {
    await interaction.update({ content: `⚠️ ${result.error}`, embeds: [], components: [] });
    return;
  }

  const embed = {
    color: 0x22c55e,
    title: '👤 Task Assigned',
    description: `**${taskTag(result.task)} ${result.task.title}**\n\nNow assigned to <@${userId}> and set to **In Progress**.`,
  };
  await interaction.update({ embeds: [embed], components: [] });
  await updateTasksPanel(interaction.client);
}

async function openEditModal(interaction, task) {
  if (!canManageTask(interaction.member, task)) {
    await interaction.reply({
      content: '⛔ You can only edit your own tasks (leadership can edit any).',
      flags: EPHEMERAL_FLAG,
    });
    return false;
  }
  const modal = new ModalBuilder()
    .setCustomId(`phnxt_modal_edit:${task.id}`)
    .setTitle('✏️ Edit Task');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('phnxt_f_title')
        .setLabel('Task Name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(task.title.slice(0, 100)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('phnxt_f_desc')
        .setLabel('Description')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setValue((task.description || '').slice(0, 1024)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('phnxt_f_due')
        .setLabel('Due Date (YYYY-MM-DD)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : ''),
    ),
  );
  await interaction.showModal(modal);
  return true;
}

async function openCompleteModal(interaction, task) {
  if (!canManageTask(interaction.member, task)) {
    await interaction.reply({
      content: '⛔ You can only complete your own tasks (leadership can complete any).',
      flags: EPHEMERAL_FLAG,
    });
    return false;
  }
  const modal = new ModalBuilder()
    .setCustomId(`phnxt_modal_complete:${task.id}`)
    .setTitle('✅ Complete Task');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('phnxt_f_note')
        .setLabel('Final Note')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false),
    ),
  );
  await interaction.showModal(modal);
  return true;
}

function pickTaskRow(customId, placeholder, tasks) {
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMaxValues(1)
      .addOptions(
        tasks.slice(0, 25).map((t) => ({
          label: `${taskTag(t)} ${t.title}`.slice(0, 100),
          description: `${TASK_STATUS_LABELS[t.status]} · ${t.dueDate ? `Due ${shortDate(t.dueDate)}` : 'No due date'}`.slice(0, 100),
          value: t.id,
        })),
      ),
  );
  return row;
}

async function openTaskPickerFlow(interaction, { customId, placeholder, title, color, filter }) {
  const tasks = (await sheetTasks()).filter(filter);
  if (tasks.length === 0) {
    await interaction.reply({ content: 'No tasks available right now.', flags: EPHEMERAL_FLAG });
    return;
  }
  const row = pickTaskRow(customId, placeholder, tasks);
  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('phnxt_assign_cancel')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('✖️ Cancel'),
  );
  await interaction.reply({
    flags: EPHEMERAL_FLAG,
    embeds: [{ color, title, description: 'Pick a task from the dropdown.' }],
    components: [row, cancelRow],
  });
}

function canManageTask(member, task) {
  return (
    isLeadershipUser(member) ||
    (task.assignedTo != null && task.assignedTo === (member?.id || member?.user?.id || null))
  );
}

async function handleTaskButton(interaction) {
  const id = interaction.customId;

  if (id === 'phnxt_open_help') {
    const embed = {
      color: 0xfb923c,
      title: '❓ PHW Task System Help',
      description: [
        'Welcome to the PHW Task Management System.',
        '',
        '**➕ New Task** — Leadership creates a task; unassigned tasks enter the claim pool.',
        '**📋 Show Tasks** — Browse the active task board.',
        '**🙋 Claim Task** — See tasks available to claim and take one.',
        '**📌 My Tasks** — Your assignments; update status, release, or complete.',
        '**📚 Archive** — Completed tasks and their history.',
      ].join('\n'),
    };
    await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed] });
    return;
  }

  if (id === 'phnxt_open_show') return openBoard(interaction, 'show');
  if (id === 'phnxt_open_claim') return openBoard(interaction, 'claim');
  if (id === 'phnxt_open_mine') return openBoard(interaction, 'mine');
  if (id === 'phnxt_open_archive') return openBoard(interaction, 'archive');

  if (id === 'phnxt_panel_refresh') {
    await interaction.deferUpdate();
    invalidateAllReadCache();
    await updateTasksPanel(interaction.client);
    await interaction
      .followUp({ content: '🔄 Refreshed from the spreadsheet.', flags: EPHEMERAL_FLAG })
      .catch(() => {});
    return;
  }

  if (id.startsWith('phnxt_panel_filter:f')) {
    const filter = id.slice('phnxt_panel_filter:f'.length);
    await interaction.deferUpdate();
    await refreshPanelMessage(interaction.client, 0, filter);
    return;
  }

  if (id.startsWith('phnxt_panel_prev:p') || id.startsWith('phnxt_panel_next:p')) {
    const { page, filter } = parseBoardParts(id);
    const next = id.startsWith('phnxt_panel_next') ? page + 1 : page - 1;
    await interaction.deferUpdate();
    await refreshPanelMessage(interaction.client, next, filter);
    return;
  }

  if (id === 'phnxt_open_sheet') {
    const url = CONFIG.GOOGLE.SPREADSHEET_URL;
    if (!url) {
      await interaction.reply({
        content: '📊 No spreadsheet link configured yet (`SPREADSHEET_URL`).',
        flags: EPHEMERAL_FLAG,
      });
      return;
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('📊 Open Spreadsheet')
        .setURL(url),
    );
    const embed = {
      color: 0xfb923c,
      title: '📊 Task Spreadsheet',
      description: `Here is the link to the PHW task spreadsheet:\n${url}`,
    };
    await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed], components: [row] });
    return;
  }

  if (id === 'phnxt_open_assign') {
    if (!isLeadershipUser(interaction.member)) {
      await interaction.reply({
        content: '⛔ Only leadership can assign tasks.',
        flags: EPHEMERAL_FLAG,
      });
      return;
    }
    return openAssigneeFlow(interaction);
  }

  if (id === 'phnxt_open_delete') {
    if (!isLeadershipUser(interaction.member)) {
      await interaction.reply({
        content: '⛔ Only leadership can delete tasks.',
        flags: EPHEMERAL_FLAG,
      });
      return;
    }
    const all = await sheetTasks();
    if (all.length === 0) {
      await interaction.reply({ content: 'There are no tasks to delete.', flags: EPHEMERAL_FLAG });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId('phnxt_delete_task_select')
      .setPlaceholder('Pick a task to delete…')
      .setMaxValues(1)
      .addOptions(
        all.slice(0, 25).map((t) => ({
          label: `${taskTag(t)} ${t.title}`.slice(0, 100),
          description: `${TASK_STATUS_LABELS[t.status]} · ${t.title}`.slice(0, 100),
          value: t.id,
        })),
      );
    const row = new ActionRowBuilder().addComponents(select);
    await interaction.reply({
      flags: EPHEMERAL_FLAG,
      embeds: [
        {
          color: 0xef4444,
          title: '🗑 Delete a Task',
          description: 'Select a task to delete. This permanently removes it from the board.',
        },
      ],
      components: [row],
    });
    return;
  }

  if (id === 'phnxt_panel_edit') {
    const canAct = (t) =>
      isLeadershipUser(interaction.member) ||
      (t.assignedTo != null && t.assignedTo === interaction.user.id);
    return openTaskPickerFlow(interaction, {
      customId: 'phnxt_panel_edit_select',
      placeholder: 'Pick a task to edit…',
      title: '✏️ Edit a Task',
      color: 0x3b82f6,
      filter: canAct,
    });
  }

  if (id === 'phnxt_panel_complete') {
    const canAct = (t) =>
      t.status !== 'COMPLETED' &&
      t.status !== 'CANCELLED' &&
      (isLeadershipUser(interaction.member) || (t.assignedTo != null && t.assignedTo === interaction.user.id));
    return openTaskPickerFlow(interaction, {
      customId: 'phnxt_panel_complete_select',
      placeholder: 'Pick a task to complete…',
      title: '✅ Mark Complete',
      color: 0x22c55e,
      filter: canAct,
    });
  }

  if (id.startsWith('phnxt_act_delete:')) {
    const taskId = id.slice('phnxt_act_delete:'.length);
    const task = await findTask(taskId);
    if (!task || (task.assignedTo && task.assignedTo !== interaction.user.id)) {
      await interaction.update({ content: '⚠️ You can only delete your own tasks.', embeds: [], components: [] });
      return;
    }
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`phnxt_delete_yes:${task.id}`)
        .setStyle(ButtonStyle.Danger)
        .setLabel('🗑 Yes, Delete'),
      new ButtonBuilder()
        .setCustomId('phnxt_delete_no')
        .setStyle(ButtonStyle.Secondary)
        .setLabel('✖️ Cancel'),
    );
    return showDetail(interaction, task, null, confirmRow);
  }

  if (id === 'phnxt_delete_no') {
    await interaction.update({ content: '✖️ Deletion cancelled.', embeds: [], components: [] });
    return;
  }

  if (id.startsWith('phnxt_delete_yes:')) {
    const taskId = id.slice('phnxt_delete_yes:'.length);
    const task = await findTask(taskId);
    if (!task) {
      await interaction.update({ content: '⚠️ That task no longer exists.', embeds: [], components: [] });
      return;
    }
    const isLead = isLeadershipUser(interaction.member);
    if (!isLead && (!task.assignedTo || task.assignedTo !== interaction.user.id)) {
      await interaction.update({ content: '⛔ You do not have permission to delete this task.', embeds: [], components: [] });
      return;
    }
    const deleted = `${taskTag(task)} ${task.title}`;
    await deleteTask(task.id);
    await interaction.update({
      embeds: [
        {
          color: 0xef4444,
          title: '🗑 Task Deleted',
          description: `**${deleted}**\n\nTask permanently removed from the board.`,
        },
      ],
      components: [],
    });
    await updateTasksPanel(interaction.client);
    return;
  }

  if (id === 'phnxt_assign_cancel') {
    await interaction.update({ content: '✖️ Assignment cancelled.', embeds: [], components: [] });
    return;
  }

  if (id === 'phnxt_new_skip') {
    await interaction.update({
      embeds: [
        {
          color: 0x22c55e,
          title: '✅ Task Created',
          description: 'Task was kept unassigned and is now available for members to claim.',
        },
      ],
      components: [],
    });
    return;
  }

  if (id === 'phnxt_open_new') {
    if (!isLeadershipUser(interaction.member)) {
      await interaction.reply({
        content: '⛔ Only leadership can create new tasks.',
        flags: EPHEMERAL_FLAG,
      });
      return;
    }

    const modal = new ModalBuilder().setCustomId('phnxt_modal_new').setTitle('➕ New Task');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_title')
          .setLabel('Task Name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_desc')
          .setLabel('Description')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_assign')
          .setLabel('Assign To (leave blank to pick)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('Type a name/ID, or leave blank for the user picker'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_due')
          .setLabel('Due Date (leave blank for none)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('YYYY-MM-DD'),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === 'phnxt_no') {
    await interaction.update({ content: '✖️ Action cancelled.', embeds: [], components: [] });
    return;
  }

  if (id.startsWith('phnxt_show_')) {
    if (id.startsWith('phnxt_show_filter:f')) {
      const filter = id.slice('phnxt_show_filter:f'.length);
      return rerenderBoard(interaction, 'show', 0, FILTERS[filter]);
    }
    const { page, filter } = parseBoardParts(id);
    if (id.startsWith('phnxt_show_prev')) return rerenderBoard(interaction, 'show', page - 1, FILTERS[filter]);
    if (id.startsWith('phnxt_show_next')) return rerenderBoard(interaction, 'show', page + 1, FILTERS[filter]);
  }

  if (id.startsWith('phnxt_claim_')) {
    const { page } = parseBoardParts(id);
    if (id.startsWith('phnxt_claim_prev')) return rerenderBoard(interaction, 'claim', page - 1);
    if (id.startsWith('phnxt_claim_next')) return rerenderBoard(interaction, 'claim', page + 1);

    if (id.startsWith('phnxt_claim_yes:')) {
      const taskId = id.slice('phnxt_claim_yes:'.length);
      const task = await findTask(taskId);
      if (!task) {
        await interaction.update({ content: '⚠️ That task no longer exists.', embeds: [], components: [] });
        return;
      }
      if (task.assignedTo && task.assignedTo !== interaction.user.id) {
        await interaction.update({ content: '⚠️ That task was already claimed by someone else.', embeds: [], components: [] });
        return;
      }
      const result = await claimTask(task, interaction.user.id);
      if (!result.ok) {
        await interaction.update({ content: `⚠️ ${result.error}`, embeds: [], components: [] });
        return;
      }
      const claimed = result.task;
      const embed = {
        color: 0x22c55e,
        title: '✅ Task Claimed',
        description: [
          `**${taskTag(claimed)} ${claimed.title}**`,
          '',
          `Now assigned to <@${interaction.user.id}>.`,
          'You can track it under **📌 My Tasks**.',
        ].join('\n'),
      };
      const myRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('phnxt_open_mine')
          .setStyle(ButtonStyle.Primary)
          .setLabel('📌 View My Tasks'),
      );
      await interaction.update({ embeds: [embed], components: [myRow] });
      await updateTasksPanel(interaction.client);
      return;
    }
  }

  if (id.startsWith('phnxt_mine_')) {
    const { page } = parseBoardParts(id);
    if (id.startsWith('phnxt_mine_prev')) return rerenderBoard(interaction, 'mine', page - 1);
    if (id.startsWith('phnxt_mine_next')) return rerenderBoard(interaction, 'mine', page + 1);
    if (id === 'phnxt_mine_back') return rerenderBoard(interaction, 'mine', 0);
  }

  if (id.startsWith('phnxt_archive_')) {
    const { page } = parseBoardParts(id);
    if (id.startsWith('phnxt_archive_prev')) return rerenderBoard(interaction, 'archive', page - 1);
    if (id.startsWith('phnxt_archive_next')) return rerenderBoard(interaction, 'archive', page + 1);
    if (id.startsWith('phnxt_back_archive')) return rerenderBoard(interaction, 'archive', page);
  }

  if (id.startsWith('phnxt_back_show')) {
    const { page, filter } = parseBoardParts(id);
    return rerenderBoard(interaction, 'show', page, FILTERS[filter]);
  }

  if (id.startsWith('phnxt_back_claim')) {
    const { page } = parseBoardParts(id);
    return rerenderBoard(interaction, 'claim', page);
  }

  if (id.startsWith('phnxt_act_edit:')) {
    const taskId = id.slice('phnxt_act_edit:'.length);
    const task = await findTask(taskId);
    if (!task) {
      await interaction.reply({ content: '⚠️ That task no longer exists.', flags: EPHEMERAL_FLAG });
      return;
    }
    await openEditModal(interaction, task);
    return;
  }

  if (id.startsWith('phnxt_act_update:')) {
    const taskId = id.slice('phnxt_act_update:'.length);
    const task = await findTask(taskId);
    if (!task || (!isLeadershipUser(interaction.member) && task.assignedTo && task.assignedTo !== interaction.user.id)) {
      await interaction.reply({ content: '⚠️ You can only update your own tasks.', flags: EPHEMERAL_FLAG });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`phnxt_modal_update:${taskId}`)
      .setTitle('📝 Update Task');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_status')
          .setLabel('Status (Open / In Progress / Blocked)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(task.status === 'OPEN' ? 'Open' : task.status === 'BLOCKED' ? 'Blocked' : 'In Progress'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_note')
          .setLabel('Progress Note')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id.startsWith('phnxt_act_release:')) {
    const taskId = id.slice('phnxt_act_release:'.length);
    const task = await findTask(taskId);
    if (!task || (!isLeadershipUser(interaction.member) && task.assignedTo && task.assignedTo !== interaction.user.id)) {
      await interaction.reply({ content: '⚠️ You can only release your own tasks.', flags: EPHEMERAL_FLAG });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`phnxt_modal_release:${taskId}`)
      .setTitle('❌ Release Task');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_reason')
          .setLabel('Reason')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id.startsWith('phnxt_act_complete:')) {
    const taskId = id.slice('phnxt_act_complete:'.length);
    const task = await findTask(taskId);
    if (!task || (!isLeadershipUser(interaction.member) && task.assignedTo && task.assignedTo !== interaction.user.id)) {
      await interaction.reply({ content: '⚠️ You can only complete your own tasks.', flags: EPHEMERAL_FLAG });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`phnxt_modal_complete:${taskId}`)
      .setTitle('✅ Complete Task');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_note')
          .setLabel('Final Note')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id.startsWith('phnxt_assign_reassign:')) {
    const taskId = id.slice('phnxt_assign_reassign:'.length);
    const task = await findTask(taskId);
    if (!task) {
      await interaction.update({ content: '⚠️ That task no longer exists.', embeds: [], components: [] });
      return;
    }
    const updates = await getUpdates(task.id);
    const userRow = userPickRow(`phnxt_assign_user:${task.id}`, 'Select the new assignee…');
    const cancelRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('phnxt_assign_cancel')
        .setStyle(ButtonStyle.Secondary)
        .setLabel('✖️ Cancel'),
    );
    await interaction.update({
      embeds: [buildDetailEmbed(task, updates)],
      components: [userRow, cancelRow],
    });
    return;
  }

  if (id.startsWith('phnxt_assign_remove:')) {
    const taskId = id.slice('phnxt_assign_remove:'.length);
    if (!isLeadershipUser(interaction.member)) {
      await interaction.update({ content: '⛔ Only leadership can modify assignments.', embeds: [], components: [] });
      return;
    }
    const task = await findTask(taskId);
    if (!task) {
      await interaction.update({ content: '⚠️ That task no longer exists.', embeds: [], components: [] });
      return;
    }
    const result = await releaseTask(task, {
      userId: interaction.user.id,
      note: 'Assignment removed by leadership.',
    });
    if (!result.ok) {
      await interaction.update({ content: `⚠️ ${result.error}`, embeds: [], components: [] });
      return;
    }
    const embed = {
      color: 0xf59e0b,
      title: '🚫 Assignment Removed',
      description: `**${taskTag(result.task)} ${result.task.title}**\n\nThe task is **Open** again and available to claim or reassign.`,
    };
    await interaction.update({ embeds: [embed], components: [] });
    await updateTasksPanel(interaction.client);
    return;
  }

  await interaction.reply({ content: 'Unknown task action.', flags: EPHEMERAL_FLAG });
}

async function handleTaskSelect(interaction) {
  const id = interaction.customId;
  const taskId = interaction.values?.[0];
  if (!taskId) {
    await interaction.reply({ content: 'No task selected.', flags: EPHEMERAL_FLAG });
    return;
  }
  const task = await findTask(taskId);
  if (!task) {
    await interaction.update({ content: '⚠️ That task no longer exists.', embeds: [], components: [] });
    return;
  }

  if (id === 'phnxt_panel_edit_select') {
    await openEditModal(interaction, task);
    return;
  }

  if (id === 'phnxt_panel_complete_select') {
    await openCompleteModal(interaction, task);
    return;
  }

  if (id.startsWith('phnxt_show_select')) {
    const { page, filter } = parseBoardParts(id);
    const backId = `phnxt_back_show:p${page}:f${filter}`;
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`phnxt_act_edit:${task.id}`)
        .setStyle(ButtonStyle.Primary)
        .setLabel('✏️ Edit'),
      new ButtonBuilder()
        .setCustomId(`phnxt_act_complete:${task.id}`)
        .setStyle(ButtonStyle.Success)
        .setLabel('✅ Mark Complete'),
    );
    return showDetail(interaction, task, backId, actionRow);
  }

  if (id.startsWith('phnxt_claim_select')) {
    const { page } = parseBoardParts(id);
    if (task.status !== 'OPEN' || task.assignedTo) {
      await interaction.update({ content: '⚠️ That task is no longer available to claim.', embeds: [], components: [] });
      return;
    }
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`phnxt_claim_yes:${task.id}`)
        .setStyle(ButtonStyle.Success)
        .setLabel('🙋 Claim Task'),
      new ButtonBuilder()
        .setCustomId(`phnxt_back_claim:p${page}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('✖️ Cancel'),
    );
    return showDetail(interaction, task, null, confirmRow);
  }

  if (id.startsWith('phnxt_mine_select')) {
    if (task.assignedTo !== interaction.user.id) {
      await interaction.update({ content: '⚠️ This task is not assigned to you.', embeds: [], components: [] });
      return;
    }
    const actionRows = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`phnxt_act_edit:${task.id}`)
          .setStyle(ButtonStyle.Primary)
          .setLabel('✏️ Edit'),
        new ButtonBuilder()
          .setCustomId(`phnxt_act_update:${task.id}`)
          .setStyle(ButtonStyle.Primary)
          .setLabel('📝 Update'),
        new ButtonBuilder()
          .setCustomId(`phnxt_act_release:${task.id}`)
          .setStyle(ButtonStyle.Danger)
          .setLabel('❌ Release'),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`phnxt_act_complete:${task.id}`)
          .setStyle(ButtonStyle.Success)
          .setLabel('✅ Mark Complete'),
        new ButtonBuilder()
          .setCustomId(`phnxt_act_delete:${task.id}`)
          .setStyle(ButtonStyle.Danger)
          .setLabel('🗑 Delete'),
        new ButtonBuilder()
          .setCustomId('phnxt_mine_back')
          .setStyle(ButtonStyle.Secondary)
          .setLabel('⬅️ Back'),
      ),
    ];
    return showDetail(interaction, task, null, actionRows);
  }

  if (id.startsWith('phnxt_archive_select')) {
    const { page } = parseBoardParts(id);
    const backId = `phnxt_back_archive:p${page}`;
    return showDetail(interaction, task, backId, null);
  }

  if (id.startsWith('phnxt_delete_task_select')) {
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`phnxt_delete_yes:${task.id}`)
        .setStyle(ButtonStyle.Danger)
        .setLabel('🗑 Yes, Delete'),
      new ButtonBuilder()
        .setCustomId('phnxt_delete_no')
        .setStyle(ButtonStyle.Secondary)
        .setLabel('✖️ Cancel'),
    );
    return showDetail(interaction, task, null, confirmRow);
  }

  if (id === 'phnxt_assign_task_select') {
    const updates = await getUpdates(task.id);

    if (task.assignedTo) {
      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`phnxt_assign_remove:${task.id}`)
          .setStyle(ButtonStyle.Danger)
          .setLabel('🚫 Remove Assignment'),
        new ButtonBuilder()
          .setCustomId(`phnxt_assign_reassign:${task.id}`)
          .setStyle(ButtonStyle.Primary)
          .setLabel('🔁 Reassign'),
        new ButtonBuilder()
          .setCustomId('phnxt_assign_cancel')
          .setStyle(ButtonStyle.Secondary)
          .setLabel('✖️ Cancel'),
      );
      await interaction.update({
        embeds: [buildDetailEmbed(task, updates)],
        components: [actionRow],
      });
      return;
    }

    const userRow = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`phnxt_assign_user:${task.id}`)
        .setPlaceholder('Search a member to assign…')
        .setMaxValues(1),
    );
    const cancelRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('phnxt_assign_cancel')
        .setStyle(ButtonStyle.Secondary)
        .setLabel('✖️ Cancel'),
    );
    await interaction.update({
      embeds: [buildDetailEmbed(task, updates)],
      components: [userRow, cancelRow],
    });
    return;
  }

  await interaction.reply({ content: 'Unknown task action.', flags: EPHEMERAL_FLAG });
}

async function handleUserSelect(interaction) {
  const id = interaction.customId;
  if (id.startsWith('phnxt_assign_user:')) {
    const taskId = id.slice('phnxt_assign_user:'.length);
    return applyAssignment(interaction, taskId);
  }
  if (id.startsWith('phnxt_new_assign:')) {
    const taskId = id.slice('phnxt_new_assign:'.length);
    const task = await findTask(taskId);
    if (!task) {
      await interaction.reply({ content: '⚠️ That task no longer exists.', flags: EPHEMERAL_FLAG });
      return;
    }
    const result = await assignTaskToUser(task, interaction.values?.[0], interaction.user.id);
    if (!result.ok) {
      await interaction.update({ content: `⚠️ ${result.error}`, embeds: [], components: [] });
      return;
    }
    const embed = {
      color: 0x22c55e,
      title: '👤 Task Assigned',
      description: `**${taskTag(result.task)} ${result.task.title}**\n\nNow assigned to <@${result.task.assignedTo}> and set to **In Progress**.`,
    };
    await interaction.update({ embeds: [embed], components: [] });
    await updateTasksPanel(interaction.client);
    return;
  }
  await interaction.reply({ content: 'Unknown action.', flags: EPHEMERAL_FLAG });
}

async function handleTaskModal(interaction) {
  const id = interaction.customId;
  const fields = interaction.fields;

  const get = (name) => fields.getTextInputValue(name).trim();

  if (id === 'phnxt_modal_new') {
    if (!isLeadershipUser(interaction.member)) {
      await interaction.reply({ content: '⛔ Only leadership can create tasks.', flags: EPHEMERAL_FLAG });
      return;
    }
    const title = get('phnxt_f_title');
    if (!title) {
      await interaction.reply({ content: '⚠️ Task name is required.', flags: EPHEMERAL_FLAG });
      return;
    }

    const assign = parseAssignee(interaction, get('phnxt_f_assign'));
    if (assign.error) {
      await interaction.reply({ content: `⚠️ ${assign.error}`, flags: EPHEMERAL_FLAG });
      return;
    }
    const due = parseDueDate(get('phnxt_f_due'));
    if (due.error) {
      await interaction.reply({ content: `⚠️ ${due.error}`, flags: EPHEMERAL_FLAG });
      return;
    }

    const task = await createTask({
      title,
      description: get('phnxt_f_desc') || null,
      createdBy: interaction.user.id,
      assignedTo: assign.id,
      dueDate: due.date,
    });

    if (!task.assignedTo) {
      const pickerEmbed = {
        color: 0xfb923c,
        title: '✅ Task Created',
        description: [
          `**${taskTag(task)} ${task.title}**`,
          '',
          'Created unassigned and available to claim.',
          '',
          'Want to assign it to a member now? Use the picker below (searchable).',
        ].join('\n'),
      };
      const userRow = userPickRow(`phnxt_new_assign:${task.id}`, 'Search a member to assign…');
      const skipRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('phnxt_new_skip')
          .setStyle(ButtonStyle.Secondary)
          .setLabel('Skip — leave in pool'),
      );
      await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [pickerEmbed], components: [userRow, skipRow] });
      await updateTasksPanel(interaction.client);
      return;
    }

    const embed = {
      color: 0x22c55e,
      title: '✅ Task Created',
      description: [
        `**${taskTag(task)} ${task.title}**`,
        '',
        `Status: ${TASK_STATUS_LABELS[task.status]}`,
        `Assigned to: ${task.assignedTo ? `<@${task.assignedTo}>` : '💼 Available to claim'}`,
        task.dueDate ? `Due: ${shortDate(task.dueDate)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
    await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed] });
    await updateTasksPanel(interaction.client);
    return;
  }

  if (id.startsWith('phnxt_modal_edit:')) {
    const taskId = id.slice('phnxt_modal_edit:'.length);
    const task = await findTask(taskId);
    if (!task) {
      await interaction.reply({ content: '⚠️ This task no longer exists.', flags: EPHEMERAL_FLAG });
      return;
    }
    const title = get('phnxt_f_title');
    if (!title) {
      await interaction.reply({ content: '⚠️ Task name is required.', flags: EPHEMERAL_FLAG });
      return;
    }
    const description = get('phnxt_f_desc') || null;
    const dueRaw = get('phnxt_f_due');
    let dueDate = task.dueDate;
    if (dueRaw) {
      const due = parseDueDate(dueRaw);
      if (due.error) {
        await interaction.reply({ content: `⚠️ ${due.error}`, flags: EPHEMERAL_FLAG });
        return;
      }
      dueDate = due.date;
    } else {
      dueDate = null;
    }

    const result = await editTask(task, { userId: interaction.user.id, title, description, dueDate });
    if (!result.ok) {
      await interaction.reply({ content: `⚠️ ${result.error}`, flags: EPHEMERAL_FLAG });
      return;
    }
    const embed = {
      color: 0x3b82f6,
      title: '✏️ Task Edited',
      description: `**${taskTag(result.task)} ${result.task.title}**\n\n${description ? description.slice(0, 512) : ''}`.trim(),
    };
    await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed] });
    await updateTasksPanel(interaction.client);
    return;
  }

  if (id.startsWith('phnxt_modal_update:')) {
    const taskId = id.slice('phnxt_modal_update:'.length);
    const task = await findTask(taskId);
    if (!task || (!isLeadershipUser(interaction.member) && task.assignedTo && task.assignedTo !== interaction.user.id)) {
      await interaction.reply({ content: '⚠️ You can only update your own tasks.', flags: EPHEMERAL_FLAG });
      return;
    }

    const status = normalizeStatus(get('phnxt_f_status'));
    const note = get('phnxt_f_note');

    if (status === TASK_STATUS.COMPLETED) {
      const updated = await completeTask(task, {
        userId: interaction.user.id,
        note: note || 'Completed via status update.',
      });
      const embed = {
        color: 0x22c55e,
        title: '✅ Task Completed',
        description: [
          `**${taskTag(updated)} ${updated.title}**`,
          '',
          `Completed by <@${interaction.user.id}> · ${shortDate(updated.completedAt)}`,
          'Moved to the 📚 Archive.',
        ].join('\n'),
      };
      await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed] });
    } else if (status === TASK_STATUS.CANCELLED) {
      await interaction.reply({
        content: '⚠️ To cancel a task use the spreadsheet (Status = Cancelled).',
        flags: EPHEMERAL_FLAG,
      });
      return;
    } else if (status && UPDATE_STATUSES.includes(status)) {
      const updated = await applyTaskUpdate(task, { userId: interaction.user.id, status, note: note || null });
      const embed = {
        color: status === 'IN_PROGRESS' ? 0xf59e0b : status === 'BLOCKED' ? 0xef4444 : 0x3b82f6,
        title: '📝 Task Updated',
        description: [
          `**${taskTag(updated)} ${updated.title}**`,
          `Status: ${TASK_STATUS_LABELS[status]}`,
        ].join('\n'),
      };
      await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed] });
    } else {
      await interaction.reply({
        content: '⚠️ Status must be one of: Open, In Progress, Blocked (or Done to complete).',
        flags: EPHEMERAL_FLAG,
      });
      return;
    }
    await updateTasksPanel(interaction.client);
    return;
  }

  if (id.startsWith('phnxt_modal_release:')) {
    const taskId = id.slice('phnxt_modal_release:'.length);
    const task = await findTask(taskId);
    if (!task || (!isLeadershipUser(interaction.member) && task.assignedTo && task.assignedTo !== interaction.user.id)) {
      await interaction.reply({ content: '⚠️ You can only release your own tasks.', flags: EPHEMERAL_FLAG });
      return;
    }
    const result = await releaseTask(task, {
      userId: interaction.user.id,
      note: get('phnxt_f_reason') || null,
    });
    if (!result.ok) {
      await interaction.reply({ content: `⚠️ ${result.error}`, flags: EPHEMERAL_FLAG });
      return;
    }
    const embed = {
      color: 0xf59e0b,
      title: '⚠️ Task Released',
      description: [
        `**${taskTag(result.task)} ${result.task.title}**`,
        '',
        'The task is **Open** again and available for anyone to claim.',
      ].join('\n'),
    };
    await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed] });
    await updateTasksPanel(interaction.client);
    return;
  }

  if (id.startsWith('phnxt_modal_complete:')) {
    const taskId = id.slice('phnxt_modal_complete:'.length);
    const task = await findTask(taskId);
    if (!task || (!isLeadershipUser(interaction.member) && task.assignedTo && task.assignedTo !== interaction.user.id)) {
      await interaction.reply({ content: '⚠️ You can only complete your own tasks.', flags: EPHEMERAL_FLAG });
      return;
    }
    const updated = await completeTask(task, {
      userId: interaction.user.id,
      note: get('phnxt_f_note') || null,
    });
    const embed = {
      color: 0x22c55e,
      title: '✅ Task Completed',
      description: [
        `**${taskTag(updated)} ${updated.title}**`,
        '',
        `Completed by <@${interaction.user.id}> · ${shortDate(updated.completedAt)}`,
        'The task has been moved to the 📚 Archive.',
      ].join('\n'),
    };
    await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed] });
    await updateTasksPanel(interaction.client);
    return;
  }

  await interaction.reply({ content: 'Unknown task form.', flags: EPHEMERAL_FLAG });
}

async function handleTaskInteraction(interaction) {
  if (interaction.isStringSelectMenu()) return handleTaskSelect(interaction);
  if (interaction.isUserSelectMenu()) return handleUserSelect(interaction);
  return handleTaskButton(interaction);
}

async function taskBoardCommand(interaction) {
  const tasks = await queryBoard('show', 'A', interaction.user.id);
  const payload = renderBoard({ flow: 'show', tasks, page: 0, filter: 'A' });
  await interaction.reply({ flags: EPHEMERAL_FLAG, ...payload });
}

async function taskMyTasksCommand(interaction) {
  const tasks = await queryBoard('mine', 'A', interaction.user.id);
  const payload = renderBoard({ flow: 'mine', tasks, page: 0, filter: 'A' });
  await interaction.reply({ flags: EPHEMERAL_FLAG, ...payload });
}

async function taskSetupCommand(interaction) {
  if (!isLeadershipUser(interaction.member)) {
    await interaction.reply({ content: '⛔ This command is for leadership only.', flags: EPHEMERAL_FLAG });
    return;
  }
  const result = await rebuildTasksPanel(interaction.client);
  if (!result.ok) {
    await interaction.reply({ content: `⚠️ ${result.error}`, flags: EPHEMERAL_FLAG });
    return;
  }
  await interaction.reply({
    content: `✅ Task panel rebuilt in #${result.channel}.`,
    flags: EPHEMERAL_FLAG,
  });
}

async function openHelpCommand(interaction) {
  const embed = {
    color: 0xfb923c,
    title: '❓ PHW Task System Help',
    description:
      'The **task board** below the panel header updates automatically.\n\n'
      + '**➕ New Task** — Leadership creates a task (can pick the assignee live).\n'
      + '**👤 Assign Task** — Leadership assigns an existing task to a member.\n'
      + '**🙋 Claim Task** — Claim an open task for yourself.\n'
      + '**📊 View Spreadsheet** — Open the task google sheet.\n\n'
      + 'Manage your own tasks (status updates, release, complete) with `/phnx-mytasks`.',
  };
  await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed] });
}

module.exports = {
  handleTaskInteraction,
  handleTaskModal,
  taskBoardCommand,
  taskMyTasksCommand,
  taskSetupCommand,
  openHelpCommand,
  taskCountsEmbed,
};