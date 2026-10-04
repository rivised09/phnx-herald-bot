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
/** Allowance for client-rendered pages before we read the DOM. */
const RENDER_TIMEOUT_MS = 8000;
/**
 * What "the data has arrived" looks like.
 *
 * The server page renders alliances as a div grid inside a collapsed dropdown
 * rather than as links or table rows, so waiting only on anchors would time
 * out on a perfectly good page.
 */
const DATA_SELECTOR =
  '.alliance-item, .lord-entry, table a[href*="alliance"], a[href*="lord"]';

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

/**
 * Wall-clock budget for one crawl.
 *
 * Walking the server page plus every alliance easily outlives a hosting
 * platform's request timeout, which surfaces as a gateway error rather than a
 * roster. Stopping on budget returns whatever was already read, and the
 * remaining alliances are picked up by the next refresh.
 */
function crawlBudgetMs() {
  const parsed = parseInt(process.env.ROSTER_V1_BUDGET_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25000;
}

/**
 * Whether to follow up on each alliance's own page.
 *
 * The server page already nests every member beneath its alliance, so walking
 * those links adds nothing to the roster while costing one page load apiece.
 * Off by default: enable once we need fields only the detail pages carry.
 */
function shouldCrawlAlliances() {
  return /^(1|true|yes|on)$/i.test(String(process.env.CALLOFSTATS_CRAWL_ALLIANCES || ''));
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
 * Whether the source sent us somewhere other than the page we asked for.
 *
 * A session the application has stopped accepting is answered with a 303 to /
 * rather than to /login, so testing only for the login page lets it through:
 * the homepage then yields a handful of stray links, which get written as a
 * roster and silently replace a good one. Landing on the requested path is the
 * only trustworthy signal.
 */
function redirectedElsewhere(page, url) {
  const strip = (value) => value.replace(/\/+$/, '');
  try {
    return strip(new URL(page.url()).pathname) !== strip(new URL(url).pathname);
  } catch {
    return true;
  }
}

/**
 * Navigate, then wait for roster links to actually exist.
 *
 * The stats site renders its lists client-side, so reading at domcontentloaded
 * returns an empty DOM and "no rows recognised" follows no matter what the
 * page eventually contains.
 */
async function open(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForSelector(DATA_SELECTOR, { timeout: RENDER_TIMEOUT_MS }).catch(() => {});
}

/**
 * Runs inside the browser against the real rendered DOM.
 *
 * Two structures are read, in order of preference:
 *
 *  1. The server page's own grid - `.alliance-item` cards, each nesting its
 *     members in `.lord-entry` rows. It is a div layout, not links and not a
 *     table, and it sits inside a collapsed dropdown, which is precisely why
 *     it is invisible to innerText and to any link- or table-based parser.
 *     One page of it yields every alliance on the server plus its members and
 *     their IDs, so no follow-up request is needed to build both categories.
 *  2. Anchor hrefs and table rows, kept for alliance/lord detail pages.
 *
 * `allianceId` attributes members when reading a page that lists one
 * alliance's members outside that grid.
 */
function extractEntities({ allianceId } = {}) {
  const alliances = new Map();
  const players = new Map();

  const raw = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  // "Power: 1,234" / "ID: 25732950" -> the value that follows the label.
  const afterLabel = (el) => raw(el).replace(/^[^:]*:\s*/, '');

  /**
   * Reads a player's avatar without assuming how it is drawn.
   *
   * The element may be a real <img> (possibly lazy, so data-src is checked
   * too) or a CSS background, and the source may be a root-relative path.
   * Everything is resolved against the page URL so the database never has to
   * care which origin produced it.
   */
  const avatarOf = (scope) => {
    const el = scope.querySelector('.profile-picture');
    if (!el) return null;
    const absolute = (value) => {
      if (!value) return null;
      try {
        return new URL(value, location.href).toString();
      } catch {
        return value;
      }
    };

    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    const fromImg = absolute(img && (img.getAttribute('src') || img.getAttribute('data-src')));
    if (fromImg) return fromImg;

    const style = getComputedStyle(el).backgroundImage || '';
    const match = style.match(/url\((['"]?)(.*?)\1\)/);
    if (match) return absolute(match[2]);

    // A bare data attribute is the last resort; it is cheap to check and some
    // lazy-loaders only populate it once scrolled into view.
    return absolute(el.getAttribute('data-src') || el.getAttribute('data-avatar'));
  };

  const readLord = (entry, parentAllianceId) => {
    const id = afterLabel(entry.querySelector('.lord-id')).replace(/\D/g, '');
    const name = raw(entry.querySelector('.lord-name'));
    if (!id || !name || players.has(id)) return;

    const stats = {};
    const rank = raw(entry.querySelector('.lord-position'));
    const power = afterLabel(entry.querySelector('.lord-power'));
    if (rank) stats['Rank'] = rank;
    if (power) stats['Power'] = power;

    players.set(id, {
      id,
      name,
      stats,
      allianceId: parentAllianceId || allianceId || null,
      avatar: avatarOf(entry),
    });
  };

  document.querySelectorAll('.alliance-item').forEach((item) => {
    const name = raw(item.querySelector('.left-group'));
    if (!name) return;

    let record = alliances.get(name);
    if (!record) {
      const stats = {};
      const power = afterLabel(item.querySelector('.center-group'));
      const members = raw(item.querySelector('.right-group')).match(/(\d[\d,]*)\s*Lords?/i);
      if (power) stats['Power'] = power;
      if (members) stats['Members'] = members[1];
      record = { id: name, name, stats };
      alliances.set(name, record);
    }
    item.querySelectorAll('.lord-entry').forEach((entry) => readLord(entry, record.id));
  });

  // Members listed without an enclosing alliance card (detail pages).
  if (allianceId) {
    document.querySelectorAll('.lord-entry').forEach((entry) => readLord(entry, allianceId));
  }

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
    // Matched without a leading slash so root-relative ("alliance/123") and
    // absolute hrefs are both recognised; query-string ids are the fallback.
    const allianceMatch =
      href.match(/alliance\/(\d+)/) || href.match(/[?&]alliance_?id=(\d+)/i);
    const lordMatch = href.match(/lord\/(\d+)/) || href.match(/[?&]lord_?id=(\d+)/i);
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

  // Captured even when nothing matched: "zero rows" is unactionable without
  // knowing which page we actually landed on and what it held.
  const allAnchors = [...document.querySelectorAll('a[href]')];
  const hrefs = allAnchors.map((a) => a.getAttribute('href') || '');
  const interesting = hrefs.filter((h) => /alliance|lord/i.test(h)).slice(0, 6);

  return {
    alliances: [...alliances.values()].slice(0, 500),
    players: [...players.values()].slice(0, 500),
    meta: {
      url: location.href,
      title: (document.title || '').slice(0, 120),
      anchors: allAnchors.length,
      allianceCards: document.querySelectorAll('.alliance-item').length,
      lordEntries: document.querySelectorAll('.lord-entry').length,
      sample: interesting.length ? interesting : hrefs.slice(0, 6),
    },
  };
}

function failure(status, detail) {
  return { version: 'v1', status, detail, alliances: [], players: [] };
}

/**
 * Turns "nothing was found" into something diagnosable: which page was
 * actually reached, what it was titled, and which links it exposed. Without
 * this, a zero-row result says nothing about whether the URL, the login, or
 * the parser is at fault.
 */
function describePage(meta) {
  if (!meta) return '';
  const sample = (meta.sample || []).slice(0, 6).join(', ');
  return (
    ` Landed on ${meta.url} (title "${meta.title}") with ${meta.allianceCards} ` +
    `alliance cards, ${meta.lordEntries} member rows and ${meta.anchors} links. ` +
    `Sample hrefs: ${sample || 'none'}.`
  );
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
      await open(page, url);

      if (isLoginPage(page)) {
        const err = new Error('Redirected to the login page before any data was read');
        err.code = 'BAD_CREDENTIALS';
        throw err;
      }

      const fromServer = await page.evaluate(extractEntities, { allianceId: null });
      const alliances = fromServer.alliances;
      const serverMeta = fromServer.meta || null;
      const players = [...fromServer.players];
      const knownPlayers = new Set(players.map((p) => p.id));

      const crawlDetail = shouldCrawlAlliances();
      const limit = maxAlliances();
      const deadline = Date.now() + crawlBudgetMs();
      const targets = crawlDetail ? alliances.slice(0, limit) : [];
      const truncated = crawlDetail && alliances.length > targets.length;
      let authExpired = false;
      let budgetHit = false;
      let reached = 0;

      for (const alliance of targets) {
        if (authExpired) break;
        if (Date.now() > deadline) {
          budgetHit = true;
          break;
        }
        try {
          await open(page, allianceUrl(alliance.id));

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

      return { alliances, players, truncated, reached, authExpired, budgetHit, serverMeta };
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

  const {
    alliances = [],
    players = [],
    truncated = false,
    authExpired = false,
    budgetHit = false,
    serverMeta = null,
  } = crawled;

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
  if (budgetHit) {
    notes.push(
      'The read hit its time budget, so the remaining alliances arrive on the next refresh.',
    );
  }
  if (authExpired) notes.push('The session lapsed partway through, so some alliances were skipped.');

  if (empty) {
    console.warn('[ROSTER] parse_empty -', describePage(serverMeta));
  }

  return {
    version: 'v1',
    status: empty ? 'parse_empty' : 'ok',
    detail: empty
      ? `No alliance or player links were recognised.${describePage(serverMeta)}`
      : notes.length
        ? notes.join(' ')
        : null,
    server: { id: serverId(), url },
    alliances: alliances.slice(0, MAX_ROWS),
    players: players.slice(0, MAX_ROWS),
    crawledAt: new Date().toISOString(),
    guild: null,
  };
}

module.exports = {
  getRoster,
  extractEntities,
  serverId,
  sourceUrl,
  open,
  isLoginPage,
  redirectedElsewhere,
  DATA_SELECTOR,
  NAV_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  RENDER_TIMEOUT_MS,
};
