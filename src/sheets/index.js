const crypto = require('crypto');
const prisma = require('../db');
const { CONFIG } = require('../config');

const TASKS_HEADERS = [
  'Task ID',
  'Task',
  'Description',
  'Created By',
  'Assigned To',
  'Priority',
  'Status',
  'Progress',
  'Created At',
  'Claimed At',
  'Due Date',
  'Completed At',
  'Completed By',
];

const UPDATES_HEADERS = ['Update ID', 'Task ID', 'Updated By', 'Progress', 'Status', 'Note', 'Timestamp'];

const MEMBERS_HEADERS = ['Discord ID', 'Username', 'Nickname', 'Display Name', 'Roles', 'Active'];

const SHEETS = [
  { title: 'TASKS', headers: TASKS_HEADERS },
  { title: 'Task Updates', headers: UPDATES_HEADERS },
  { title: 'MEMBERS', headers: MEMBERS_HEADERS },
];

let client = null;
let cachedToken = { access_token: null, expires_at: 0 };

function setClient(botClient) {
  client = botClient;
}

function isConfigured() {
  return Boolean(CONFIG.GOOGLE.SPREADSHEET_ID && CONFIG.GOOGLE.SERVICE_ACCOUNT);
}

function quoteSheet(title) {
  return title.includes(' ') ? `'${title}'` : title;
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signJwt(claim, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const sig = crypto.createSign('RSA-SHA256').update(signingInput).end().sign(privateKey);
  return `${signingInput}.${base64url(sig)}`;
}

async function getAccessToken() {
  if (!isConfigured()) {
    throw new Error('Google Sheets is not configured (missing SPREADSHEET_ID or service account).');
  }
  if (cachedToken.access_token && cachedToken.expires_at > Date.now() + 60000) {
    return cachedToken.access_token;
  }

  const sa = CONFIG.GOOGLE.SERVICE_ACCOUNT;
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    sa.private_key,
  );

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google token error ${res.status}: ${JSON.stringify(data)}`);
  }

  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return data.access_token;
}

async function sheetsRequest(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.GOOGLE.SPREADSHEET_ID}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) {
    throw new Error(`Sheets API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function readValues(sheet, range) {
  const data = await sheetsRequest(
    `/values/${quoteSheet(sheet)}!${range}?valueRenderOption=UNFORMATTED_VALUE`,
  );
  return data.values || [];
}

async function writeValues(sheet, range, values) {
  await sheetsRequest(`/values/${quoteSheet(sheet)}!${range}?valueInputOption=RAW`, {
    method: 'PUT',
    body: { values },
  });
}

async function clearValues(sheet, range) {
  await sheetsRequest(`/values/${quoteSheet(sheet)}!${range}:clear`, { method: 'POST', body: {} });
}

async function appendRow(title, values) {
  const res = await sheetsRequest(
    `/values/${quoteSheet(title)}!A3:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: { values: [values] } },
  );
  return res.updates?.updatedRange || '';
}

async function migrateLegacyLayout() {
  if (!isConfigured()) return;
  for (const { title, headers } of SHEETS) {
    const a1 = await readValues(title, 'A1:A1');
    if (a1.length === 0 || a1[0][0] !== headers[0]) continue;

    const endCol = String.fromCharCode(64 + headers.length);
    const old = await readValues(title, `A2:${endCol}1000`);
    const data = old.filter((r) => r.some((c) => c !== '' && c != null));

    await clearValues(title, `A1:${endCol}1000`);
    await writeValues(title, `A2:${endCol}2`, [headers]);
    if (data.length > 0) {
      await writeValues(title, `A3:${endCol}${2 + data.length}`, data);
    }
  }
}

async function ensureHeaders() {
  if (!isConfigured()) return;
  for (const { title, headers } of SHEETS) {
    const existing = await readValues(title, 'A2:A2');
    if (existing.length > 0 && existing[0]?.[0]) continue;
    const cols = String.fromCharCode(64 + headers.length);
    await writeValues(title, `A2:${cols}2`, [headers]);
  }
}

function fmtDate(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : '';
}

function fmtDateTime(d) {
  return d ? `${new Date(d).toISOString().slice(0, 19).replace('T', ' ')} UTC` : '';
}

function taskTag(task) {
  return `T-${String(task.taskNumber).padStart(3, '0')}`;
}

function statusLabel(status) {
  return status === 'COMPLETED' ? 'Completed' : status === 'IN_PROGRESS' ? 'In Progress' : 'Open';
}

function resolveUser(id) {
  if (!id) return '';
  const guild = client?.guilds?.cache?.get(CONFIG.DISCORD.GUILD_ID);
  const member = guild?.members?.cache?.get(id);
  if (member) return `@${member.nickname || member.user.username}`;
  return id;
}

function resolveMentions(text) {
  return String(text || '').replace(/<@!?(\d+)>/g, (m, id) => resolveUser(id) || m);
}

function taskRow(task) {
  return [
    taskTag(task),
    task.title || '',
    task.description || '',
    resolveUser(task.createdBy),
    resolveUser(task.assignedTo),
    (task.priority || 'NORMAL').charAt(0) + (task.priority || 'NORMAL').slice(1).toLowerCase(),
    statusLabel(task.status),
    String(task.progress),
    fmtDateTime(task.createdAt),
    fmtDateTime(task.claimedAt),
    fmtDate(task.dueDate),
    fmtDateTime(task.completedAt),
    resolveUser(task.completedBy || (task.status === 'COMPLETED' ? task.assignedTo : null)),
  ];
}

async function findTaskRow(task) {
  const colA = await readValues('TASKS', 'A3:A1000');
  const idx = colA.findIndex((row) => row[0] === taskTag(task));
  return idx === -1 ? null : idx + 3;
}

async function safe(fn) {
  try {
    await fn();
  } catch (err) {
    console.warn('[SHEETS]', err.message);
  }
}

async function syncTask(task) {
  if (!isConfigured()) return;
  await ensureHeaders();
  const row = await findTaskRow(task);
  const values = taskRow(task);
  if (row) {
    await writeValues('TASKS', `A${row}:M${row}`, [values]);
  } else {
    await appendRow('TASKS', values);
  }
}

async function reconcileTasks(tasks) {
  if (!isConfigured()) return;
  await ensureHeaders();
  const rows = [...tasks]
    .sort((a, b) => a.taskNumber - b.taskNumber)
    .map(taskRow);
  await clearValues('TASKS', 'A3:M1000');
  if (rows.length > 0) {
    await writeValues('TASKS', `A3:M${2 + rows.length}`, rows);
  }
}

function parseSheetStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['open', 'todo'].includes(v)) return 'OPEN';
  if (['in progress', 'inprogress', 'active', 'progress'].includes(v)) return 'IN_PROGRESS';
  if (['completed', 'done', 'finished'].includes(v)) return 'COMPLETED';
  return null;
}

function parseSheetPriority(value) {
  const v = String(value || '').trim().toLowerCase();
  const map = { low: 'LOW', normal: 'NORMAL', high: 'HIGH', max: 'HIGH', critical: 'HIGH' };
  return map[v] || null;
}

function parseSheetProgress(value) {
  const n = parseInt(String(value || '').replace(/[^0-9]/g, ''), 10);
  if (Number.isNaN(n) || n < 0 || n > 100) return null;
  return n;
}

function parseSheetDate(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function resolveSheetUser(guild, value) {
  const v = String(value || '').trim().replace(/^@/, '').replace(/!/g, '');
  if (!v) return '';
  if (/^\d{15,}$/.test(v)) return v;
  const target = v.toLowerCase();
  const found = [...(guild?.members?.cache?.values() || [])].find(
    (m) => (m.nickname || m.user.username || '').toLowerCase() === target,
  );
  return found ? found.id : null;
}

async function importSheetChanges(guild) {
  if (!isConfigured()) return 0;

  const rows = await readValues('TASKS', 'A3:M1000');
  let applied = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tag = String(row[0] || '').trim();
    if (!/^T-\d{3,}$/.test(tag)) continue;

    const taskNumber = parseInt(tag.slice(2), 10);
    const task = await prisma.task.findFirst({ where: { guildId: CONFIG.DISCORD.GUILD_ID, taskNumber } });
    if (!task) continue;

    const data = {};
    const subjects = [];

    const title = String(row[1] || '').trim();
    if (title && title !== task.title) {
      data.title = title;
      subjects.push('title');
    }

    const desc = String(row[2] || '');
    if (desc !== (task.description || '')) {
      data.description = desc || null;
      subjects.push('description');
    }

    const assignCell = resolveSheetUser(guild, row[4]);
    if (assignCell !== null) {
      const targetId = assignCell || null;
      if (targetId !== task.assignedTo) {
        data.assignedTo = targetId;
        subjects.push(targetId ? `assigned → ${resolveUser(targetId)}` : 'unassigned');
      }
    }

    const priority = parseSheetPriority(row[5]);
    if (priority && priority !== task.priority) {
      data.priority = priority;
      subjects.push(`priority → ${priority.toLowerCase()}`);
    }

    const newStatus = parseSheetStatus(row[6]);
    if (newStatus && newStatus !== task.status) {
      data.status = newStatus;
      subjects.push(`status → ${statusLabel(newStatus)}`);
      if (newStatus === 'COMPLETED') {
        data.progress = 100;
        data.completedAt = new Date();
      } else if (task.status === 'COMPLETED') {
        data.completedAt = null;
      }
    }

    const progress = parseSheetProgress(row[7]);
    if (progress !== null && data.progress === undefined && progress !== task.progress) {
      data.progress = progress;
      subjects.push(`progress → ${progress}%`);
    }

    const dueDate = row[10] === undefined ? undefined : parseSheetDate(row[10]);
    if (dueDate !== undefined) {
      const current = fmtDate(task.dueDate);
      if (dueDate !== current && (current || dueDate !== '')) {
        data.dueDate = dueDate || null;
        subjects.push(dueDate ? `due date → ${dueDate.slice(0, 10)}` : 'due date cleared');
      }
    }

    if (Object.keys(data).length === 0) continue;

    if (data.assignedTo !== undefined) {
      data.claimedAt = data.assignedTo ? new Date() : null;
    }

    const updated = await prisma.task.update({ where: { id: task.id }, data });
    const update = await prisma.taskUpdate.create({
      data: {
        taskId: task.id,
        userId: 'system',
        progress: updated.progress,
        status: updated.status,
        note: `Updated from spreadsheet: ${subjects.join(', ')}.`,
      },
    });

    await syncTask(updated);
    await syncTaskUpdate(updated, update);
    applied++;
  }

  return applied;
}

async function syncTaskUpdate(task, update) {
  if (!isConfigured()) return;
  await ensureHeaders();
  const updatedRange = await appendRow('Task Updates', [
    '',
    taskTag(task),
    resolveUser(update.userId),
    String(update.progress),
    statusLabel(update.status),
    resolveMentions(update.note),
    fmtDateTime(update.createdAt),
  ]);

  const match = updatedRange.match(/!A(\d+):/);
  if (match) {
    const rowNum = Number(match[1]);
    const updateId = `U-${String(rowNum - 2).padStart(3, '0')}`;
    await writeValues('Task Updates', `A${rowNum}:A${rowNum}`, [[updateId]]);
  }
}

async function syncMembers(guild) {
  if (!isConfigured()) return;
  await ensureHeaders();

  const members = [...guild.members.cache.values()];
  const rows = members
    .filter((m) => !m.user.bot)
    .map((m) => {
      const roles = m.roles.cache
        .filter((r) => r.id !== guild.id)
        .map((r) => r.name)
        .join(', ');
      return [
        m.id,
        m.user.username,
        m.nickname || '',
        m.nickname || m.user.username,
        roles,
        'Yes',
      ];
    });

  await writeValues('MEMBERS', 'A2:F2', [MEMBERS_HEADERS]);
  if (rows.length === 0) return;
  await clearValues('MEMBERS', 'A3:F1000');
  await writeValues('MEMBERS', `A3:F${2 + rows.length}`, rows);
}

module.exports = {
  setClient,
  isConfigured,
  ensureHeaders,
  migrateLegacyLayout,
  reconcileTasks,
  importSheetChanges,
  syncTask,
  syncTaskUpdate,
  syncMembers,
};