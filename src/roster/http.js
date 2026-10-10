const { loadSession, BASE } = require('./session');
const sidecar = require('./sidecar');

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

/**
 * Redirects followed before giving up.
 *
 * Low enough that a genuine chain resolves, low enough that a loop is caught
 * quickly rather than after dozens of round-trips.
 */
const MAX_REDIRECTS = 6;

/**
 * Whether the answer is Cloudflare's interstitial rather than the page.
 *
 * A challenge is not content and not (necessarily) a dead session: it means
 * the clearance cookie was missing or expired for this request. Treating it
 * as a normal read would parse an empty document and record "no stats";
 * treating it as an account refusal would walk the rotation ladder over a
 * cookie problem. The flag lets the caller renew the session instead.
 */
function looksLikeChallenge(status, html) {
  if (status === 403 || status === 429 || status === 503) return true;
  // Deliberately not "challenge-platform": Cloudflare's own detection snippet
  // (/cdn-cgi/challenge-platform/scripts/jsd/main.js) is on every normal page,
  // and matching it flagged all content as a challenge - which sent the
  // recovery ladder into a rotation storm over perfectly good reads.
  return /cf-chl-|_cf_chl_|challenge-form|Checking your browser before|Just a moment|Enable JavaScript and cookies/i.test(
    html || '',
  );
}

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
 * One URL for a routed browser navigation, exactly as the source answered.
 *
 * The roster crawl still drives a real page - the DOM readers run there - but
 * the document that page renders is fetched here through the sidecar, so the
 * navigation itself never carries Playwright's TLS fingerprint. Unlike
 * `fetchHtml` none of the reading rules apply: the body and the final URL come
 * back uninterpreted, because the route layer replays the source's own
 * redirects instead of interpreting them as an expired session.
 */
async function fetchForRoute(url, { cookie = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const result = await sidecar.request(
    'fetch',
    { url, cookie, timeoutMs, maxRedirects: MAX_REDIRECTS },
    timeoutMs + 10000,
  );
  if (result.redirectLoop) {
    return { redirectLoop: true, status: 0, url: result.url || url, html: '' };
  }
  const status = Number(result.status) || 0;
  if (!status) throw new Error(`The sidecar returned no status for ${url}`);
  return {
    status,
    url: result.url || url,
    html: typeof result.html === 'string' ? result.html : '',
    challenge: Boolean(result.challenge),
  };
}

/**
 * Reads one URL through the Python sidecar.
 *
 * Same contract as the direct path below - the rules about what counts as an
 * expired session live in one place, in Node, so only the transport differs.
 * The sidecar speaks to the source with a real Chrome TLS fingerprint (via
 * Scrapling), which is the part undici cannot imitate and the part the source
 * was using to refuse plain-HTTP reads.
 */
async function sidecarFetchHtml(url, { cookie = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const result = await sidecar.request(
    'fetch',
    { url, cookie, timeoutMs, maxRedirects: MAX_REDIRECTS },
    timeoutMs + 10000,
  );

  const finalUrl = result.url || url;

  // Still redirecting at the cap: a discarded cookie in a loop.
  if (result.redirectLoop) {
    return { ok: false, status: 0, authExpired: true, challenge: false, html: '', url: finalUrl };
  }

  let pathname = '';
  try {
    pathname = new URL(finalUrl).pathname;
  } catch {
    pathname = '';
  }

  const authExpired = pathname === '/login' || pathname === '/';
  const status = Number(result.status) || 0;
  const redirected = status >= 200 && status < 300;
  const html = redirected && !authExpired ? result.html || '' : '';

  return {
    ok: redirected && !authExpired && html.length > 0,
    status,
    authExpired,
    challenge: Boolean(result.challenge),
    html,
    url: finalUrl,
  };
}

/** Warned once per process: a dead sidecar would otherwise log on every read. */
let sidecarWarned = false;

/**
 * Reads one URL.
 *
 * An expired session is answered with a redirect rather than an error: the
 * source sends a signed-out visitor to /login and a lapsed-but-remembered one
 * to /. Either final URL means the body is not the page that was asked for, so
 * it is reported as `authExpired` instead of being parsed as an empty document
 * - which would otherwise be recorded as "this alliance has no stats".
 *
 * Redirects are followed by hand. With `redirect: 'follow'` a cookie the
 * source has already invalidated is a 303 to / answered by another 303 to /
 * forever, and undici abandons the request with "redirect count exceeded"
 * rather than returning a final URL. That throw escaped `getPage`, so the
 * recovery that would have re-logged-in never ran and the pass died with a
 * network error instead of an expired session.
 */
async function fetchHtml(url, { cookie = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (sidecar.enabled()) {
    try {
      return await sidecarFetchHtml(url, { cookie, timeoutMs });
    } catch (err) {
      // Availability over purity: a dead Python process must not stop a run.
      // The warning is the tell that the source is being contacted with the
      // wrong fingerprint again.
      if (!sidecarWarned) {
        sidecarWarned = true;
        console.warn('[ROSTER] Sidecar fetch failed, falling back to direct HTTP:', err.message);
      }
    }
  }

  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (cookie) headers.Cookie = cookie;

  let current = url;
  let res = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    res = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) break;
    try {
      current = new URL(location, current).toString();
    } catch {
      break;
    }
    res = null;
  }

  // Still redirecting at the cap means the source is bouncing us in a loop,
  // which is what a discarded cookie looks like.
  if (!res) return { ok: false, status: 0, authExpired: true, challenge: false, html: '', url: current };

  let pathname = '';
  try {
    pathname = new URL(current).pathname;
  } catch {
    pathname = '';
  }

  const authExpired = pathname === '/login' || pathname === '/';
  // The body is read even when the status is wrong, so an interstitial can be
  // told apart from a missing page; only the returned `html` keeps the rule
  // that an unusable answer carries no content.
  const body = await res.text().catch(() => '');
  const html = res.ok && !authExpired ? body : '';

  return {
    ok: res.ok && !authExpired && html.length > 0,
    status: res.status,
    authExpired,
    challenge: looksLikeChallenge(res.status, body),
    html,
    url: current,
  };
}

/** Content-level fallback: a document that is really the login form. */
function looksLikeLogin(html) {
  if (!html) return true;
  if (/higher-label|alliance-item|achievement-name/.test(html)) return false;
  return /name="password"|action="\/login"/i.test(html);
}

module.exports = {
  fetchHtml,
  fetchForRoute,
  cookieHeader,
  looksLikeLogin,
  looksLikeChallenge,
  USER_AGENT,
  BASE,
};
