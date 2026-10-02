const express = require('express');
const {
  getAutoRefreshConfig,
  setAutoRefreshConfig,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
} = require('../../settings');

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function settingsRouter() {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const autoRefresh = await getAutoRefreshConfig();
      res.json({
        autoRefresh,
        limits: { minIntervalMs: MIN_INTERVAL_MS, maxIntervalMs: MAX_INTERVAL_MS },
      });
    }),
  );

  router.patch(
    '/',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const patch = {};

      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (body.intervalMs !== undefined) patch.intervalMs = body.intervalMs;

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'Nothing to update.' });
      }

      const autoRefresh = await setAutoRefreshConfig(patch);
      res.json({ autoRefresh });
    }),
  );

  return router;
}

module.exports = settingsRouter;