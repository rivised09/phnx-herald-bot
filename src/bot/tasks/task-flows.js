const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const prisma = require('../../db');
const { isLeadershipUser } = require('../../utils/role-check');
const {
  TASK_STATUS,
  TASK_STATUS_LABELS,
  TASK_PRIORITY_LABELS,
  normalizePriority,
  normalizeStatus,
  taskTag,
  statusCounts,
  createTask,
  claimTask,
  applyTaskUpdate,
  releaseTask,
  completeTask,
  getUpdates,
} = require('./task-actions');
const { updateTasksPanel, rebuildTasksPanel } = require('./task-panel');

const EPHEMERAL_FLAG = 64;
const PAGE_SIZE = 10;
const FILTERS = { A: 'ALL', O: 'OPEN', I: 'IN_PROGRESS' };
const FILTER_REVERSE = { ALL: 'A', OPEN: 'O', IN_PROGRESS: 'I' };

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

async function taskCountsEmbed(guildId) {
  const tasks = await prisma.task.findMany({ where: { guildId }, select: { status: true } });
  const counts = statusCounts(tasks);
  return `📋 **Active Tasks:** ${counts.active}  ·  🟡 **In Progress:** ${counts.inProgress}  ·  🔵 **Open:** ${counts.open}  ·  ✅ **Done:** ${counts.completed}`;
}

