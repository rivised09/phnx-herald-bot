const crypto = require('crypto');
const { CONFIG } = require('../config');

// Layout (source of truth = the spreadsheet):
//   TASKS:     row1 title, rows 2-4 summary/protected, row5 headers, data from row 6.
//             Column A (ID) is owner-PROTECTED -> the bot writes only B..F (Task..Due).
//             The bot generates unique PHW-#### IDs (checked against TASKS+ARCHIVE) and
//             attempts to write them into column A; if the protection blocks that write,
//             it falls back to the internal row token R<row> (see createTaskInSheet).
//   ARCHIVE:   row1 title, row2 headers, data from row 3. Bot may write A..F.
//   TASK UPDATES: row2 headers, data from row 3 (unchanged).
//   MEMBERS:   row2 headers, data from row 3. Bot writes A..F; G holds the user's
//             "Helper for Name" ARRAYFORMULA which the bot must not touch.

const TASKS_HEADERS = ['ID (automated)', 'Task', 'Description', 'Assigned To', 'Status', 'Due'];
const ARCHIVE_HEADERS = ['ID', 'Task', 'Description', 'Assigned To', 'Status', 'Due', 'Completed At', 'Note'];
const UPDATES_HEADERS = ['Update ID', 'Task ID', 'Updated By', 'Progress', 'Status', 'Note', 'Timestamp'];
const MEMBERS_HEADERS = ['Discord ID', 'Username', 'Nickname', 'Display Name', 'Roles', 'Active', 'Helper for Name'];

// A, B, C, D, E, F, G...
const COL = {
  ID: 0,
  TASK: 1,
  DESCRIPTION: 2,
  ASSIGNED_TO: 3,
  STATUS: 4,
  DUE: 5,
};

const LAYOUT = {
  TASKS: { headers: TASKS_HEADERS, headerRow: 5, dataStart: 6, skipColA: true },
  ARCHIVE: { headers: ARCHIVE_HEADERS, headerRow: 2, dataStart: 3, skipColA: false },
  'TASK UPDATES': { headers: UPDATES_HEADERS, headerRow: 2, dataStart: 3, skipColA: false },
  MEMBERS: { headers: MEMBERS_HEADERS, headerRow: 2, dataStart: 3, skipColA: false },
};

const STATUS_LABELS = {
  OPEN: 'Open',
  IN_PROGRESS: 'In Progress',
  BLOCKED: 'Blocked',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const STATUS_PROGRESS = {
  OPEN: 0,
  IN_PROGRESS: 50,
  BLOCKED: 40,
  COMPLETED: 100,
  CANCELLED: 0,
};

const SHEET_EPOCH = Date.UTC(1899, 11, 30);

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
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

    if (res.status === 429 || res.status === 408 || res.status === 425) {
      if (attempt === maxAttempts - 1) {
        throw new Error(`Sheets API ${res.status}: ${JSON.stringify(data)}`);
      }
      const retryAfter = Number(data?.error?.details?.[0]?.body?.match(/(\d+)s/)?.[1] || 0) * 1000;
      const delay = (retryAfter || 700 * 2 ** attempt) + Math.floor(Math.random() * 250);
      console.warn(`[SHEETS] Rate limited (${res.status}), retrying in ${Math.round(delay)}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      throw new Error(`Sheets API ${res.status}: ${JSON.stringify(data)}`);
    }
    return data;
  }
  throw new Error(`Sheets API request failed after ${maxAttempts} attempts.`);
}

const readCache = new Map();
const READ_CACHE_TTL = 20000;

function invalidateSheetReadCache(title) {
  const prefix = `${title}:`;
  for (const key of [...readCache.keys()]) {
    if (key.startsWith(prefix)) readCache.delete(key);
  }
}

function cacheKey(sheet, range) {
  return `${sheet}:${range}`;
}

async function readValues(sheet, range) {
  const key = cacheKey(sheet, range);
  const hit = readCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const data = await sheetsRequest(`/values/${quoteSheet(sheet)}!${range}?valueRenderOption=UNFORMATTED_VALUE`);
  const value = data.values || [];
  readCache.set(key, { value, expires: Date.now() + READ_CACHE_TTL });
  return value;
}

function invalidateAllReadCache() {
  readCache.clear();
}

async function writeValues(sheet, range, values) {
  await sheetsRequest(`/values/${quoteSheet(sheet)}!${range}?valueInputOption=RAW`, {
    method: 'PUT',
    body: { values },
  });
  invalidateSheetReadCache(sheet);
}

async function appendRow(title, values) {
  const res = await sheetsRequest(
    `/values/${quoteSheet(title)}!A3:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: { values: [values] } },
  );
  invalidateSheetReadCache(title);
  return res.updates?.updatedRange || '';
}

