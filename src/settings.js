const prisma = require('./db');
const { CONFIG } = require('./config');

const AUTO_REFRESH_KEY = `sheets_auto_refresh:${CONFIG.DISCORD.GUILD_ID}`;
const ROW_ROSTER_KEY = `row_roster:${CONFIG.DISCORD.GUILD_ID}`;
const crypto = require('crypto');

const DEFAULTS = {
  enabled: true,
  intervalMs: 30000,
};

const MIN_INTERVAL_MS = 15000;
const MAX_INTERVAL_MS = 600000;

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.intervalMs;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)));
}

async function getAutoRefreshConfig() {
  try {
    const row = await prisma.setting.findUnique({ where: { key: AUTO_REFRESH_KEY } });
    if (!row) return { ...DEFAULTS };
    const parsed = JSON.parse(row.value || '{}');
    return {
      enabled: parsed.enabled !== false,
      intervalMs: clampInterval(parsed.intervalMs ?? DEFAULTS.intervalMs),
    };
  } catch (err) {
    console.warn('[SETTINGS] Could not read auto-refresh config, using defaults:', err.message);
    return { ...DEFAULTS };
  }
}

async function setAutoRefreshConfig(patch = {}) {
  const current = await getAutoRefreshConfig();
  const next = {
    enabled:
      typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    intervalMs:
      patch.intervalMs === undefined ? current.intervalMs : clampInterval(patch.intervalMs),
  };

  await prisma.setting.upsert({
    where: { key: AUTO_REFRESH_KEY },
    create: { key: AUTO_REFRESH_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });

  console.log(
    `[SETTINGS] Spreadsheet auto-refresh ${next.enabled ? 'enabled' : 'disabled'} (every ${next.intervalMs}ms).`,
  );
  return next;
}

async function getRowRoster() {
  const rosters = await getRowRosters();
  return rosters[0] || null;
}

async function getRowRosters() {
  const row = await prisma.setting.findUnique({ where: { key: ROW_ROSTER_KEY } });
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (Array.isArray(parsed)) return parsed;
    return parsed?.teams ? [{ ...parsed, id: parsed.id || crypto.randomUUID(), name: parsed.name || 'Saved roster' }] : [];
  } catch (err) {
    console.warn('[SETTINGS] Saved RoW roster is invalid:', err.message);
    return [];
  }
}

async function setRowRoster(roster) {
  if (!roster || !Array.isArray(roster.teams)) {
    const err = new Error('A valid RoW roster is required.');
    err.code = 'INVALID_ROSTER';
    throw err;
  }

  const rosters = (await getRowRosters()).filter((item) => item.id !== roster.id);
  const saved = {
    ...roster,
    id: roster.id || crypto.randomUUID(),
    name: String(roster.name || 'Saved roster').trim() || 'Saved roster',
  };
  rosters.unshift(saved);
  await prisma.setting.upsert({
    where: { key: ROW_ROSTER_KEY },
    create: { key: ROW_ROSTER_KEY, value: JSON.stringify(rosters) },
    update: { value: JSON.stringify(rosters) },
  });
  return saved;
}

async function deleteRowRoster(id) {
  const rosters = (await getRowRosters()).filter((item) => item.id !== id);
  if (rosters.length) {
    await prisma.setting.update({ where: { key: ROW_ROSTER_KEY }, data: { value: JSON.stringify(rosters) } });
  } else {
    await prisma.setting.deleteMany({ where: { key: ROW_ROSTER_KEY } });
  }
}

module.exports = {
  getAutoRefreshConfig,
  setAutoRefreshConfig,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULTS,
  getRowRoster,
  getRowRosters,
  setRowRoster,
  deleteRowRoster,
};