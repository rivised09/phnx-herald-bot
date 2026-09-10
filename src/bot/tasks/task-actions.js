const {
  listTasks,
  listArchiveTasks,
  getGuild,
  createTaskInSheet,
  updateTaskInSheet,
  deleteTaskRow,
  archiveTask,
  getTaskUpdates,
  appendTaskUpdate,
} = require('../../sheets');

const TASK_STATUS = { OPEN: 'OPEN', IN_PROGRESS: 'IN_PROGRESS', BLOCKED: 'BLOCKED', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED' };
const TASK_STATUS_LABELS = {
  OPEN: '🔵 Open',
  IN_PROGRESS: '🟡 In Progress',
  BLOCKED: '🔴 Blocked',
  COMPLETED: '✅ Completed',
  CANCELLED: '⛔ Cancelled',
};

function normalizeStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  const map = {
    open: 'OPEN',
    todo: 'OPEN',
    'in progress': 'IN_PROGRESS',
    inprogress: 'IN_PROGRESS',
    progress: 'IN_PROGRESS',
    blocked: 'BLOCKED',
    'on hold': 'BLOCKED',
    completed: 'COMPLETED',
    done: 'COMPLETED',
    finished: 'COMPLETED',
    cancelled: 'CANCELLED',
    canceled: 'CANCELLED',
  };
  return map[v] || null;
}

const UPDATE_STATUSES = ['OPEN', 'IN_PROGRESS', 'BLOCKED'];

function taskTag(task) {
  if (task.id && /^(.+?)(\d{1,5})$/.test(task.id)) return task.id;
  return `#${String(task.taskNumber || task.row || '')}`;
}

function taskLine(task) {
  const assignee = task.assignedTo ? `<@${task.assignedTo}>` : '—';
  const emoji = TASK_STATUS_LABELS[task.status] ? TASK_STATUS_LABELS[task.status].split(' ')[0] : '🔵';
  const line = `${taskTag(task)} **${task.title}** — ${assignee} ${emoji}`;
  return task.dueDate ? `${line} · due ${new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : line;
}

function statusCounts(tasks) {
  return {
    open: tasks.filter((t) => t.status === 'OPEN').length,
    inProgress: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
    blocked: tasks.filter((t) => t.status === 'BLOCKED').length,
    active: tasks.filter((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS' || t.status === 'BLOCKED').length,
    completed: tasks.filter((t) => t.status === 'COMPLETED').length,
    cancelled: tasks.filter((t) => t.status === 'CANCELLED').length,
  };
}

function sheetTasks() {
  return listTasks(getGuild());
}

function archiveTasks() {
  return listArchiveTasks(getGuild());
}

async function findTask(taskId) {
  if (taskId == null) return null;
  const tasks = await sheetTasks();
  const found =
    tasks.find((t) => t.id === taskId) ||
    tasks.find((t) => t.row === taskId) ||
    tasks.find((t) => String(t.row) === String(taskId)) ||
    null;
  if (found) return found;

  const archived = await archiveTasks();
  return (
    archived.find((t) => t.id === taskId) ||
    archived.find((t) => t.row === taskId) ||
    archived.find((t) => String(t.row) === String(taskId)) ||
    null
  );
}

async function createTask({ title, description, createdBy, assignedTo, dueDate }) {
  return createTaskInSheet({ title, description, createdBy, assignedTo, dueDate });
}

async function claimTask(task, userId) {
  if (task.status !== TASK_STATUS.OPEN) {
    return { ok: false, error: 'This task can no longer be claimed.' };
  }

  const updated = await updateTaskInSheet(task.id, {
    assignedTo: userId,
    status: TASK_STATUS.IN_PROGRESS,
  });
  if (!updated) return { ok: false, error: 'That task no longer exists.' };

  await appendTaskUpdate(task.id, {
    userId,
    status: TASK_STATUS.IN_PROGRESS,
    note: `Claimed by <@${userId}>.`,
  });

  return { ok: true, task: updated };
}

async function applyTaskUpdate(task, { userId, status, note }) {
  const updated = await updateTaskInSheet(task.id, { status });
  if (!updated) throw new Error('Task no longer exists.');

  await appendTaskUpdate(task.id, { userId, status, note: note || null });
  return updated;
}

async function assignTaskToUser(task, userId, byUserId) {
  if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CANCELLED) {
    return { ok: false, error: 'A completed or cancelled task cannot be reassigned.' };
  }

  const updated = await updateTaskInSheet(task.id, {
    assignedTo: userId,
    status: TASK_STATUS.IN_PROGRESS,
  });
  if (!updated) return { ok: false, error: 'That task no longer exists.' };

  await appendTaskUpdate(task.id, {
    userId: byUserId || 'system',
    status: TASK_STATUS.IN_PROGRESS,
    note: `Assigned to <@${userId}> by <@${byUserId || 'system'}>.`,
  });

  return { ok: true, task: updated };
}

async function releaseTask(task, { userId, note }) {
  if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CANCELLED) {
    return { ok: false, error: 'A completed or cancelled task cannot be released.' };
  }

  const updated = await updateTaskInSheet(task.id, { assignedTo: null, status: TASK_STATUS.OPEN });
  if (!updated) return { ok: false, error: 'That task no longer exists.' };

  await appendTaskUpdate(task.id, {
    userId,
    status: TASK_STATUS.OPEN,
    note: note ? `Released by <@${userId}>: ${note}` : `Released by <@${userId}>. Back to the pool.`,
  });

  return { ok: true, task: updated };
}

async function editTask(task, { userId, title, description, dueDate }) {
  const patch = {};
  if (title !== undefined) patch.title = title;
  if (description !== undefined) patch.description = description || null;
  if (dueDate !== undefined) patch.dueDate = dueDate;
  if (Object.keys(patch).length === 0) return { ok: true, task };

  const updated = await updateTaskInSheet(task.id, patch);
  if (!updated) return { ok: false, error: 'That task no longer exists.' };

  const changes = [];
  if (patch.title !== undefined) changes.push(`Title: ${patch.title}`);
  if (patch.description !== undefined) changes.push('Description updated');
  if (patch.dueDate !== undefined) {
    changes.push(
      patch.dueDate
        ? `Due: ${new Date(patch.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
        : 'Due date removed',
    );
  }
  await appendTaskUpdate(task.id, {
    userId,
    status: updated.status,
    note: changes.length ? `Edited by <@${userId}>: ${changes.join(', ')}` : `Edited by <@${userId}>.`,
  });

  return { ok: true, task: updated };
}

async function completeTask(task, { userId, note }) {
  const updated = await updateTaskInSheet(task.id, { status: TASK_STATUS.COMPLETED });
  if (!updated) throw new Error('Task no longer exists.');

  await appendTaskUpdate(task.id, {
    userId,
    status: TASK_STATUS.COMPLETED,
    note: note || null,
  });

  const archived = await archiveTask(task.id, note);
  return archived || { ...updated, completedAt: new Date(), note: note || '' };
}

async function getUpdates(taskId, take = 10) {
  const updates = await getTaskUpdates(taskId, getGuild());
  return [...updates].reverse().slice(0, take);
}

async function deleteTask(taskId) {
  await deleteTaskRow(taskId);
  return sheetTasks();
}

module.exports = {
  TASK_STATUS,
  TASK_STATUS_LABELS,
  UPDATE_STATUSES,
  normalizeStatus,
  taskTag,
  taskLine,
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
};