async function clearValues(sheet, range) {
  await sheetsRequest(`/values/${quoteSheet(sheet)}!${range}:clear`, { method: 'POST', body: {} });
  invalidateSheetReadCache(sheet);
}

async function getSheetId(title) {
  if (sheetIdCache[title]) return sheetIdCache[title];
  const data = await sheetsRequest('/?fields=sheets(properties(sheetId,title))');
  for (const s of data.sheets || []) {
    if (String(s.properties?.title) === title) {
      sheetIdCache[title] = s.properties.sheetId;
      return s.properties.sheetId;
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
  invalidateSheetReadCache(title);
}

async function clearTaskRow(rowIndex1Based) {
  await writeValues('TASKS', `B${rowIndex1Based}:F${rowIndex1Based}`, [['', '', '', '', '']]);
}

async function ensureHeaders() {
  if (!isConfigured()) return;
  for (const [title, layout] of Object.entries(LAYOUT)) {
    const firstCol = layout.skipColA ? COL.TASK : COL.ID;
    const endCol = String.fromCharCode(64 + layout.headers.length);
    const existing = await readValues(title, `${String.fromCharCode(65 + firstCol)}${layout.headerRow}:${String.fromCharCode(65 + firstCol)}${layout.headerRow}`);
    if (existing.length > 0 && existing[0]?.[0]) continue;
    const startCol = String.fromCharCode(65 + firstCol);
    await writeValues(title, `${startCol}${layout.headerRow}:${endCol}${layout.headerRow}`, [
      layout.headers.slice(firstCol),
    ]);
  }
  await applyDateFormats();
}

async function applyDateFormats() {
  for (const [title, cols] of [['TASKS', [COL.DUE]], ['ARCHIVE', [COL.DUE, COL.DUE + 1]]]) {
    const layout = LAYOUT[title];
    try {
      const sheetId = await getSheetId(title);
      await sheetsRequest(':batchUpdate', {
        method: 'POST',
        body: {
          requests: cols.map((c) => ({
            updateCells: {
              range: {
                sheetId,
                startRowIndex: layout.dataStart - 1,
                endRowIndex: 1000,
                startColumnIndex: c,
                endColumnIndex: c + 1,
              },
              fields: 'userEnteredFormat.numberFormat',
              rows: [{ values: [{ userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'mmmm d, yyyy' } } }] }],
            },
          })),
        },
      });
    } catch (err) {
      console.warn(`[SHEETS] Could not apply date format to ${title}: ${err.message}`);
    }
  }
}

// ---------- date helpers (Google Sheets stores dates as serial numbers) ----------

function toSerial(date) {
  if (!date) return '';
  return Math.floor((new Date(date).getTime() - SHEET_EPOCH) / 86400000);
}

function parseDateCell(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^-?\d+$/.test(v) || /^-?\d+\.\d+$/.test(v)) {
    const n = parseFloat(v);
    const d = new Date(SHEET_EPOCH + n * 86400000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// ---------- cell formatting / parsing ----------

function statusLabel(status) {
  return STATUS_LABELS[status] || 'Open';
}

function parseSheetStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['open', 'todo'].includes(v)) return 'OPEN';
  if (['in progress', 'inprogress', 'active', 'progress'].includes(v)) return 'IN_PROGRESS';
  if (['blocked', 'on hold', 'stuck'].includes(v)) return 'BLOCKED';
  if (['completed', 'done', 'finished'].includes(v)) return 'COMPLETED';
  if (['cancelled', 'canceled', 'cancelled'].includes(v)) return 'CANCELLED';
  return null;
}

