const { withAuthedPage, BASE } = require('./session');

/**
 * v1 roster source: callofstats.com, read with Playwright.
 *
 * The source is a chain of three page types:
 *
 *   /server/{id}            -> alliances (each carries an alliance_id)
 *   /alliance/{alliance_id} -> its players (each carries a player_id)
 *   /lord/{player_id}       -> one player in depth
 *
 * We crawl the first two: the alliance pages already expose the member rows,
 * so visiting every /lord/{id} would multiply page loads by the population of
 * the server without adding anything the roster needs. Lord pages stay
 * available for on-demand enrichment later.
 *
 * Entities are found through their links (/alliance/{id}, /lord/{id}) rather
 * than by guessing which table column holds an id, then the surrounding row is
 * read for stats. That keeps extraction working whatever columns the site
 * happens to render.
 *
 * STATUS VALUES:
 *   ok              - rows were parsed
 *   not_configured  - credentials, playwright, or source URL missing
 *   auth_failed     - the site rejected the credentials
 *   fetch_failed    - the server page could not be loaded
 *   parse_empty     - pages loaded but held no recognisable rows
 */

const DEFAULT_SERVER_ID = '973';
const DEFAULT_MAX_ALLIANCES = 50;
const MAX_ROWS = 500;
const NAV_TIMEOUT_MS = 25000;
const IDLE_TIMEOUT_MS = 8000;

function serverId() {
  const raw = String(process.env.CALLOFSTATS_SERVER_ID || '').trim();
  return /^\d+$/.test(raw) ? raw : DEFAULT_SERVER_ID;
}

function sourceUrl() {
  const raw = String(process.env.PLAYER_STATS_SOURCE_URL || '').trim();
  if (raw) {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Source URL must use http or https');
    }
    if (parsed.origin !== new URL(BASE).origin) {
      throw new Error(`Source URL must be on ${new URL(BASE).origin}`);
    }
    return parsed.toString();
  }
  return `${BASE}/server/${serverId()}`;
}

