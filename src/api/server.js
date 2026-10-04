const express = require('express');
const cors = require('cors');
const { CONFIG } = require('../config');
const healthRouter = require('./routes/health');
const eventsRouter = require('./routes/events');
const channelsRouter = require('./routes/channels');
const sheetsRouter = require('./routes/sheets');
const settingsRouter = require('./routes/settings');
const almanacRouter = require('./routes/almanac');
const homeRouter = require('./routes/home');

function createApp(context) {
  const app = express();
  app.use(cors({ origin: CONFIG.APP.CLIENT_URL }));
  app.use(express.json({ limit: '2mb' }));

  app.use('/health', healthRouter);
  app.use('/api/events', eventsRouter(context));
  app.use('/api/channels', channelsRouter());
  app.use('/api/sheets', sheetsRouter());
  app.use('/api/settings', settingsRouter());
  app.use('/api/almanac', almanacRouter());
  app.use('/api/home', homeRouter());

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[API] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };