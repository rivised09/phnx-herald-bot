const express = require('express');
const { getRoster, requestSync, invalidate, HOME_VERSIONS, DEFAULT_HOME_VERSION } = require('../../roster');
const { getSyncState } = require('../../roster/ingest');
const { getAvatarState } = require('../../roster/avatars');
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
      const force = req.query.refresh === '1';

      // A manual refresh asks the scheduler to resync in the background rather
      // than scraping inside the request: a backfill batch can take far longer
      // than a gateway is willing to wait, and the answer the visitor wants is
      // already in the database.
      if (force) requestSync('home_refresh');

      const data = await getRoster(version, { force });
      if (force && version === 'v1') {
        data.sync = await getSyncState();
      }

      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
      res.json(data);
    }),
  );

  /** Non-authed progress view so the UI can show whether a sync is in flight. */
  router.get(
    '/sync',
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const [roster, avatars, detail] = await Promise.all([
        getSyncState(),
        getAvatarState(),
        Promise.resolve().then(() => require('../../roster/detail').getDetailState()),
      ]);
      res.json({ ...roster, avatars, detail });
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
