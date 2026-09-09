const prisma = require('../../db');
const { CONFIG } = require('../../config');

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
  const map = { OPEN: 'OPEN', TODO: 'OPEN', 'IN PROGRESS': 'IN_PROGRESS', INPROGRESS: 'IN_PROGRESS', IN_PROGRESS: 'IN_PROGRESS', PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED', DONE: 'COMPLETED', FINISHED: 'COMPLETED' };
  return map[v] || null;
}

function taskTag(task) {
  return `#${String(task.taskNumber).padStart(3, '0')}`;
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

async function nextTaskNumber(guildId) {
  const last = await prisma.task.findFirst({
    where: { guildId },
    orderBy: { taskNumber: 'desc' },
    select: { taskNumber: true },
  });
  return (last?.taskNumber || 0) + 1;
}

async function createTask({ guildId, title, description, createdBy, assignedTo, priority, dueDate }) {
  const taskNumber = await nextTaskNumber(guildId);
  const task = await prisma.task.create({
    data: {
      guildId,
      taskNumber,
      title,
      description: description || null,
      createdBy: createdBy || null,
      assignedTo: assignedTo || null,
      status: assignedTo ? TASK_STATUS.IN_PROGRESS : TASK_STATUS.OPEN,
      priority,
      dueDate: dueDate || null,
    },
  });

  await prisma.taskUpdate.create({
    data: {
      taskId: task.id,
      userId: createdBy || 'system',
      progress: 0,
      status: task.status,
      note: assignedTo
        ? `Task created, assigned to <@${assignedTo}>.`
        : 'Task created, available to claim.',
    },
  });

  return task;
}

async function claimTask(task, userId) {
  if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.IN_PROGRESS) {
    return { ok: false, error: 'This task can no longer be claimed.' };
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { assignedTo: userId, status: TASK_STATUS.IN_PROGRESS },
  });

  await prisma.taskUpdate.create({
    data: {
      taskId: task.id,
      userId,
      progress: task.progress,
      status: TASK_STATUS.IN_PROGRESS,
      note: `Claimed by <@${userId}>.`,
    },
  });

  return { ok: true, task: updated };
}

async function applyTaskUpdate(task, { userId, progress, status, note }) {
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { progress, status },
  });

  await prisma.taskUpdate.create({
    data: { taskId: task.id, userId, progress, status, note: note || null },
  });

  return updated;
}

async function releaseTask(task, { userId, note }) {
  if (task.status === TASK_STATUS.COMPLETED) {
    return { ok: false, error: 'A completed task cannot be released.' };
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { assignedTo: null, status: TASK_STATUS.OPEN, progress: 0 },
  });

  await prisma.taskUpdate.create({
    data: {
      taskId: task.id,
      userId,
      progress: 0,
      status: TASK_STATUS.OPEN,
      note: note ? `Released by <@${userId}>: ${note}` : `Released by <@${userId}>. Back to the pool.`,
    },
  });

  return { ok: true, task: updated };
}

async function completeTask(task, { userId, note }) {
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { progress: 100, status: TASK_STATUS.COMPLETED, completedAt: new Date() },
  });

  await prisma.taskUpdate.create({
    data: {
      taskId: task.id,
      userId,
      progress: 100,
      status: TASK_STATUS.COMPLETED,
      note: note ? `${note}` : null,
    },
  });

  return updated;
}

async function getUpdates(taskId, take = 10) {
  return prisma.taskUpdate.findMany({
    where: { taskId },
    orderBy: { createdAt: 'desc' },
    take,
  });
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
  createTask,
  claimTask,
  applyTaskUpdate,
  releaseTask,
  completeTask,
  getUpdates,
};