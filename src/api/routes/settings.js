const express = require('express');
const {
  getAutoRefreshConfig,
  setAutoRefreshConfig,
  getHomeVersionConfig,
  setHomeVersionConfig,
  HOME_VERSIONS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
} = require('../../settings');
const { requireAccessCode } = require('../../auth/accessCode');

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function settingsRouter() {
  const router = express.Router();

  router.get(
    '/',
    requireAccessCode,
    asyncHandler(async (req, res) => {
      const [autoRefresh, homeVersion] = await Promise.all([
        getAutoRefreshConfig(),
        getHomeVersionConfig(),
      ]);
      res.json({
        autoRefresh,
        homeVersion,
        homeVersions: HOME_VERSIONS,
        limits: { minIntervalMs: MIN_INTERVAL_MS, maxIntervalMs: MAX_INTERVAL_MS },
      });
    }),
  );

  router.patch(
    '/',
    requireAccessCode,
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const patch = {};

      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (body.intervalMs !== undefined) patch.intervalMs = body.intervalMs;

      if (body.homeVersion !== undefined && !HOME_VERSIONS.includes(String(body.homeVersion))) {
        return res.status(400).json({
          error: `homeVersion must be one of: ${HOME_VERSIONS.join(', ')}.`,
        });
      }

      if (Object.keys(patch).length === 0 && body.homeVersion === undefined) {
        return res.status(400).json({ error: 'Nothing to update.' });
      }

      const autoRefresh =
        Object.keys(patch).length > 0 ? await setAutoRefreshConfig(patch) : await getAutoRefreshConfig();

      const homeVersion =
        body.homeVersion === undefined ? await getHomeVersionConfig() : await setHomeVersionConfig(body.homeVersion);

      res.json({ autoRefresh, homeVersion, homeVersions: HOME_VERSIONS });
    }),
  );

  return router;
}

module.exports = settingsRouter;
