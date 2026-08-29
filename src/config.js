require('dotenv').config();

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

const CONFIG = {
  DISCORD: {
    TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.CLIENT_ID,
    GUILD_ID: process.env.GUILD_ID,
  },
  CHANNELS: {
    EVENTS: process.env.EVENTS_CHANNEL_ID,
    REMINDERS: process.env.REMINDERS_CHANNEL_ID || null,
  },
  ROLES: {
    LEADERSHIP: process.env.LEADERSHIP_ROLE_ID,
  },
  DB: {
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,
  },
  APP: {
    CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:3000',
    PORT: process.env.PORT || 3001,
  },
  BRANDING: {
    FOOTER: 'Phoenix of War - Server 973',
  },
  BEHAVIOR: {
    PING_WINDOWS: [
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

module.exports = { CONFIG, validateEnv };