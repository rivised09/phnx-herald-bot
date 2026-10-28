const express = require('express');
const { requireAccessCode } = require('../../auth/accessCode');
const {
  startScrape,
  cancelScrape,
  getScrapeState,
  getScrapeOptions,
} = require('../../scrape/runner');

/**
 * Scraping controls for the web dashboard.
 *
 * The heavy lifting stays in the existing scripts; this route only starts,
 * cancels and reports jobs. Logs are returned incrementally (`?after=<seq>`) so
 * the settings page can poll without re-downloading the whole buffer.
 */
function scrapeRouter() {
  const router = express.Router();

  router.get('/', requireAccessCode, (req, res) => {
    res.json(
      getScrapeState({
        after: Number(req.query.after) || 0,
        limit: Number(req.query.limit) || 500,
      }),
    );
  });

  router.get('/options', requireAccessCode, async (req, res, next) => {
    try {
      res.json(await getScrapeOptions());
    } catch (error) {
      next(error);
    }
  });

  router.post('/', requireAccessCode, (req, res) => {
    try {
      const result = startScrape(req.body || {});
      if (!result.accepted) {
        return res.status(409).json({ ...result, error: 'A scrape is already running.' });
      }
      return res.status(202).json(result);
    } catch (error) {
      return res.status(error.code === 'INVALID_JOB' ? 400 : 500).json({ error: error.message });
    }
  });

  router.delete('/', requireAccessCode, (req, res) => {
    res.json(cancelScrape());
  });

  return router;
}

module.exports = scrapeRouter;
