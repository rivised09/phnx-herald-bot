const crypto = require('crypto');
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
  { title: 'TASK UPDATES', headers: UPDATES_HEADERS },
  { title: 'MEMBERS', headers: MEMBERS_HEADERS },
];

const COL = {
  TASK_ID: 0,
  TITLE: 1,
  DESCRIPTION: 2,
  CREATED_BY: 3,
  ASSIGNED_TO: 4,
  PRIORITY: 5,
  STATUS: 6,
  PROGRESS: 7,
  CREATED_AT: 8,
  CLAIMED_AT: 9,
  DUE_DATE: 10,
  COMPLETED_AT: 11,
  COMPLETED_BY: 12,
};

let client = null;
let cachedToken = { access_token: null, expires_at: 0 };
let sheetIdCache = {};

// ---- write lock: serializes mutations so a task is never created/updated twice ----
let writeQueue = Promise.resolve();
function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function setClient(botClient) {
  client = botClient;
}

function getGuild() {
  return client?.guilds?.cache?.get(CONFIG.DISCORD.GUILD_ID) || null;
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

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
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
  const data = await sheetsRequest(`/values/${quoteSheet(sheet)}!${range}?valueRenderOption=UNFORMATTED_VALUE`);
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

async function getSheetId(title) {
  if (sheetIdCache[title]) return sheetIdCache[title];
  const data = await sheetsRequest('/?fields=sheets(sheetId,properties(title))');
  for (const s of data.sheets || []) {
    if (String(s.properties?.title) === title) {
      sheetIdCache[title] = s.sheetId;
      return s.sheetId;
    }
  }
  throw new Error(`Sheet "${title}" not found`);
}

async function deleteDimensionRow(title, rowIndex1Based) {
  const sheetId = await getSheetId(title);
  await sheetsRequest(':batchUpdate', {
    method: 'POST',
    body: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: rowIndex1Based - 1, endIndex: rowIndex1Based },
          },
        },
      ],
    },
  });
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

// ---------- formatting helpers ----------

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

