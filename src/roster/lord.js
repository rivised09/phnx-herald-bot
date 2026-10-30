const {
  BASE,
  withAuthedPage,
  rotateCredentials,
  sidecarLogin,
  accountList,
  loadAccountSession,
  saveAccountSession,
} = require('./session');
const { fetchHtml, cookieHeader, looksLikeLogin, rejectCurrentProxy, proxyCount } = require('./http');
const { createParser } = require('./parse');
const extract = require('./extract');

/**
 * A paced, session-aware reader for callofstats lord pages.
 *
 * This is the transport the detail pass already proved: the document is
 * fetched through the Python sidecar, so the source sees Chrome's TLS
 * fingerprint instead of Playwright's, carrying the saved `cf_clearance`
 * cookies. Parsing still happens in one reused browser, but no navigation ever
 * leaves it.
 *
 * The source refuses an account that reads too fast - after a burst it answers
 * every configured account with a 303 to `/`, not just the busy one - so
 * requests are held at least `ROSTER_LORD_DELAY_MS` apart, with up to half the
 * gap added at random. That pace is a correctness mechanism, not a politeness
 * setting: at 500 ms a run served 13 pages before the refusal started.
 *
 * Two modes:
 *
 *   stripe = 0/1   every request uses the active session (the default). A
 *                  refusal renews it, then moves to the next account.
 *   stripe > 1     accounts take turns, each with its own saved session, so
 *                  each one spends its own page budget. An account that gets
 *                  refused is put on cooldown and the next account is tried,
 *                  which is how a per-account quota (roughly ten lord pages an
 *                  account) turns into more usable pages per run. If every
 *                  account refuses or is cooling, the source is left alone.
 *
 * The pace is shared between modes: stripes rotate accounts, they never raise
 * the request rate to the machine, so an IP-level gate would still close on
 * the same page count.
 */

const DEFAULT_GAP_MS = 1500;
const DEFAULT_MAX_ROTATIONS = 1;
const DEFAULT_ACCOUNT_COOLDOWN_MS = 30 * 60 * 1000;

function envInt(name, fallback, minimum = 0) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw < minimum) return fallback;
  return raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether an answer is a refusal rather than content. */
function isAuthFailure(res) {
  return Boolean(res.authExpired || res.challenge || (res.ok && looksLikeLogin(res.html)));
}

