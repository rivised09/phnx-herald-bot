const express = require('express');
const { getRoster, invalidate, HOME_VERSIONS, DEFAULT_HOME_VERSION } = require('../../roster');
const { getHomeVersionConfig } = require('../../settings');
const { requireAccessCode } = require('../../auth/accessCode');

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

/**
 * Read-only endpoints backing the public home page.
 *
 * These are intentionally unauthenticated: the home page is public. They only
 * ever expose the selected version and roster rows, never bot configuration.
 * Writes live behind the access code on /api/settings.
 */
function homeRouter() {
  const router = express.Router();

  router.get(
    '/version',
    asyncHandler(async (req, res) => {
      const version = await getHomeVersionConfig();
      res.set('Cache-Control', 'no-store');
      res.json({ version, versions: HOME_VERSIONS, default: DEFAULT_HOME_VERSION });
    }),
  );

  router.get(
    '/players',
    asyncHandler(async (req, res) => {
      const requested = req.query.version;
      const version = requested ? String(requested).toLowerCase() : await getHomeVersionConfig();
      const data = await getRoster(version, { force: req.query.refresh === '1' });

      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
      res.json(data);
    }),
  );

  router.post(
    '/cache/clear',
    requireAccessCode,
    asyncHandler(async (req, res) => {
      invalidate();
      res.json({ ok: true });
    }),
  );

  return router;
}

module.exports = homeRouter;
