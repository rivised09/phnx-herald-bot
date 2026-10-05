const express = require('express');
const { getPlayerDetail, getAllianceDetail } = require('../../roster/store');

function rosterRouter() {
  const router = express.Router();

  router.get('/players/:id', async (req, res, next) => {
    try {
      // The lookup casts to BigInt, so anything non-numeric would otherwise
      // surface as a 500 instead of the 404 it obviously means.
      if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Player not found' });
      // `date` picks a snapshot; unset means the newest, which is what the
      // profile shows before anyone uses the picker. Anything that is not a
      // date is ignored rather than rejected - see snapshotDateParam.
      const data = await getPlayerDetail(req.params.id, { date: req.query.date });
      if (!data) return res.status(404).json({ error: 'Player not found' });
      return res.json(data);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/alliances/:id', async (req, res, next) => {
    try {
      const data = await getAllianceDetail(req.params.id);
      if (!data) return res.status(404).json({ error: 'Alliance not found' });
      return res.json(data);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = rosterRouter;
