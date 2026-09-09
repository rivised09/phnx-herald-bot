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
    `/values/${quoteSheet(sheet)}!${range}?valueRenderOption=RAW`,
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
    `/values/${quoteSheet(title)}!A2:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: { values: [values] } },
  );
  return res.updates?.updatedRange || '';
}

async function ensureHeaders() {
  for (const { title, headers } of SHEETS) {
    const existing = await readValues(title, 'A1:A1');
    if (existing.length > 0 && existing[0]?.[0]) continue;
    const cols = String.fromCharCode(64 + headers.length);
    await writeValues(title, `A1:${cols}1`, [headers]);
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
  const colA = await readValues('TASKS', 'A2:A');
  const idx = colA.findIndex((row) => row[0] === taskTag(task));
  return idx === -1 ? null : idx + 2;
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

async function syncTaskUpdate(task, update) {
  if (!isConfigured()) return;
  await ensureHeaders();
  const updatedRange = await appendRow('Task Updates', [
    '',
    taskTag(task),
    resolveUser(update.userId),
    String(update.progress),
    statusLabel(update.status),
    update.note || '',
    fmtDateTime(update.createdAt),
  ]);

  const match = updatedRange.match(/!A(\d+):/);
  if (match) {
    const rowNum = Number(match[1]);
    const updateId = `U-${String(rowNum - 1).padStart(3, '0')}`;
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

  await writeValues('MEMBERS', 'A1:F1', [MEMBERS_HEADERS]);
  if (rows.length === 0) {
    await writeValues('MEMBERS', 'A2:F2', [['', '', '', '', '', '']]);
    return;
  }
  await clearValues('MEMBERS', 'A2:F1000');
  await writeValues('MEMBERS', `A2:F${1 + rows.length}`, rows);
}

module.exports = {
  setClient,
  isConfigured,
  ensureHeaders,
  syncTask,
  syncTaskUpdate,
  syncMembers,
};