function progressForStatus(status) {
  return STATUS_PROGRESS[status] ?? 0;
}

function fmtDateTime(d) {
  return d ? `${new Date(d).toISOString().slice(0, 19).replace('T', ' ')} UTC` : '';
}

function helperName(id) {
  if (!id) return '';
  const guild = getGuild();
  const member = guild?.members?.cache?.get(id);
  if (member) return member.nickname || member.user.displayName || member.user.username;
  return id;
}

function resolveUser(id) {
  if (!id) return '';
  const guild = getGuild();
  const member = guild?.members?.cache?.get(id);
  if (member) return `@${member.nickname || member.user.displayName || member.user.username}`;
  return id;
}

function resolveMentions(text) {
  return String(text || '').replace(/<@!?(\d+)>/g, (m, id) => resolveUser(id) || m);
}

function resolveSheetUser(guild, value) {
  const v = String(value || '').trim().replace(/^@/, '').replace(/!/g, '');
  if (!v) return '';
  if (/^\d{15,}$/.test(v)) return v;
  const target = v.toLowerCase();
  const found = [...(guild?.members?.cache?.values() || [])].find(
    (m) => {
      const names = [
        m.nickname,
        m.user.displayName,
        m.user.username,
        `${m.nickname || ''}${m.user.username}`,
      ]
        .filter(Boolean)
        .map((n) => String(n).toLowerCase());
      return names.includes(target);
    },
  );
  return found ? found.id : null;
}

// ---------- row -> task mapping ----------

function taskFromRow(row, guild, rowIndex) {
  const rawId = String(row[COL.ID] || '').trim();
  const labelToId = (label) => resolveSheetUser(guild, label) || null;
  return {
    id: rawId || (String(row[COL.TASK] || '').trim() ? `R${rowIndex}` : ''),
    rawId,
    row: rowIndex,
    title: String(row[COL.TASK] || '').trim(),
    description: String(row[COL.DESCRIPTION] || '') || null,
    assignedTo: labelToId(row[COL.ASSIGNED_TO]),
    status: parseSheetStatus(row[COL.STATUS]) || 'OPEN',
    dueDate: parseDateCell(row[COL.DUE]),
    completedAt: null,
  };
}

async function findTagRow(title, idToken) {
  const layout = LAYOUT[title];
  const a = await readValues(title, `A${layout.dataStart}:A1000`);
  let idx = a.findIndex((r) => String(r[0] || '').trim() === idToken);
  if (idx === -1 && /^R(\d+)$/.test(idToken)) {
    const row = Number(idToken.slice(1));
    if (row >= layout.dataStart) return row;
  }
  return idx === -1 ? null : idx + layout.dataStart;
}

// ---------- task store API ----------

async function listRows(title, guild) {
  if (!isConfigured()) throw new Error('Google Sheets is not configured.');
  const rows = await readValues(title, `A${LAYOUT[title].dataStart}:F1000`);
  return rowsToList(title, rows, guild);
}

function rowsToList(title, rows, guild) {
  const layout = LAYOUT[title];
  const list = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const t = taskFromRow(row, guild, i + layout.dataStart);
    if (!t.title && !t.rawId) continue;
    list.push(t);
  }
  return list;
}

async function listTasks(guild) {
  return listRows('TASKS', guild);
}

async function listArchiveTasks(guild) {
  return listRows('ARCHIVE', guild);
}

async function listTasksAndArchive(guild) {
  if (!isConfigured()) throw new Error('Google Sheets is not configured.');
  const [tRows, aRows] = await Promise.all([
    readValues('TASKS', `A${LAYOUT.TASKS.dataStart}:F1000`),
    readValues('ARCHIVE', `A${LAYOUT.ARCHIVE.dataStart}:F1000`),
  ]);
  return {
    tasks: rowsToList('TASKS', tRows, guild),
    archived: rowsToList('ARCHIVE', aRows, guild),
  };
}

