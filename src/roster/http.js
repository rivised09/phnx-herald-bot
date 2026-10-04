const { loadSession, BASE } = require('./session');

/**
 * Fetching source pages over plain HTTP instead of navigating a browser.
 *
 * Every page the crawler needs - the roster, an alliance, a player - is
 * server-rendered: the same markup a browser receives, just without the
 * `.stat-item` wrappers its scripts add afterwards. Reading it with fetch
 * skips navigation, rendering and network idle, which is the difference
 * between a few hundred milliseconds per page and several seconds.
 *
 * Over the 300 players x 30 dates of a full backfill that is hours instead of
 * most of a day, so this is the path the detail work takes. The browser stays
 * around only to parse HTML into a DOM.
 *
 * Authentication is the cookies from the saved Playwright session; Cloudflare
 * accepts them from a plain client, which was verified before this was built.
 */

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 20000;

/** Cookie header for the saved session, or null when there is no session yet. */
async function cookieHeader() {
  try {
    const state = await loadSession();
    if (!state || !Array.isArray(state.cookies)) return null;
    const jar = state.cookies
      .filter((cookie) => cookie && cookie.value)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    return jar || null;
  } catch {
    return null;
  }
}

/**
 * Reads one URL.
 *
 * An expired session is answered with a redirect rather than an error: the
 * source sends a signed-out visitor to /login and a lapsed-but-remembered one
 * to /. Either final URL means the body is not the page that was asked for, so
 * it is reported as `authExpired` instead of being parsed as an empty document
 * - which would otherwise be recorded as "this alliance has no stats".
 */
async function fetchHtml(url, { cookie = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });

  let pathname = '';
  try {
    pathname = new URL(res.url || url).pathname;
  } catch {
    pathname = '';
  }

  const authExpired = pathname === '/login' || pathname === '/';
  const html = res.ok && !authExpired ? await res.text() : '';

  return {
    ok: res.ok && !authExpired && html.length > 0,
    status: res.status,
    authExpired,
    html,
    url: res.url || url,
  };
}

/** Content-level fallback: a document that is really the login form. */
function looksLikeLogin(html) {
  if (!html) return true;
  if (/higher-label|alliance-item|achievement-name/.test(html)) return false;
  return /name="password"|action="\/login"/i.test(html);
}

module.exports = { fetchHtml, cookieHeader, looksLikeLogin, USER_AGENT, BASE };