function priorityLabel(priority) {
  return (priority || 'NORMAL').charAt(0) + (priority || 'NORMAL').slice(1).toLowerCase();
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

// ---------- cell parsing helpers ----------

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

function parseTimestamp(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = new Date(s.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateCell(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
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

// ---------- task row mapping ----------

function taskFromRow(row, guild) {
  const tag = String(row[COL.TASK_ID] || '').trim();
  const num = parseInt(tag.slice(2), 10);
  const labelToId = (label) => {
    const id = resolveSheetUser(guild, label);
    return id || null;
  };
  return {
    id: tag,
    taskNumber: Number.isNaN(num) ? 0 : num,
    title: String(row[COL.TITLE] || '').trim(),
    description: String(row[COL.DESCRIPTION] || '') || null,
    createdBy: labelToId(row[COL.CREATED_BY]),
    assignedTo: labelToId(row[COL.ASSIGNED_TO]),
    priority: parseSheetPriority(row[COL.PRIORITY]) || 'NORMAL',
    status: parseSheetStatus(row[COL.STATUS]) || 'OPEN',
    progress: parseSheetProgress(row[COL.PROGRESS]) ?? 0,
    createdAt: parseTimestamp(row[COL.CREATED_AT]),
    claimedAt: parseTimestamp(row[COL.CLAIMED_AT]),
    dueDate: parseDateCell(row[COL.DUE_DATE]),
    completedAt: parseTimestamp(row[COL.COMPLETED_AT]),
    completedBy: labelToId(row[COL.COMPLETED_BY]),
  };
}

async function findTagRow(title, tag) {
  const a = await readValues(title, 'A3:A1000');
  const idx = a.findIndex((r) => String(r[0] || '').trim() === tag);
  return idx === -1 ? null : idx + 3;
}

// ---------- task store API ----------

async function listTasks(guild) {
  if (!isConfigured()) throw new Error('Google Sheets is not configured.');
  const rows = await readValues('TASKS', 'A3:M1000');
  return rows
    .map((row) => taskFromRow(row, guild))
    .filter((t) => /^T-\d+$/.test(t.id));
}

async function nextTaskNumber() {
  const a = await readValues('TASKS', 'A3:A1000');
  let max = 0;
  for (const r of a) {
    const m = String(r[0] || '').trim().match(/^T-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

async function createTaskInSheet({ title, description, createdBy, assignedTo, priority, dueDate }) {
  return withWriteLock(async () => {
    const number = await nextTaskNumber();
    const tag = `T-${String(number).padStart(3, '0')}`;
    const now = new Date();
    const status = assignedTo ? 'IN_PROGRESS' : 'OPEN';
    const values = [
      tag,
      title,
      description || '',
      resolveUser(createdBy),
      resolveUser(assignedTo),
      priorityLabel(priority),
      statusLabel(status),
      '0',
      fmtDateTime(now),
      assignedTo ? fmtDateTime(now) : '',
      fmtDate(dueDate),
      '',
      assignedTo ? resolveUser(assignedTo) : '',
    ];
    await appendRow('TASKS', values);
    await appendUpdateRaw(tag, {
      userId: createdBy || 'system',
      progress: 0,
      status,
      note: assignedTo ? `Task created, assigned to <@${assignedTo}>.` : 'Task created, available to claim.',
    });
    return taskFromRow(values);
  });
}

async function updateTaskInSheet(tag, patch) {
  return withWriteLock(async () => {
    const idx = await findTagRow('TASKS', tag);
    if (!idx) return null;
    const current = await readValues('TASKS', `A${idx}:M${idx}`);
    const row = current[0] || new Array(TASKS_HEADERS.length).fill('');

    const apply = (i, v) => {
      if (v !== undefined) row[i] = v;
    };
    apply(COL.TITLE, patch.title);
    apply(COL.DESCRIPTION, patch.description === undefined ? undefined : patch.description || '');
    apply(COL.CREATED_BY, patch.createdBy === undefined ? undefined : resolveUser(patch.createdBy));
    apply(COL.ASSIGNED_TO, patch.assignedTo === undefined ? undefined : patch.assignedTo ? resolveUser(patch.assignedTo) : '');
    apply(COL.PRIORITY, patch.priority === undefined ? undefined : priorityLabel(patch.priority));
    apply(COL.STATUS, patch.status === undefined ? undefined : statusLabel(patch.status));
    apply(COL.PROGRESS, patch.progress === undefined ? undefined : String(patch.progress));
    apply(COL.CREATED_AT, patch.createdAt === undefined ? undefined : fmtDateTime(patch.createdAt));
    apply(COL.CLAIMED_AT, patch.claimedAt === undefined ? undefined : fmtDateTime(patch.claimedAt));
    apply(COL.DUE_DATE, patch.dueDate === undefined ? undefined : fmtDate(patch.dueDate));
    apply(COL.COMPLETED_AT, patch.completedAt === undefined ? undefined : fmtDateTime(patch.completedAt));
    apply(COL.COMPLETED_BY, patch.completedBy === undefined ? undefined : patch.completedBy ? resolveUser(patch.completedBy) : '');

    await writeValues('TASKS', `A${idx}:M${idx}`, [row]);
    return taskFromRow(row);
  });
}

async function deleteTaskRow(tag) {
  return withWriteLock(async () => {
    const idx = await findTagRow('TASKS', tag);
    if (!idx) return false;
    await deleteDimensionRow('TASKS', idx);
    return true;
  });
}

async function appendUpdateRaw(tag, { userId, progress, status, note }) {
  const res = await appendRow('TASK UPDATES', [
    '',
    tag,
    resolveUser(userId),
    String(progress),
    statusLabel(status),
    resolveMentions(note),
    fmtDateTime(new Date()),
  ]);
  const m = res.match(/!A(\d+):/);
  if (m) {
    const rowNum = Number(m[1]);
    await writeValues('TASK UPDATES', `A${rowNum}:A${rowNum}`, [[`U-${String(rowNum - 2).padStart(3, '0')}`]]);
  }
  return res;
}

async function appendTaskUpdate(tag, data) {
  return withWriteLock(() => appendUpdateRaw(tag, data));
}

async function getTaskUpdates(tag, guild) {
  const rows = await readValues('TASK UPDATES', 'A3:G1000');
  const labelToId = (label) => {
    const id = resolveSheetUser(guild, label);
    return id || null;
  };
  return rows
    .filter((r) => String(r[1] || '').trim() === tag)
    .map((r) => ({
      id: String(r[0] || '').trim(),
      userId: labelToId(r[2]),
      progress: parseSheetProgress(r[3]) ?? 0,
      status: parseSheetStatus(r[4]) || tag,
      note: String(r[5] || '') || null,
      createdAt: parseTimestamp(r[6]),
    }));
}

// ---------- members ----------

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
  getGuild,
  isConfigured,
  ensureHeaders,
  migrateLegacyLayout,
  listTasks,
  nextTaskNumber,
  createTaskInSheet,
  updateTaskInSheet,
  deleteTaskRow,
  getTaskUpdates,
  appendTaskUpdate,
  syncMembers,
};