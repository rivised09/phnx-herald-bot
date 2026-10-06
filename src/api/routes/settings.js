const express = require('express');
const {
  getAutoRefreshConfig,
  setAutoRefreshConfig,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  getRowRoster,
  getRowRosters,
  setRowRoster,
  deleteRowRoster,
} = require('../../settings');
const { requireAccessCode } = require('../../auth/accessCode');
const { getFetchState, startTargetedFetch } = require('../../roster/fetch');

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function settingsRouter() {
  const router = express.Router();

  router.get(
    '/',
    requireAccessCode,
    asyncHandler(async (req, res) => {
      const autoRefresh = await getAutoRefreshConfig();
      res.json({
        autoRefresh,
        rowRoster: await getRowRoster(),
        rowRosters: await getRowRosters(),
        fetch: getFetchState(),
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
      if (body.rowRoster !== undefined) {
        const rowRoster = await setRowRoster(body.rowRoster);
        return res.json({ rowRoster });
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'Nothing to update.' });
      }

      const autoRefresh = await setAutoRefreshConfig(patch);
      res.json({ autoRefresh });
    }),
  );

  router.delete(
    '/',
    requireAccessCode,
    asyncHandler(async (req, res) => {
      await deleteRowRoster(req.body?.id);
      res.json({ deleted: true });
    }),
  );

  router.post(
    '/fetch',
    requireAccessCode,
    asyncHandler(async (req, res) => {
      try {
        const result = startTargetedFetch(req.body?.date);
        res.status(result.accepted ? 202 : 409).json(result);
      } catch (error) {
        res.status(error.code === 'INVALID_DATE' ? 400 : 500).json({ error: error.message });
      }
    }),
  );

  return router;
}

module.exports = settingsRouter;
