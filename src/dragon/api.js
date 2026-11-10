/**
 * Reading DragonStats' data.
 *
 * DragonStats no longer needs a login to read: the scans query accepts a
 * short-lived "browser gate" token, and the scan files themselves are public
 * R2 objects. Verified end to end - a fresh browser with no account lists all
 * 17 scans for #973 - so there is no Google sign-in, no Convex JWT and no
 * saved session anywhere in this module any more.
 *
 * The one browser involved is minting that gate: Arcjet's bot detection
 * refuses headless browsers and plain HTTP clients (403 "Access denied"), so
 * the token is minted from a real, headed window - once an hour at most -
 * and cached in data/dragon-gate.json. On a headless host that means a
 * display must exist (Xvfb counts; see runner.canOpenWindow).
 *
 * Everything else is a plain HTTP POST to the Convex query endpoint.
 */
const fs = require('fs');
const path = require('path');

const GATE_FILE = path.join(__dirname, '..', '..', 'data', 'dragon-gate.json');
const DEPLOYMENT = process.env.DRAGONSTATS_CONVEX_URL || 'https://zealous-perch-135.convex.cloud';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const GATE_TTL_MS = 55 * 60 * 1000; // the endpoint issues ~1h tokens

function readGate() {
  try {
    if (!fs.existsSync(GATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(GATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Whether the cached gate can still be presented without minting a new one. */
function usable(gate) {
  if (!gate || !gate.token) return false;
  const expiresAt = Number(gate.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - Date.now() >= REFRESH_MARGIN_MS;
}

/**
 * Mints a gate token from a real, headed browser window.
 *
 * The stealth launch options (see session.withPage) matter: Arcjet refuses
 * Chromium that announces itself as automated - and refuses headless
 * outright - which is why a plain fetch, or a raw Playwright launch, gets 403
 * while this gets 200. No cookies, no profile and no login are involved: a
 * fresh guest browser is enough.
 */
async function mintGate() {
  const { withPage, BASE: DASHBOARD_BASE } = require('./session');

  const bag = await withPage(
    async (page) => {
      await page.goto(`${DASHBOARD_BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return page.evaluate(async () => {
        try {
          const res = await fetch('/api/browser-session', { method: 'POST' });
          const text = await res.text();
          try {
            const body = JSON.parse(text);
            return { status: res.status, token: body.token || null, expiresAt: body.expiresAt || null };
          } catch {
            return { status: res.status, token: null, expiresAt: null };
          }
        } catch (err) {
          return { status: 0, token: null, expiresAt: null, error: String(err) };
        }
      });
    },
    { headless: false },
  );

  if (!bag.token) {
    throw new Error(
      bag.status === 403
        ? 'DragonStats refused the browser gate (HTTP 403). Its bot detection only accepts a real, ' +
            'headed window - run this from a desktop, or under Xvfb on a server.'
        : `DragonStats did not issue a browser gate (HTTP ${bag.status}).`,
    );
  }

  const gate = {
    token: bag.token,
    expiresAt: bag.expiresAt
      ? Date.parse(bag.expiresAt) || Date.now() + GATE_TTL_MS
      : Date.now() + GATE_TTL_MS,
    mintedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(GATE_FILE), { recursive: true });
  fs.writeFileSync(GATE_FILE, JSON.stringify(gate));
  console.log(`[API] Fresh DragonStats gate obtained (expires ${new Date(gate.expiresAt).toISOString()})`);
  return gate;
}

/** The gate token, from the cache when it is still good. */
async function gate({ force = false } = {}) {
  const cached = readGate();
  if (!force && usable(cached)) return cached;
  return mintGate();
}

/**
 * One call to the Convex query endpoint, carrying the gate.
 *
 * `withGate: false` is for the endpoints that are public on their own -
 * passing a gate to `getServers` makes the deployment reject the call.
 */
async function query(fn, args, { withGate = true } = {}) {
  const payload = { ...args };
  if (withGate) payload.browserGateToken = (await gate()).token;

  const res = await fetch(`${DEPLOYMENT}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: fn, args: payload }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => null);
  if (!body || body.status !== 'success') {
    throw new Error(
      `DragonStats ${fn} failed: ${body?.errorMessage || `HTTP ${res.status}`}`,
    );
  }
  return body.value;
}

/** Every server the site tracks, as `{ id, name }` with names like `#973`. */
async function servers() {
  return query('serverUpdates:getServers', {}, { withGate: false });
}

/** One server's scan records, newest first. */
async function scans(serverName) {
  const name = String(serverName).startsWith('#') ? String(serverName) : `#${serverName}`;
  return query('serverUpdates:getServerUpdatesByServer', { serverName: name });
}

/** The scan records that actually point at a scan file, newest first. */
async function scanRecords(serverName) {
  const records = (await scans(serverName)).filter((record) => record.externalUrl);
  return records.sort((a, b) => (b._creationTime || 0) - (a._creationTime || 0));
}

/** The most recent scan: `{ url, createdAt }` or null when the server is unknown. */
async function latestScan(serverName) {
  return scanAt(serverName, 0);
}

/** The scan at `index` among a server's records: 0 = newest, 1 = the one before. */
async function scanAt(serverName, index = 0) {
  const record = (await scanRecords(serverName))[index];
  if (!record) return null;
  return { url: record.externalUrl, createdAt: new Date(record._creationTime || Date.now()), record };
}

/**
 * The newest scan published on `date` (UTC), or null when that day has none.
 *
 * DragonStats does not let you ask for a date directly: the records only carry
 * `_creationTime`, so the date has to be matched here.
 */
async function scanOnDate(serverName, date) {
  const wanted = String(date);
  const record = (await scanRecords(serverName)).find(
    (entry) => new Date(entry._creationTime || 0).toISOString().slice(0, 10) === wanted,
  );
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
async function findServer(serverName) {
  const all = await servers();
  const wanted = String(serverName).replace(/^#/, '').trim();
  return (all || []).find((entry) => String(entry.name).replace(/^#/, '') === wanted) || null;
}

module.exports = {
  DEPLOYMENT,
  GATE_FILE,
  gate,
  mintGate,
  query,
  servers,
  scans,
  scanRecords,
  latestScan,
  scanAt,
  scanOnDate,
  fetchScan,
  findServer,
};