function cookieString(cookies) {
  return (cookies || [])
    .filter((cookie) => cookie && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function createLordSource({ tag = 'LORD', stripe = 0, date = null } = {}) {
  const gapMs = envInt('ROSTER_LORD_DELAY_MS', DEFAULT_GAP_MS);
  const accounts = accountList();
  const stripeCount = stripe > 1 ? Math.min(stripe, accounts.length) : 0;

  let nextStart = 0;
  let blocked = false;
  let blockedReason = null;
  let parserPromise = null;

  // Adaptive pacing: grows on refusals, decays on success.
  const MAX_GAP_MULT = 8;
  let gapMult = 1;
  let consecutiveSuccesses = 0;

  function backoff() {
    gapMult = Math.min(gapMult * 2, MAX_GAP_MULT);
    consecutiveSuccesses = 0;
  }

  function decayBackoff() {
    consecutiveSuccesses += 1;
    if (consecutiveSuccesses >= 10) {
      gapMult = Math.max(1, gapMult - 1);
      consecutiveSuccesses = 0;
    }
  }

  /**
   * Holds requests apart by at least `gapMs * gapMult`.
   *
   * A shared deadline rather than a per-request sleep, so a second caller
   * cannot run ahead of it. The gap is a floor, not a metronome: an identical
   * interval is a machine signature of its own, so up to half the gap is added
   * at random.
   */
  async function pace() {
    const effective = gapMs * gapMult;
    if (effective <= 0) return;
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + effective + Math.floor(Math.random() * effective * 0.5);
    if (start > now) await sleep(start - now);
  }

  async function parser() {
    if (!parserPromise) parserPromise = createParser();
    return parserPromise;
  }

  /** Extracts the fields the writers consume from one document. */
  async function read(html) {
    if (!html) return null;
    const page = await parser();
    await page.load(html);

    const rows = (await page.evaluate(extract.readStatSections)) || [];
    const nameHistory = (await page.evaluate(extract.readNameHistory)) || [];
    const avatar = await page.evaluate(extract.readAvatar);
    const albums = (await page.evaluate(extract.readAlbums)) || [];
    const date = await page.evaluate(extract.readPageDate);
    const title = await page.evaluate(() => document.title || '');

    // The writers key stats by label and map the label to a section
    // themselves, so the section walker's rows are flattened here.
    const stats = {};
    for (const row of rows) {
      if (!row || !row.label) continue;
      stats[row.label] = row.value;
    }

    return { stats, nameHistory, avatar, albums, date, title };
  }

  async function close() {
    if (!parserPromise) return;
    const page = await parserPromise.catch(() => null);
    parserPromise = null;
    if (page) await page.close();
  }

  const fail = (status) => ({
    ok: false,
    blocked: true,
    status: status || 0,
    challenge: false,
    authExpired: true,
    html: '',
    url: '',
    account: -1,
  });

  // ------------------------------------------------------- single session ---

  if (stripeCount < 2) {
    let cookie;

    async function currentCookie() {
      if (cookie === undefined) cookie = await cookieHeader();
      return cookie;
    }

    /**
     * Logs in again and takes the new cookies.
     *
     * `force` makes the login happen even when the session still passes the
     * protected-route probe: an account can be refused data pages while the
     * probe keeps working, and rotating without a fresh login would just reuse
     * the refused cookies.
     */
    async function renew(reason, { force = false } = {}) {
      console.warn(
        `[${tag}] ${reason}; logging in again${force ? ' with the next account' : ''}.`,
      );
      try {
        await withAuthedPage(async () => true, { forceLogin: force });
        cookie = await cookieHeader();
        return true;
      } catch (err) {
        console.warn(`[${tag}] Login failed: ${err.message}`);
        return false;
      }
    }

    async function recover(url, res) {
      const detail =
        `status=${res.status} challenge=${Boolean(res.challenge)} ` +
        `expired=${Boolean(res.authExpired)}`;

      backoff();

      // Reject the proxy that was actually just refused, without forcing
      // an immediate rotation that would consume an extra proxy on renewal.
      // The next call to currentProxy() (from fetchHtml or sidecarLogin)
      // will naturally skip the one on cooldown.
      rejectCurrentProxy(`read refused (${detail})`);

      if (await renew(`read refused (${detail})`)) {
        const retry = await fetchHtml(url, { cookie: await currentCookie() });
        if (!isAuthFailure(retry)) {
          console.log(
            `[${tag}] The renewed session works; the earlier failure was the cookie, not the account.`,
          );
          decayBackoff();
          return { ...retry, account: 0 };
        }
        // Renewal worked but the page is still refused — mark this proxy too.
        rejectCurrentProxy(`still refused after session renewal (${detail})`);
      }

      const maxRotations = envInt('ROSTER_LORD_MAX_ROTATIONS', DEFAULT_MAX_ROTATIONS);
      for (let attempt = 0; attempt < maxRotations; attempt += 1) {
        // Each account rotation also gets a fresh proxy.
        rejectCurrentProxy(`account rotation attempt ${attempt + 1}`);
        rotateCredentials();
        if (!(await renew('still refused after renewal', { force: true }))) continue;
        const retry = await fetchHtml(url, { cookie: await currentCookie() });
        if (!isAuthFailure(retry)) {
          console.log(`[${tag}] Account switched and the read works again.`);
          decayBackoff();
          return { ...retry, account: 0 };
        }
      }

      blocked = true;
      blockedReason = 'the source is refusing every configured account';
      console.warn(`[${tag}] ${blockedReason}; stopping so it is left alone.`);
      return fail(res.status);
    }

    return {
      get blocked() {
        return blocked;
      },
      get blockedReason() {
        return blockedReason;
      },
      get stripe() {
        return 1;
      },

      async fetch(playerId) {
        if (blocked) return fail();
        const urlObj = new URL(`/lord/${playerId}`, BASE);
        if (date) urlObj.searchParams.set('selected_date', date);
        const url = urlObj.toString();
        await pace();
        const res = await fetchHtml(url, { cookie: await currentCookie() });
        return isAuthFailure(res) ? recover(url, res) : (decayBackoff(), { ...res, account: 0 });
      },

      read,
      close,
    };
  }

  // -------------------------------------------------------------- striped ---

  /**
   * Each account spends its own page budget, and a refused account rests for
   * ROSTER_ACCOUNT_COOLDOWN_MS while the next one takes over. The total request
   * rate is unchanged - the pace above is shared - so this only ever raises the
   * number of pages a run can read before the wall, never the rate at which it
   * reads them.
   */
  const cooldownMs = envInt('ROSTER_ACCOUNT_COOLDOWN_MS', DEFAULT_ACCOUNT_COOLDOWN_MS);
  const cookies = new Array(stripeCount).fill(null);
  const coolingUntil = new Array(stripeCount).fill(0);
  let nextAccount = 0;

  async function refreshAccount(index) {
    try {
      const { cookies: fresh } = await sidecarLogin(accounts[index]);
      if (!Array.isArray(fresh) || !fresh.length) return null;
      cookies[index] = fresh;
      try {
        await saveAccountSession(index, { cookies: fresh, savedAt: Date.now() });
      } catch {
        // A read-only session is still usable for this run.
      }
      console.log(`[${tag}] Account ${index + 1}/${stripeCount} logged in.`);
      return fresh;
    } catch (err) {
      console.warn(`[${tag}] Account ${index + 1} login failed: ${err.message}`);
      return null;
    }
  }

  async function ensureCookies(index) {
    if (cookies[index]) return cookies[index];
    let saved = null;
    try {
      saved = await loadAccountSession(index);
    } catch {
      saved = null;
    }
    if (saved && Array.isArray(saved.cookies) && saved.cookies.length) {
      cookies[index] = saved.cookies;
      return saved.cookies;
    }
    return refreshAccount(index);
  }

  return {
    get blocked() {
      return blocked;
    },
    get blockedReason() {
      return blockedReason;
    },
    get stripe() {
      return stripeCount;
    },

    async fetch(playerId) {
      if (blocked) return fail();
      const urlObj = new URL(`/lord/${playerId}`, BASE);
      if (date) urlObj.searchParams.set('selected_date', date);
      const url = urlObj.toString();

      for (let attempt = 0; attempt < stripeCount; attempt += 1) {
        let chosen = -1;
        for (let step = 0; step < stripeCount; step += 1) {
          nextAccount = (nextAccount + 1) % stripeCount;
          if (coolingUntil[nextAccount] <= Date.now()) {
            chosen = nextAccount;
            break;
          }
        }
        if (chosen < 0) {
          blocked = true;
          blockedReason = 'every account is cooling after refusals';
          console.warn(`[${tag}] ${blockedReason}; stopping so they are left alone.`);
          return fail();
        }

        await pace();
        const current = await ensureCookies(chosen);
        if (!current) {
          coolingUntil[chosen] = Date.now() + Math.min(cooldownMs, 5 * 60 * 1000);
          continue;
        }

        const res = await fetchHtml(url, { cookie: cookieString(current) });
        if (!isAuthFailure(res)) {
          decayBackoff();
          return { ...res, account: chosen };
        }

        backoff();

        console.warn(
          `[${tag}] Account ${chosen + 1}/${stripeCount} refused ` +
            `(status=${res.status} challenge=${Boolean(res.challenge)}); renewing its session.`,
        );

        // Rotate the proxy first — an IP block survives session renewal.
        rejectCurrentProxy(`account ${chosen + 1} refused`);

        const refreshed = await refreshAccount(chosen);
        if (refreshed) {
          const retry = await fetchHtml(url, { cookie: cookieString(refreshed) });
          if (!isAuthFailure(retry)) { decayBackoff(); return { ...retry, account: chosen }; }
        }

        const minutes = Math.ceil(cooldownMs / 60000);
        console.warn(
          `[${tag}] Account ${chosen + 1}/${stripeCount} still refused; resting it for ${minutes} minute(s).`,
        );
        coolingUntil[chosen] = Date.now() + cooldownMs;
      }

      blocked = true;
      blockedReason = 'every account refused or resting';
      console.warn(`[${tag}] ${blockedReason}; stopping so the source is left alone.`);
      return fail();
    },

    read,
    close,
  };
}

module.exports = { createLordSource };