const express = require('express');
const { CONFIG } = require('../../config');
const { syncMembers, getGuild } = require('../../sheets');

function sheetsRouter() {
  const router = express.Router();

  router.post('/refresh-members', async (req, res) => {
    const code = req.query.code;
    if (CONFIG.APP.DASHBOARD_ACCESS_CODE && code !== CONFIG.APP.DASHBOARD_ACCESS_CODE) {
      return res.status(403).json({ error: 'Invalid access code' });
    }

    const guild = getGuild();
    if (!guild) {
      return res.status(503).json({ error: 'Guild is not loaded yet' });
    }

    try {
      await guild.members.fetch().catch(() => {});
      await syncMembers(guild);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = sheetsRouter;