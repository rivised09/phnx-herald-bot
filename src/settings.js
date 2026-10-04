const prisma = require('./db');
const { CONFIG } = require('./config');

const AUTO_REFRESH_KEY = `sheets_auto_refresh:${CONFIG.DISCORD.GUILD_ID}`;
const HOME_VERSION_KEY = `home_version:${CONFIG.DISCORD.GUILD_ID}`;

const HOME_VERSIONS = ['v1', 'v2'];
const DEFAULT_HOME_VERSION = 'v1';

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

/** Unknown values fall back to the default rather than reaching the page. */
function normalizeHomeVersion(value) {
  const v = String(value || '').trim().toLowerCase();
  return HOME_VERSIONS.includes(v) ? v : DEFAULT_HOME_VERSION;
}

function parseStoredVersion(raw) {
  try {
    return normalizeHomeVersion(JSON.parse(raw));
  } catch {
    return normalizeHomeVersion(raw);
  }
}

async function getHomeVersionConfig() {
  try {
    const row = await prisma.setting.findUnique({ where: { key: HOME_VERSION_KEY } });
    if (!row) return DEFAULT_HOME_VERSION;
    return parseStoredVersion(row.value);
  } catch (err) {
    console.warn('[SETTINGS] Could not read home version, using default:', err.message);
    return DEFAULT_HOME_VERSION;
  }
}

async function setHomeVersionConfig(version) {
  const next = normalizeHomeVersion(version);
  await prisma.setting.upsert({
    where: { key: HOME_VERSION_KEY },
    create: { key: HOME_VERSION_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  console.log(`[SETTINGS] Public home page will render ${next}.`);
  return next;
}

module.exports = {
  getAutoRefreshConfig,
  setAutoRefreshConfig,
  getHomeVersionConfig,
  setHomeVersionConfig,
  HOME_VERSIONS,
  DEFAULT_HOME_VERSION,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULTS,
};