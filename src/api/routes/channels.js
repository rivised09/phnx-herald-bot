const express = require('express');
const prisma = require('../../db');

function channelsRouter() {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const channels = await prisma.discordChannel.findMany({
        where: { type: { in: ['VOICE', 'STAGE'] } },
        orderBy: [{ type: 'asc' }, { position: 'asc' }, { name: 'asc' }],
      });
      res.json({ channels });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = channelsRouter;