const express = require('express');
const { getPlayerDetail, getAllianceDetail } = require('../../roster/store');

function rosterRouter() {
  const router = express.Router();

  router.get('/players/:id', async (req, res, next) => {
    try {
      const data = await getPlayerDetail(req.params.id);
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
