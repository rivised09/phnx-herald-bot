const {
  listTasks,
  getGuild,
  createTaskInSheet,
  updateTaskInSheet,
  deleteTaskRow,
  getTaskUpdates,
  appendTaskUpdate,
} = require('../../sheets');

const TASK_STATUS = { OPEN: 'OPEN', IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED' };
const TASK_STATUS_LABELS = {
  OPEN: '🔵 Open',
  IN_PROGRESS: '🟡 In Progress',
  COMPLETED: '✅ Completed',
};
const TASK_PRIORITY_LABELS = { LOW: '🟢 Low', NORMAL: '🟡 Normal', HIGH: '🔴 High' };
const TASK_PRIORITY_VALID = ['LOW', 'NORMAL', 'HIGH'];

function normalizePriority(value) {
  const v = String(value || '').trim().toUpperCase();
  const map = { LOW: 'LOW', NORMAL: 'NORMAL', MAX: 'HIGH', HIGH: 'HIGH', CRITICAL: 'HIGH' };
  return map[v] || 'NORMAL';
}

function normalizeStatus(value) {
  const v = String(value || '').trim().toUpperCase();
  const map = {
    OPEN: 'OPEN',
    TODO: 'OPEN',
    'IN PROGRESS': 'IN_PROGRESS',
    INPROGRESS: 'IN_PROGRESS',
    PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    DONE: 'COMPLETED',
    FINISHED: 'COMPLETED',
  };
  return map[v] || null;
}

function taskTag(task) {
  if (task.id && /^T-\d+$/.test(task.id)) return task.id;
  return `T-${String(task.taskNumber).padStart(3, '0')}`;
}

function taskLine(task) {
  const assignee = task.assignedTo ? `<@${task.assignedTo}>` : '—';
  const statusEmoji = task.status === 'COMPLETED' ? '✅' : task.status === 'IN_PROGRESS' ? '🟡' : '🔵';
  return `${taskTag(task)} **${task.title}** — ${assignee} · ${task.progress}% ${statusEmoji}`;
}

function statusCounts(tasks) {
  return {
    open: tasks.filter((t) => t.status === 'OPEN').length,
    inProgress: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
    active: tasks.filter((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS').length,
    completed: tasks.filter((t) => t.status === 'COMPLETED').length,
  };
}

function sheetTasks() {
  return listTasks(getGuild());
}

async function findTask(taskId) {
  if (taskId == null) return null;
  const tasks = await sheetTasks();
  return (
    tasks.find((t) => t.id === taskId) ||
    tasks.find((t) => String(t.taskNumber) === String(taskId)) ||
    null
  );
}

async function createTask({ title, description, createdBy, assignedTo, priority, dueDate }) {
  return createTaskInSheet({ title, description, createdBy, assignedTo, priority, dueDate });
}

async function claimTask(task, userId) {
  if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.IN_PROGRESS) {
    return { ok: false, error: 'This task can no longer be claimed.' };
  }

  const updated = await updateTaskInSheet(task.id, {
    assignedTo: userId,
    status: TASK_STATUS.IN_PROGRESS,
    claimedAt: new Date(),
  });
  if (!updated) return { ok: false, error: 'That task no longer exists.' };

  await appendTaskUpdate(task.id, {
    userId,
    progress: task.progress,
    status: TASK_STATUS.IN_PROGRESS,
    note: `Claimed by <@${userId}>.`,
  });

  return { ok: true, task: updated };
}

async function applyTaskUpdate(task, { userId, progress, status, note }) {
  const updated = await updateTaskInSheet(task.id, { progress, status });
  if (!updated) throw new Error('Task no longer exists.');

  await appendTaskUpdate(task.id, { userId, progress, status, note: note || null });
  return updated;
}

async function assignTaskToUser(task, userId, byUserId) {
  if (task.status === TASK_STATUS.COMPLETED) {
    return { ok: false, error: 'A completed task cannot be reassigned.' };
  }

  const updated = await updateTaskInSheet(task.id, {
    assignedTo: userId,
    status: TASK_STATUS.IN_PROGRESS,
    claimedAt: new Date(),
  });
  if (!updated) return { ok: false, error: 'That task no longer exists.' };

  await appendTaskUpdate(task.id, {
    userId: byUserId || 'system',
    progress: task.progress,
    status: TASK_STATUS.IN_PROGRESS,
    note: `Assigned to <@${userId}> by <@${byUserId || 'system'}>.`,
  });

  return { ok: true, task: updated };
}

async function releaseTask(task, { userId, note }) {
  if (task.status === TASK_STATUS.COMPLETED) {
    return { ok: false, error: 'A completed task cannot be released.' };
  }

  const updated = await updateTaskInSheet(task.id, {
    assignedTo: null,
    status: TASK_STATUS.OPEN,
    progress: 0,
    claimedAt: null,
  });
  if (!updated) return { ok: false, error: 'That task no longer exists.' };

  await appendTaskUpdate(task.id, {
    userId,
    progress: 0,
    status: TASK_STATUS.OPEN,
    note: note ? `Released by <@${userId}>: ${note}` : `Released by <@${userId}>. Back to the pool.`,
  });

  return { ok: true, task: updated };
}

async function completeTask(task, { userId, note }) {
  const updated = await updateTaskInSheet(task.id, {
    progress: 100,
    status: TASK_STATUS.COMPLETED,
    completedAt: new Date(),
    completedBy: userId,
  });
  if (!updated) throw new Error('Task no longer exists.');

  await appendTaskUpdate(task.id, {
    userId,
    progress: 100,
    status: TASK_STATUS.COMPLETED,
    note: note || null,
  });

  return updated;
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
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_VALID,
  normalizePriority,
  normalizeStatus,
  taskTag,
  taskLine,
  statusCounts,
  sheetTasks,
  findTask,
  createTask,
  claimTask,
  assignTaskToUser,
  applyTaskUpdate,
  releaseTask,
  completeTask,
  getUpdates,
  deleteTask,
};