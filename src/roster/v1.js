const { withAuthedPage, BASE } = require('./session');

/**
 * v1 roster source: callofstats.com, read with Playwright.
 *
 * Independent of v2 (sheets). Server pages redirect to /login with a 303, so
 * this runs inside an authenticated browser context; the session module
 * persists tokens so we only log in once.
 *
 * STATUS VALUES:
 *   ok              - rows were parsed
 *   not_configured  - credentials, playwright, or source URL missing
 *   auth_failed     - the site rejected the credentials
 *   fetch_failed    - the page could not be loaded
 *   parse_empty     - the page loaded but held no recognisable rows
 */

const DEFAULT_SOURCE = `${BASE}/server/973`;
const MAX_ROWS = 500;

function sourceUrl() {
  const raw = String(process.env.PLAYER_STATS_SOURCE_URL || '').trim() || DEFAULT_SOURCE;
  const parsed = new URL(raw);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Source URL must use http or https');
  }
  // Navigate only inside the stats site itself.
  if (parsed.origin !== new URL(BASE).origin) {
    throw new Error(`Source URL must be on ${new URL(BASE).origin}`);
  }
  return parsed.toString();
}

/**
 * Runs inside the browser, so it uses the real rendered DOM rather than
 * guessing at markup with regexes. Returns table rows keyed by their headers.
 *
 * TODO(roster-v1): refine which table/columns matter once Server 973 pages are
 * logged in and we can see the actual columns worth surfacing on /.
 */
function extractTables() {
  const pickHeader = (table) => {
    const firstRow = table.querySelector('tr');
    if (!firstRow) return null;
    const cells = [...firstRow.querySelectorAll('th, td')];
    const hasHeader = firstRow.querySelector('th');
    return { cells: cells.map((c) => (c.textContent || '').trim()), hasHeader };
  };

  const tables = [...document.querySelectorAll('table')];
  let best = null;

  for (const table of tables) {
    const header = pickHeader(table);
    if (!header || !header.cells.length) continue;
    const rows = [...table.querySelectorAll('tr')].slice(1).length;
    if (!best || rows > best.rows) best = { table, header, rows };
  }

  if (!best) return { headers: [], rows: [] };

  const headerRow = best.header;
  const bodyRows = [...best.table.querySelectorAll('tr')].slice(
    headerRow.hasHeader ? 1 : 1,
  );

  const rows = bodyRows
    .map((tr) => [...tr.querySelectorAll('td, th')].map((c) => (c.textContent || '').trim()))
    .filter((cells) => cells.some(Boolean))
    .slice(0, MAX_ROWS);

  return { headers: headerRow.cells, rows };
}

/**
 * Splits a table into a name plus its other columns as stats. The column
 * holding the player's name is detected by header, falling back to the first
 * non-numeric cell so it degrades gracefully when the header is missing.
 */
function toPlayers({ headers, rows }) {
  const nameIdx = (() => {
    const i = headers.findIndex((h) => /name|lord|player/i.test(h));
    return i >= 0 ? i : 0;
  })();

  return rows.map((cells, idx) => {
    const name =
      cells[nameIdx] ||
      cells.find((c) => c && !/^[\d\s.,%+-]+$/.test(c)) ||
      `Row ${idx + 1}`;

    const stats = {};
    cells.forEach((value, i) => {
      if (i === nameIdx || !value) return;
      const key = headers[i] || `col${i + 1}`;
      stats[key] = value;
    });

    return { id: String(name), name: String(name), stats };
  });
}

async function getRoster() {
  let url;
  try {
    url = sourceUrl();
  } catch (err) {
    return {
      version: 'v1',
      status: 'not_configured',
      detail: err.message,
      players: [],
    };
  }

  let extracted;
  try {
    extracted = await withAuthedPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      return page.evaluate(extractTables);
    });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED' || err.code === 'NO_PLAYWRIGHT') {
      return { version: 'v1', status: 'not_configured', detail: err.message, players: [] };
    }
    if (err.code === 'BAD_CREDENTIALS') {
      return { version: 'v1', status: 'auth_failed', detail: err.message, players: [] };
    }
    return {
      version: 'v1',
      status: 'fetch_failed',
      detail: err.name === 'TimeoutError' ? 'The source page timed out' : err.message,
      players: [],
    };
  }

  let players;
  try {
    players = toPlayers(extracted || { headers: [], rows: [] });
  } catch (err) {
    return {
      version: 'v1',
      status: 'parse_empty',
      detail: `Could not read the source page: ${err.message}`,
      players: [],
    };
  }

  return {
    version: 'v1',
    status: players.length ? 'ok' : 'parse_empty',
    detail: players.length
      ? null
      : 'The page loaded but no player rows were recognised on it.',
    players,
    guild: null,
  };
}

module.exports = { getRoster };
