require('dotenv').config();
const fs = require('fs');

const requiredEnv = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'EVENTS_CHANNEL_ID',
  'LEADERSHIP_ROLE_ID',
];

function validateEnv() {
  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`[CONFIG] Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function parseRoleIds(value) {
  return (value || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function loadServiceAccount() {
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn(`[CONFIG] Could not read GOOGLE_SERVICE_ACCOUNT_FILE: ${err.message}`);
    }
  }
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[CONFIG] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${err.message}`);
    }
  }
  return null;
}

const CONFIG = {
  DISCORD: {
    TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.CLIENT_ID,
    GUILD_ID: process.env.GUILD_ID,
  },
  CHANNELS: {
    EVENTS: process.env.EVENTS_CHANNEL_ID,
    REMINDERS: process.env.REMINDERS_CHANNEL_ID || null,
    TASKS: process.env.TASKS_CHANNEL_ID || null,
    PERSONAL_PINGS: process.env.PERSONAL_PINGS_CHANNEL || null,
  },

  GOOGLE: {
    SPREADSHEET_URL: process.env.SPREADSHEET_URL || null,
    SPREADSHEET_ID: process.env.SPREADSHEET_ID || null,
    SERVICE_ACCOUNT: loadServiceAccount(),
    SURVEY_SPREADSHEET_URL: process.env.SURVEY_SPREADSHEET_URL || process.env.SURVEY_SHEET_URL || null,
    SURVEY_SPREADSHEET_ID: process.env.SURVEY_SPREADSHEET_ID || process.env.SURVEY_SHEET_ID || null,
    SURVEY_SHEET_NAME: process.env.SURVEY_SHEET_NAME || process.env.SURVEY_SHEET || null,
    SURVEY_SHEET_GID: process.env.SURVEY_SHEET_GID || null,
    SURVEY_RANGE: process.env.SURVEY_RANGE || 'A:Z',
  },
  ROLES: {
    LEADERSHIP: parseRoleIds(process.env.LEADERSHIP_ROLE_ID),
  },
  DB: {
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,
  },
  APP: {
    CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:3000',
    DASHBOARD_ACCESS_CODE: process.env.DASHBOARD_ACCESS_CODE || null,
    PORT: process.env.PORT || 3001,
  },
  BRANDING: {
    FOOTER: 'Phoenix of War - Server 973',
  },
  BEHAVIOR: {
    PING_WINDOWS: [
      { label: '7 hours', key: 'pingSevenHours', msBefore: 7 * 60 * 60 * 1000 },
      { label: 'one hour', key: 'pingOneHour', msBefore: 60 * 60 * 1000 },
      { label: '30 minutes', key: 'pingThirtyMin', msBefore: 30 * 60 * 1000 },
      { label: '10 minutes', key: 'pingTenMin', msBefore: 10 * 60 * 1000 },
      { label: 'starting', key: 'pingStarted', msBefore: 0 },
    ],
    PING_INTERVAL_MS: 60 * 1000,
    EMBED_COLORS: {
      SCHEDULED: 0x5865f2,
      ACTIVE: 0x57f287,
      CANCELLED: 0xed4245,
      COMPLETED: 0x99aab5,
    },
    UNKNOWN_CLOCK_EMOJI: '🕒',
  },
};

function dashboardUrl() {
  const base = CONFIG.APP.CLIENT_URL;
  const code = CONFIG.APP.DASHBOARD_ACCESS_CODE;
  if (!code) return `${base}/dashboard`;
  return `${base}/dashboard?code=${encodeURIComponent(code)}`;
}

module.exports = { CONFIG, validateEnv, dashboardUrl };