function nextIdBase(rows) {
  let max = 0;
  let prefix = 'PHW-';
  const seen = new Set();
  for (const r of rows) {
    const id = String(r[COL.ID] || '').trim();
    const m = id.match(/(.*?)(\d{1,5})$/);
    if (!m || !id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const num = parseInt(m[2], 10);
    if (num > max) {
      max = num;
      prefix = m[1] || 'PHW-';
    }
  }
  return { prefix, max };
}

async function nextTaskId() {
  const [tasks, archive] = await Promise.all([
    readValues('TASKS', 'A6:A1000'),
    readValues('ARCHIVE', 'A3:A1000'),
  ]);
  let { prefix, max } = nextIdBase(tasks);
  const arch = nextIdBase(archive);
  if (arch.max > max) {
    max = arch.max;
    prefix = arch.prefix || prefix;
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

async function createTaskInSheet({ title, description, assignedTo, dueDate }) {
  return withWriteLock(async () => {
    if (!title || !String(title).trim()) throw new Error('Task name is required.');
    const t = String(title).trim();
    const status = assignedTo ? 'IN_PROGRESS' : 'OPEN';
    const values = [
      t,
      description || '',
      assignedTo ? helperName(assignedTo) : '',
      statusLabel(status),
      toSerial(dueDate),
    ];

    const rows = await readValues('TASKS', 'B6:B1000');
    let rowIndex = rows.findIndex((r) => !String(r[0] || '').trim());
    if (rowIndex === -1) {
      rowIndex = rows.length; // after the last row (B column still empty there)
    }
    const writeRow = 6 + rowIndex;
    await writeValues('TASKS', `B${writeRow}:F${writeRow}`, [values]);

    // Generate a unique PHW-#### ID (checked against BOTH TASKS and ARCHIVE) and write it
    // into column A. Column A is owner-protected, so if the service account is not an
    // allowed editor of that range the write fails with a 400; we then fall back to the
    // internal row token R<row> so the task still works end to end.
    let id = await nextTaskId();
    let idFallback = false;
    try {
      await writeValues('TASKS', `A${writeRow}:A${writeRow}`, [[id]]);
    } catch (err) {
      idFallback = true;
      id = `R${writeRow}`;
      console.warn(
        `[SHEETS] Could not write the generated ID (${id}) into TASKS column A (${err.message}). Falling back to internal id ${id}.`,
      );
    }

    const idRow = await readValues('TASKS', `A${writeRow}:F${writeRow}`);
    const task = taskFromRow(idRow[0] || [], getGuild(), writeRow);
    task.status = status;
    if (idFallback) {
      task.id = `R${writeRow}`;
      task.rawId = '';
    }

    await appendUpdateRaw(task.id, {
      userId: 'system',
      status,
      note: assignedTo ? `Task created, assigned to <@${assignedTo}>.` : 'Task created, available to claim.',
    });
    return task;
  });
}

async function updateTaskInSheet(idToken, patch) {
  return withWriteLock(async () => {
    const row = await findTagRow('TASKS', idToken);
    if (!row) return null;
    const current = await readValues('TASKS', `A${row}:F${row}`);
    const raw = current[0] || [];
    const cell = (i, v) => (v === undefined ? raw[i] : v);

    const values = [
      raw[COL.ID],
      String(cell(COL.TASK, patch.title) || ''),
      String(cell(COL.DESCRIPTION, patch.description) || ''),
      patch.assignedTo === undefined
        ? raw[COL.ASSIGNED_TO] || ''
        : patch.assignedTo
          ? helperName(patch.assignedTo)
          : '',
      patch.status === undefined ? raw[COL.STATUS] || 'Open' : statusLabel(patch.status),
      cell(COL.DUE, patch.dueDate === undefined ? undefined : toSerial(patch.dueDate)),
    ];

    await writeValues('TASKS', `B${row}:F${row}`, [values.slice(1)]);
    return taskFromRow([values[0], ...values.slice(1)], getGuild(), row);
  });
}

async function deleteTaskRow(idToken) {
  return withWriteLock(async () => {
    const row = await findTagRow('TASKS', idToken);
    if (!row) return false;
    // Column A is protected: rows cannot be deleted from TASKS. Clear the row contents
    // instead — the board treats blank rows as no task.
    await clearTaskRow(row);
    return true;
  });
}

async function archiveTask(idToken, note) {
  return withWriteLock(async () => {
    const row = await findTagRow('TASKS', idToken);
    if (!row) return null;

    const current = await readValues('TASKS', `A${row}:F${row}`);
    const data = current[0] || [];
    const oldId = String(data[COL.ID] || '').trim();
    const id = oldId || (await nextTaskId());

    const archive = await readValues('ARCHIVE', 'A3:A1000');
    let archRow = archive.findIndex((r) => !String(r[0] || '').trim());
    if (archRow === -1) return null;
    const target = 3 + archRow;

    await writeValues('ARCHIVE', `A${target}:H${target}`, [
      [
        id,
        String(data[COL.TASK] || ''),
        String(data[COL.DESCRIPTION] || ''),
        String(data[COL.ASSIGNED_TO] || ''),
        statusLabel('COMPLETED'),
        data[COL.DUE],
        toSerial(new Date()),
        note || '',
      ],
    ]);
    await clearTaskRow(row);

    const archived = taskFromRow([id, ...data.slice(1)], getGuild(), target);
    archived.id = id;
    archived.status = 'COMPLETED';
    archived.completedAt = new Date();
    archived.note = note || '';
    return archived;
  });
}

async function appendUpdateRaw(idToken, { userId, status, note }) {
  const res = await appendRow('TASK UPDATES', [
    '',
    idToken,
    resolveUser(userId),
    String(progressForStatus(status)),
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

async function appendTaskUpdate(idToken, data) {
  return withWriteLock(() => appendUpdateRaw(idToken, data));
}

async function getTaskUpdates(idToken, guild) {
  const rows = await readValues('TASK UPDATES', 'A3:G1000');
  const labelToId = (label) => resolveSheetUser(guild, label) || null;
  return rows
    .filter((r) => String(r[1] || '').trim() === idToken)
    .map((r) => ({
      id: String(r[0] || '').trim(),
      userId: labelToId(r[2]),
      progress: Number.parseInt(String(r[3] || '').replace(/[^0-9]/g, ''), 10) || 0,
      status: parseSheetStatus(r[4]) || 'OPEN',
      note: String(r[5] || '') || null,
      createdAt: (() => {
        const s = String(r[6] || '').trim();
        if (!s) return null;
        const d = new Date(s.replace(' UTC', 'Z').replace(' ', 'T'));
        return Number.isNaN(d.getTime()) ? null : d;
      })(),
    }));
}

async function getHelperNames() {
  try {
    const rows = await readValues('MEMBERS', 'A3:G1000');
    const map = new Map();
    for (const r of rows) {
      const id = String(r[0] || '').trim();
      const name = String(r[6] || '').trim();
      if (id && name) map.set(id, name);
    }
    return map;
  } catch (err) {
    console.warn('[SHEETS] Could not read helper names:', err.message);
    return new Map();
  }
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
        m.nickname || m.user.displayName || m.user.username,
        roles,
        'Yes',
      ];
    });

  await writeValues('MEMBERS', 'A2:F2', [MEMBERS_HEADERS.slice(0, 6)]);
  if (rows.length === 0) return;
  await clearValues('MEMBERS', 'A3:F1000');
  await writeValues('MEMBERS', `A3:F${2 + rows.length}`, rows);
}

module.exports = {
  setClient,
  getGuild,
  isConfigured,
  ensureHeaders,
  invalidateAllReadCache,
  listTasks,
  listArchiveTasks,
  listTasksAndArchive,
  createTaskInSheet,
  updateTaskInSheet,
  deleteTaskRow,
  archiveTask,
  getTaskUpdates,
  appendTaskUpdate,
  syncMembers,
  getHelperNames,
};