async function queryBoard(guildId, flow, filter, userId) {
  const where = { guildId };
  if (flow === 'show') {
    if (filter && filter !== 'A') where.status = filter;
    else where.status = { in: [TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS] };
  } else if (flow === 'claim') {
    where.status = TASK_STATUS.OPEN;
    where.assignedTo = null;
  } else if (flow === 'mine') {
    where.assignedTo = userId;
    where.status = { not: TASK_STATUS.COMPLETED };
  } else {
    where.status = TASK_STATUS.COMPLETED;
  }
  return prisma.task.findMany({ where, orderBy: { taskNumber: 'asc' } });
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
        lines.push(`${taskTag(t)} **${t.title}** — ${TASK_PRIORITY_LABELS[t.priority] || t.priority}`);
      } else {
        lines.push(
          `${taskTag(t)} **${t.title}** — ${t.assignedTo ? `<@${t.assignedTo}>` : '—'} · ${t.progress}% ${
            t.status === 'IN_PROGRESS' ? '🟡' : t.status === 'OPEN' ? '🔵' : '✅'
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

  const options = slice.slice(0, 25).map((t) => {
    const description =
      flow === 'claim'
        ? `${TASK_PRIORITY_LABELS[t.priority] || t.priority} priority`
        : flow === 'archive'
          ? `Completed ${shortDate(t.completedAt)}`
          : `${TASK_STATUS_LABELS[t.status]} · ${t.progress}%`;
    return {
      label: `${taskTag(t)} ${t.title}`.slice(0, 100),
      description: description.slice(0, 100),
      value: t.id,
    };
  });

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
  const tasks = await queryBoard(interaction.guild.id, flow, filter, interaction.user.id);
  const payload = renderBoard({ flow, tasks, page, filter });
  await interaction.reply({ flags: EPHEMERAL_FLAG, ...payload });
}

async function rerenderBoard(interaction, flow, page, filter) {
  const tasks = await queryBoard(interaction.guild.id, flow, filter, interaction.user.id);
  const payload = renderBoard({ flow, tasks, page, filter });
  await interaction.update(payload);
}

function buildDetailEmbed(task, updates) {
  const color =
    task.status === 'COMPLETED' ? 0x22c55e : task.status === 'IN_PROGRESS' ? 0xf59e0b : 0x3b82f6;
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
      `📌 **Priority:** ${TASK_PRIORITY_LABELS[task.priority] || task.priority}`,
      `📊 **Status:** ${TASK_STATUS_LABELS[task.status]}`,
      `👤 **Assigned:** ${task.assignedTo ? `<@${task.assignedTo}>` : 'Nobody'}`,
      `🛠️ **Created by:** ${task.createdBy ? `<@${task.createdBy}>` : '—'} · ${shortDate(task.createdAt)}`,
      `📅 **Due:** ${shortDate(task.dueDate)}`,
    ].join('\n'),
  });

  embed.fields.push({
    name: 'Progress',
    value: `${progressBar(task.progress)} ${task.progress}%`,
  });

  if (updates.length > 0) {
    const history = updates
      .slice(0, 6)
      .map((u) => {
        const by = u.userId ? `<@${u.userId}>` : 'system';
        const note = u.note ? `\n> ${u.note.slice(0, 200)}` : '';
        return `**${shortDate(u.createdAt)}** — ${u.progress}% (${by})${note}`;
      })
      .join('\n');
    embed.fields.push({ name: '📜 Progress History', value: history.slice(0, 1024) });
  }

  return embed;
}

async function showDetail(interaction, task, backCustomId, actionRow) {
  const updates = await getUpdates(task.id);
  const components = [];
  if (actionRow) components.push(actionRow);
  if (backCustomId) {
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(backCustomId).setStyle(ButtonStyle.Secondary).setLabel('⬅️ Back to list'),
    );
    components.push(backRow);
  }
  await interaction.update({ embeds: [buildDetailEmbed(task, updates)], components });
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
        '**📌 My Tasks** — Your assignments; update progress, release, or complete.',
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
          .setLabel('Assign To (leave empty to make claimable)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('Paste a user mention or ID'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_priority')
          .setLabel('Priority (Low / Normal / High)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue('Normal'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_due')
          .setLabel('Due Date (YYYY-MM-DD, optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
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
      const task = await prisma.task.findUnique({ where: { id: taskId } });
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

  if (id.startsWith('phnxt_act_update:')) {
    const taskId = id.slice('phnxt_act_update:'.length);
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || (task.assignedTo && task.assignedTo !== interaction.user.id)) {
      await interaction.reply({ content: '⚠️ You can only update your own tasks.', flags: EPHEMERAL_FLAG });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`phnxt_modal_update:${taskId}`)
      .setTitle('📝 Update Task');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_progress')
          .setLabel('Progress (0-100)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(task.progress)),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phnxt_f_status')
          .setLabel('Status (Open / In Progress)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(task.status === 'OPEN' ? 'Open' : 'In Progress'),
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
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || (task.assignedTo && task.assignedTo !== interaction.user.id)) {
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
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || (task.assignedTo && task.assignedTo !== interaction.user.id)) {
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

  await interaction.reply({ content: 'Unknown task action.', flags: EPHEMERAL_FLAG });
}

async function handleTaskSelect(interaction) {
  const id = interaction.customId;
  const taskId = interaction.values?.[0];
  if (!taskId) {
    await interaction.reply({ content: 'No task selected.', flags: EPHEMERAL_FLAG });
    return;
  }
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) {
    await interaction.update({ content: '⚠️ That task no longer exists.', embeds: [], components: [] });
    return;
  }

  if (id.startsWith('phnxt_show_select')) {
    const { page, filter } = parseBoardParts(id);
    const backId = `phnxt_back_show:p${page}:f${filter}`;
    return showDetail(interaction, task, backId, null);
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
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`phnxt_act_update:${task.id}`)
        .setStyle(ButtonStyle.Primary)
        .setLabel('📝 Update'),
      new ButtonBuilder()
        .setCustomId(`phnxt_act_release:${task.id}`)
        .setStyle(ButtonStyle.Danger)
        .setLabel('❌ Release'),
      new ButtonBuilder()
        .setCustomId(`phnxt_act_complete:${task.id}`)
        .setStyle(ButtonStyle.Success)
        .setLabel('✅ Complete'),
      new ButtonBuilder()
        .setCustomId('phnxt_mine_back')
        .setStyle(ButtonStyle.Secondary)
        .setLabel('⬅️ Back'),
    );
    return showDetail(interaction, task, null, actionRow);
  }

  if (id.startsWith('phnxt_archive_select')) {
    const { page } = parseBoardParts(id);
    const backId = `phnxt_back_archive:p${page}`;
    return showDetail(interaction, task, backId, null);
  }

  await interaction.reply({ content: 'Unknown task action.', flags: EPHEMERAL_FLAG });
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
    const priority = normalizePriority(get('phnxt_f_priority'));
    const due = parseDueDate(get('phnxt_f_due'));
    if (due.error) {
      await interaction.reply({ content: `⚠️ ${due.error}`, flags: EPHEMERAL_FLAG });
      return;
    }

    const task = await createTask({
      guildId: interaction.guild.id,
      title,
      description: get('phnxt_f_desc') || null,
      createdBy: interaction.user.id,
      assignedTo: assign.id,
      priority,
      dueDate: due.date,
    });

    const embed = {
      color: 0x22c55e,
      title: '✅ Task Created',
      description: [
        `**${taskTag(task)} ${task.title}**`,
        '',
        `Priority: ${TASK_PRIORITY_LABELS[task.priority]}`,
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

  if (id.startsWith('phnxt_modal_update:')) {
    const taskId = id.slice('phnxt_modal_update:'.length);
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || (task.assignedTo && task.assignedTo !== interaction.user.id)) {
      await interaction.reply({ content: '⚠️ You can only update your own tasks.', flags: EPHEMERAL_FLAG });
      return;
    }

    const progress = Math.floor(Number(get('phnxt_f_progress')));
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      await interaction.reply({ content: '⚠️ Progress must be a number between 0 and 100.', flags: EPHEMERAL_FLAG });
      return;
    }
    const status = normalizeStatus(get('phnxt_f_status'));
    const note = get('phnxt_f_note');

    if (status === TASK_STATUS.COMPLETED || progress === 100) {
      const updated = await completeTask(task, {
        userId: interaction.user.id,
        note: status === TASK_STATUS.COMPLETED ? note : `Completed (progress 100%).${note ? ' ' + note : ''}`,
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
    } else if (status) {
      const updated = await applyTaskUpdate(task, {
        userId: interaction.user.id,
        progress,
        status,
        note: note || null,
      });
      const embed = {
        color: status === 'IN_PROGRESS' ? 0xf59e0b : 0x3b82f6,
        title: '📝 Task Updated',
        description: [
          `**${taskTag(updated)} ${updated.title}**`,
          `Progress: ${progress}%`,
          `Status: ${TASK_STATUS_LABELS[status]}`,
        ].join('\n'),
      };
      await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed] });
    } else {
      await interaction.reply({
        content: '⚠️ Status must be one of: Open, In Progress (or Done to complete).',
        flags: EPHEMERAL_FLAG,
      });
      return;
    }
    await updateTasksPanel(interaction.client);
    return;
  }

  if (id.startsWith('phnxt_modal_release:')) {
    const taskId = id.slice('phnxt_modal_release:'.length);
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || (task.assignedTo && task.assignedTo !== interaction.user.id)) {
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
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || (task.assignedTo && task.assignedTo !== interaction.user.id)) {
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
  return handleTaskButton(interaction);
}

async function taskBoardCommand(interaction) {
  const tasks = await queryBoard(interaction.guild.id, 'show', 'A', interaction.user.id);
  const payload = renderBoard({ flow: 'show', tasks, page: 0, filter: 'A' });
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
      'Use **📌 My Tasks** on the task panel to update progress, release, or complete your assigned tasks.\n\n'
      + 'Use **🙋 Claim Task** to pick an unassigned task.\n\n'
      + 'Use **📚 Archive** to review completed work.',
  };
  await interaction.reply({ flags: EPHEMERAL_FLAG, embeds: [embed] });
}

module.exports = {
  handleTaskInteraction,
  handleTaskModal,
  taskBoardCommand,
  taskSetupCommand,
  openHelpCommand,
  taskCountsEmbed,
};