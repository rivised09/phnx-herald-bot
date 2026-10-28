const fs = require('fs');
const path = require('path');

/**
 * Reading DragonStats' data.
 *
 * The site is a Convex client, and every server query is guarded by two
 * different tokens:
 *
 *  - a Convex auth JWT, created by the Google login and kept in localStorage;
 *  - a "browser gate" token, minted by POST /api/browser-session for an hour.
 *
 * The second one is behind Arcjet's bot detection, which refuses a headless
 * browser outright, so the minting has to happen in a real window. That is the
 * only part that needs a browser: once both tokens are in hand the queries run
 * over a plain websocket and the scan files are fetched from R2 without any
 * authentication at all.
 *
 * Tokens are cached in data/ (gitignored) and re-minted only when they are
 * close to expiring.
 */

const GATE_FILE = path.join(__dirname, '..', '..', 'data', 'dragon-gate.json');
const DEPLOYMENT = process.env.DRAGONSTATS_CONVEX_URL || 'https://zealous-perch-135.convex.cloud';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Seconds a JWT has left, or null when it is not a JWT we can read. */
function secondsLeft(token) {
  try {
    const payload = String(token).split('.')[1];
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!json.exp) return null;
    return json.exp - Math.floor(Date.now() / 1000);
  } catch {
    return null;
  }
}

function readGate() {
  try {
    if (!fs.existsSync(GATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(GATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function usable(gate) {
  if (!gate || !gate.token || !gate.convexJwt) return false;
  if (!gate.expiresAt || gate.expiresAt - Date.now() < REFRESH_MARGIN_MS) return false;
  const left = secondsLeft(gate.convexJwt);
  if (left !== null && left * 1000 < REFRESH_MARGIN_MS) return false;
  return true;
}

/** Both tokens, from the cache when they are still good. */
async function tokens({ force = false, headless = false } = {}) {
  const cached = readGate();
  if (!force && usable(cached)) {
    console.log('[API] Using cached gate token (expires', new Date(cached.expiresAt).toISOString(), ')');
    return cached;
  }

  const session = require('./session');
  console.log('[API] Re-minting gate token via headed browser...');
  const fresh = await session.withPage(
    async (page) => {
      await page.goto(`${session.BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
      // The app mints its own gate token on load; asking again is cheap and
      // returns the one it is currently using.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const bag = await page.evaluate(async () => {
          const res = await fetch('/api/browser-session', { method: 'POST' });
          const body = await res.json().catch(() => ({}));
          const key = Object.keys(localStorage).find((name) => name.startsWith('__convexAuthJWT'));
          return {
            status: res.status,
            token: body.token || null,
            expiresAt: body.expiresAt || null,
            convexJwt: key ? localStorage.getItem(key) : null,
          };
        });
        if (bag.status === 200 && bag.token && bag.convexJwt) return bag;
        await page.waitForTimeout(1500);
      }
      return null;
    },
    { headless },
  );

  if (!fresh) {
    throw new Error(
      'DragonStats did not issue a browser session. The saved login may have expired: run npm run dragon:login.',
    );
  }

  console.log('[API] Fresh gate token obtained (expires', new Date(fresh.expiresAt).toISOString(), ')');
  fs.mkdirSync(path.dirname(GATE_FILE), { recursive: true });
  fs.writeFileSync(GATE_FILE, JSON.stringify(fresh));
  return fresh;
}

/**
 * Runs `work(client, gate)` against the Convex deployment.
 *
 * The client is closed even when the callback throws, so a failed query cannot
 * leave a socket open and keep the process alive.
 */
async function withClient(work, options = {}) {
  const gate = await tokens(options);
  const { ConvexClient } = require('convex/browser');
  const client = new ConvexClient(DEPLOYMENT, { unsavedChangesWarning: false });
  client.setAuth(async () => gate.convexJwt);
  try {
    return await work(client, gate);
  } finally {
    await client.close();
  }
}

/**
 * Every server the site tracks, as `{ id, name }` with names like `#973`.
 *
 * This one takes no gate token: the deployment rejects unknown arguments with
 * a generic "Server Error", so passing one makes the query fail. The
 * per-server query below still requires it.
 */
async function servers(client) {
  return client.query('serverUpdates:getServers', {});
}

/** One server's scan records, newest first. */
async function scans(client, gate, serverName) {
  const name = String(serverName).startsWith('#') ? String(serverName) : `#${serverName}`;
  return client.query('serverUpdates:getServerUpdatesByServer', {
    browserGateToken: gate.token,
    serverName: name,
  });
}

/** The most recent scan: `{ url, createdAt }` or null when the server is unknown. */
async function latestScan(client, gate, serverName) {
  return scanAt(client, gate, serverName, 0);
}

/** The scan at `index` among a server's records: 0 = newest, 1 = the one before. */
async function scanAt(client, gate, serverName, index = 0) {
  const records = (await scans(client, gate, serverName)).filter((record) => record.externalUrl);
  const record = records.sort(
    (a, b) => (b._creationTime || 0) - (a._creationTime || 0),
  )[index];
  if (!record) return null;
  return { url: record.externalUrl, createdAt: new Date(record._creationTime || Date.now()), record };
}

/**
 * The newest scan published on `date` (UTC), or null when that day has none.
 *
 * DragonStats does not let you ask for a date directly: the records only carry
 * `_creationTime`, so the date has to be matched here.
 */
async function scanOnDate(client, gate, serverName, date) {
  const records = (await scans(client, gate, serverName)).filter((record) => record.externalUrl);
  const wanted = String(date);
  const record = records
    .filter((entry) => new Date(entry._creationTime || 0).toISOString().slice(0, 10) === wanted)
    .sort((a, b) => (b._creationTime || 0) - (a._creationTime || 0))[0];
  if (!record) return null;
  return { url: record.externalUrl, createdAt: new Date(record._creationTime || Date.now()), record };
}

/** The scan body itself. Public R2, no token needed. */
async function fetchScan(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the scan (${res.status}): ${url}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`The scan at ${url} is not a player list.`);
  return data;
}

/** Server metadata for a number, or null when DragonStats does not track it. */
async function findServer(client, gate, serverName) {
  const all = await servers(client);
  const wanted = String(serverName).replace(/^#/, '').trim();
  return (all || []).find((entry) => String(entry.name).replace(/^#/, '') === wanted) || null;
}

module.exports = {
  DEPLOYMENT,
  GATE_FILE,
  tokens,
  withClient,
  servers,
  scans,
  latestScan,
  scanAt,
  scanOnDate,
  fetchScan,
  findServer,
  secondsLeft,
};
