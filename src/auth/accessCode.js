const { CONFIG } = require('../config');

/**
 * Guard for bot API routes that change state.
 *
 * The bot's HTTP port is reachable directly on Railway, so the web app's
 * middleware is not a sufficient barrier: anything that writes must be checked
 * here as well. Accepts the code as a header (preferred) or a query param.
 *
 * When no access code is configured the bot is running unlocked, which matches
 * the existing behaviour of /api/sheets/refresh-members.
 */
function requireAccessCode(req, res, next) {
  const expected = CONFIG.APP.DASHBOARD_ACCESS_CODE;
  if (!expected) return next();

  const provided = req.get('x-dashboard-code') || req.query.code;
  if (provided !== expected) {
    return res.status(401).json({ error: 'Invalid access code' });
  }
  return next();
}

module.exports = { requireAccessCode };