function maxAlliances() {
  const parsed = parseInt(process.env.CALLOFSTATS_MAX_ALLIANCES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ALLIANCES;
}

function allianceUrl(id) {
  return new URL(`/alliance/${id}`, BASE).toString();
}

function isLoginPage(page) {
  try {
    return new URL(page.url()).pathname === '/login';
  } catch {
    return false;
  }
}

/**
 * Runs inside the browser against the real rendered DOM.
 *
 * Finds every link whose href carries an id, then lifts the stats out of the
 * nearest table row. `allianceId` is supplied when we are reading an alliance
 * page so its members can be attributed to that alliance.
 */
function extractEntities({ allianceId } = {}) {
  const alliances = new Map();
  const players = new Map();

  const readHeaders = (row) => {
    const table = row && row.closest('table');
    if (!table) return [];
    const head = table.querySelector('tr');
    // Only treat a row as headers when it actually uses <th>; otherwise it is
    // just the first data row and its cells would be mistaken for names.
    if (!head || !head.querySelector('th')) return [];
    return [...head.querySelectorAll('th')].map((c) => (c.textContent || '').trim());
  };

  const nameOf = (link) => (link.textContent || '').replace(/\s+/g, ' ').trim();

  const statsOf = (row, headers, link, name) => {
    const stats = {};
    if (!row) return stats;
    const ownCell = link.closest('td');
    [...row.querySelectorAll('td')].forEach((td, i) => {
      const text = (td.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      // Skip the cell that only repeats the label we already have as the name.
      if (td === ownCell && text === name) return;
      const key = headers[i] || `col${i + 1}`;
      stats[key] = text;
    });
    return stats;
  };

  let seen = 0;
  for (const link of document.querySelectorAll('a[href]')) {
    if (seen >= 1000) break;
    const href = link.getAttribute('href') || '';
    const allianceMatch = href.match(/\/alliance\/(\d+)/);
    const lordMatch = href.match(/\/lord\/(\d+)/);
    if (!allianceMatch && !lordMatch) continue;

    const row = link.closest('tr');
    const name = nameOf(link);
    if (!name) continue;
    const headers = readHeaders(row);
    const stats = statsOf(row, headers, link, name);

    if (allianceMatch) {
      const id = allianceMatch[1];
      if (!alliances.has(id)) alliances.set(id, { id, name, stats });
    } else {
      const id = lordMatch[1];
      if (!players.has(id)) {
        players.set(id, { id, name, stats, allianceId: allianceId || null });
      }
    }
    seen += 1;
  }

  return {
    alliances: [...alliances.values()].slice(0, 500),
    players: [...players.values()].slice(0, 500),
  };
}

function failure(status, detail) {
  return { version: 'v1', status, detail, alliances: [], players: [] };
}

async function getRoster() {
  let url;
  try {
    url = sourceUrl();
  } catch (err) {
    return failure('not_configured', err.message);
  }

  let crawled;
  try {
    crawled = await withAuthedPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});

      if (isLoginPage(page)) {
        const err = new Error('Redirected to the login page before any data was read');
        err.code = 'BAD_CREDENTIALS';
        throw err;
      }

      const fromServer = await page.evaluate(extractEntities, { allianceId: null });
      const alliances = fromServer.alliances;
      const players = [...fromServer.players];
      const knownPlayers = new Set(players.map((p) => p.id));

      const limit = maxAlliances();
      const targets = alliances.slice(0, limit);
      const truncated = alliances.length > targets.length;
      let authExpired = false;
      let reached = 0;

      for (const alliance of targets) {
        if (authExpired) break;
        try {
          await page.goto(allianceUrl(alliance.id), {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT_MS,
          });
          await page
            .waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS })
            .catch(() => {});

          // The session can lapse mid-crawl; stop rather than record a page of
          // login markup as if it were roster data.
          if (isLoginPage(page)) {
            authExpired = true;
            alliance.error = 'session_expired';
            break;
          }

          const fromAlliance = await page.evaluate(extractEntities, {
            allianceId: alliance.id,
          });
          for (const member of fromAlliance.players) {
            if (knownPlayers.has(member.id)) continue;
            knownPlayers.add(member.id);
            players.push(member);
          }
          // An alliance page occasionally links sibling alliances; keep any
          // stats we do not already hold without duplicating the entry.
          for (const other of fromAlliance.alliances) {
            const existing = alliances.find((a) => a.id === other.id);
            if (existing && Object.keys(existing.stats).length === 0) {
              existing.stats = other.stats;
            }
          }
          reached += 1;
        } catch (err) {
          // One unreachable alliance must not discard the whole crawl.
          alliance.error = err.name === 'TimeoutError' ? 'timeout' : err.message;
        }
      }

      alliances.forEach((a, i) => {
        a.rank = i + 1;
      });
      players.forEach((p, i) => {
        p.index = i + 1;
      });

      return { alliances, players, truncated, reached, authExpired };
    });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED' || err.code === 'NO_PLAYWRIGHT') {
      return failure('not_configured', err.message);
    }
    if (err.code === 'BAD_CREDENTIALS') {
      return failure('auth_failed', err.message);
    }
    if (err.name === 'TimeoutError') {
      return failure('fetch_failed', 'The source page timed out');
    }
    return failure('fetch_failed', err.message);
  }

  const { alliances = [], players = [], truncated = false, authExpired = false } = crawled;

  if (authExpired && alliances.length === 0 && players.length === 0) {
    return failure('auth_expired', 'The session lapsed while reading the server page.');
  }

  const empty = alliances.length === 0 && players.length === 0;
  const notes = [];
  if (truncated) {
    notes.push(
      `Showing the first ${maxAlliances()} alliances only. Raise CALLOFSTATS_MAX_ALLIANCES to read more.`,
    );
  }
  if (authExpired) notes.push('The session lapsed partway through, so some alliances were skipped.');

  return {
    version: 'v1',
    status: empty ? 'parse_empty' : 'ok',
    detail: empty
      ? 'The pages loaded but no alliance or player links were recognised on them.'
      : notes.length
        ? notes.join(' ')
        : null,
    server: { id: serverId(), url: sourceUrl() },
    alliances: alliances.slice(0, MAX_ROWS),
    players: players.slice(0, MAX_ROWS),
    crawledAt: new Date().toISOString(),
    guild: null,
  };
}

module.exports = { getRoster, extractEntities };
