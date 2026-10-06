const prisma = require('./db');
const { CONFIG } = require('./config');

const AUTO_REFRESH_KEY = `sheets_auto_refresh:${CONFIG.DISCORD.GUILD_ID}`;
const ROW_ROSTER_KEY = `row_roster:${CONFIG.DISCORD.GUILD_ID}`;

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
  const row = await prisma.setting.findUnique({ where: { key: ROW_ROSTER_KEY } });
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch (err) {
    console.warn('[SETTINGS] Saved RoW roster is invalid:', err.message);
    return null;
  }
}

async function setRowRoster(roster) {
  if (!roster || !Array.isArray(roster.teams)) {
    const err = new Error('A valid RoW roster is required.');
    err.code = 'INVALID_ROSTER';
    throw err;
  }

  await prisma.setting.upsert({
    where: { key: ROW_ROSTER_KEY },
    create: { key: ROW_ROSTER_KEY, value: JSON.stringify(roster) },
    update: { value: JSON.stringify(roster) },
  });
  return roster;
}

async function deleteRowRoster() {
  await prisma.setting.deleteMany({ where: { key: ROW_ROSTER_KEY } });
}

module.exports = {
  getAutoRefreshConfig,
  setAutoRefreshConfig,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULTS,
  getRowRoster,
  setRowRoster,
  deleteRowRoster,
};