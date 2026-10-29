/**
 * Enriches published player files with callofstats-only data.
 *
 *   npm run enrich -- --server 973
 *   npm run enrich -- --server 973 --concurrency 1
 *   npm run enrich -- --server 973 --date 2026-10-27
 *   npm run enrich -- --server 973 --out ./.enrich-test   write locally
 *   npm run enrich -- --server 973 --dry-run              fetch and merge, write nothing
 *
 * For every player in the archive it visits /lord/{id} on callofstats and
 * extracts the fields callofstats has that dragonstats does not:
 *
 *   - name history (previous names)
 *   - gallery album images with likes
 *   - avatar URL
 *   - T1-T5 kills, division, king/leadership time, ToC / RoW stats,
 *     resource assistance, and every other stat on the lord page
 *
 * Writes are additive via src/roster/merge.js: callofstats never erases what
 * dragonstats recorded, and dragonstats never erases what callofstats recorded.
 *
 * Transport: headless Playwright with the saved callofstats session. When the
 * session expires, re-login with the next account. Players are processed
 * sequentially (concurrency 1 recommended) with delays between requests to
 * avoid triggering callofstats' rate limiting.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { sandboxEnabled } = require('../src/browser');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');
const { mergeFile } = require('../src/roster/merge');
const { sectionFor } = require('../src/roster/sections');

const BASE = 'https://callofstats.com';
const PLAYERS_PREFIX = 'players/';

function parseArgs(argv) {
  const args = {
    server: null,
    date: null,
    out: null,
    concurrency: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server') args.server = argv[++i];
    else if (arg === '--date') args.date = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]) || 1;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run enrich -- --server 973 [--date YYYY-MM-DD] [--concurrency N] [--out <dir>] [--dry-run]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.server) throw new Error('--server is required, for example --server 973');
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${args.date}"`);
  }
  return args;
}

function describe(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function createStore({ dir }) {
  if (dir) {
    const resolve = (key) => path.join(dir, key);
    return {
      label: path.resolve(dir),
      async get(key) {
        try {
          return JSON.parse(fs.readFileSync(resolve(key), 'utf8'));
        } catch (err) {
          if (err.code === 'ENOENT') return null;
          throw err;
        }
      },
      async put(key, value) {
        const file = resolve(key);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const body = JSON.stringify(value);
        fs.writeFileSync(file, body);
        return Buffer.byteLength(body);
      },
      async list(prefix) {
        const base = resolve(prefix);
        if (!fs.existsSync(base)) return [];
        return fs.readdirSync(base).map((name) => `${prefix}/${name}`);
      },
    };
  }

  return {
    label: `R2 bucket "${r2.config().bucket}"`,
    async get(key) {
      try {
        return await r2.getJson(key);
      } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    put(key, value, options) {
      return r2.putJson(key, value, options);
    },
    list(prefix) {
      return r2.listKeys(prefix);
    },
  };
}

function accountList() {
  const split = (value) =>
    String(value || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

  const users = split(process.env.CALLOFSTATS_USERNAMES || process.env.CALLOFSTATS_USERNAME);
  if (!users.length) return [];

  const passwordRaw = String(
    process.env.CALLOFSTATS_PASSWORDS || process.env.CALLOFSTATS_PASSWORD || '',
  ).trim();
  const passwords = split(passwordRaw);

  const aligned =
    passwords.length === users.length
      ? passwords
      : users.length === 1
        ? [passwordRaw]
        : passwords;

  return users
    .map((username, index) => ({ username, password: aligned[index] || '' }))
    .filter((account) => account.password);
}

/**
 * Extracts enrichment data from a rendered callofstats lord page.
 */
function extractLordData(page) {
  return page.evaluate(() => {
    const data = {
      nameHistory: [],
      albums: [],
      avatar: null,
      stats: {},
      date: null,
    };

    // Date the data refers to
    let lordDate = null;
    const dateEl = document.querySelector('[data-current-date]');
    if (dateEl) lordDate = dateEl.getAttribute('data-current-date');
    if (!lordDate && document.body) lordDate = document.body.getAttribute('data-current-date');
    if (!lordDate && document.documentElement) lordDate = document.documentElement.getAttribute('data-current-date');
    data.date = lordDate;

    // Avatar - skip the placeholder image
    let avatar = null;
    const avatars = document.querySelectorAll('img.profile-picture, .profile-picture > img');
    for (const img of avatars) {
      const src = img.src || img.getAttribute('data-src') || '';
      if (!src.includes('codweb_all_three_avatar') && !src.includes('/static/')) {
        avatar = img.src || img.getAttribute('data-src') || null;
        break;
      }
    }
    data.avatar = avatar;

    // Name history
    document.querySelectorAll('.history-item').forEach((el) => {
      const name = el.textContent.replace(/\s+/g, ' ').trim();
      if (name && !data.nameHistory.includes(name)) data.nameHistory.push(name);
    });

    // Gallery album images with likes
    document.querySelectorAll('.gallery-item').forEach((el) => {
      const img = el.querySelector('img');
      const likeCount = el.querySelector('.gallery-like-count');
      const likeHeart = el.querySelector('.gallery-heart');
      const emptySlot = el.querySelector('.empty-slot');

      if (emptySlot) return;

      const url = img ? (img.src || img.getAttribute('data-src')) : null;
      if (!url) return;

      let likes = null;
      if (likeCount) likes = likeCount.textContent.replace(/\s+/g, ' ').trim();
      else if (likeHeart) likes = likeHeart.textContent.replace(/\s+/g, ' ').trim();

      const alt = img ? img.alt || null : null;
      let postedAt = null;
      if (url) {
        const dateMatch = url.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) postedAt = dateMatch[1];
      }

      data.albums.push({
        url,
        likes,
        postedAt: postedAt || data.date || null,
        caption: alt || null,
      });
    });

    // All stats
    document.querySelectorAll('.stat-item').forEach((item) => {
      const label = item.querySelector('.subtle');
      const value = item.querySelector('.value');
      if (label && value) {
        data.stats[label.textContent.replace(/\s+/g, ' ').trim()] =
          value.textContent.replace(/\s+/g, ' ').trim();
      }
    });

    return data;
  });
}

/**
 * Turns extracted lord-page data into the fields we merge into a player file.
 */
function enrichPlayer(player, lordData, targetDate) {
  const date = targetDate || lordData.date;

  const incoming = JSON.parse(JSON.stringify(player));

  // Non-date fields: always merge when available
  if (lordData.avatar) incoming.avatar = lordData.avatar;
  if (lordData.nameHistory && lordData.nameHistory.length) {
    incoming.nameHistory = [...new Set([...(incoming.nameHistory || []), ...lordData.nameHistory])];
  }
  if (lordData.albums && lordData.albums.length) {
    incoming.albums = [...(incoming.albums || [])];
    const existingUrls = new Set(incoming.albums.map((a) => a.url));
    for (const album of lordData.albums) {
      if (!existingUrls.has(album.url)) {
        incoming.albums.push(album);
        existingUrls.add(album.url);
      }
    }
  }

  // Date-specific fields: stats and byDate entry
  if (!date) {
    const existingDates = incoming.dates || [];
    if (existingDates.length && Object.keys(lordData.stats || {}).length) {
      incoming.dates = [...new Set(existingDates)].sort().reverse();
    }
    return incoming;
  }

  incoming.dates = [...new Set([...(incoming.dates || []), date])].sort().reverse();

  const existingEntry = incoming.byDate && incoming.byDate[date];
  const entry = {
    name: existingEntry?.name || player.name || null,
    rank: existingEntry?.rank ?? null,
    power: existingEntry?.power ?? null,
    avatar: lordData.avatar || existingEntry?.avatar || null,
    alliance: existingEntry?.alliance || null,
    sections: [],
  };

  const bySection = new Map();
  const existingSections = (existingEntry?.sections || []).reduce((acc, s) => {
    acc.set(s.section, new Set(s.rows.map((r) => r.label)));
    return acc;
  }, new Map());
  for (const [label, value] of Object.entries(lordData.stats || {})) {
    const section = sectionFor(label);
    const existingLabels = existingSections.get(section);
    if (existingLabels && existingLabels.has(label)) continue;
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push({ label, value });
  }
  entry.sections = [...bySection].map(([section, rows]) => ({ section, rows }));

  if (!incoming.metrics) incoming.metrics = {};
  const existingMetrics = player.metrics?.[date] || {};
  const metrics = {};
  for (const [label, value] of Object.entries(lordData.stats || {})) {
    if (label in existingMetrics) continue;
    const parsed = Number(value.replace(/,/g, ''));
    metrics[label] = Number.isFinite(parsed) ? parsed : value;
  }
  if (Object.keys(metrics).length) {
    incoming.metrics[date] = { ...existingMetrics, ...metrics };
  }

  if (!incoming.byDate) incoming.byDate = {};
  incoming.byDate[date] = entry;

  return incoming;
}

/**
 * Processes players sequentially with one browser context, re-logging in when
 * the session expires.
 */
async function processPlayers(pw, accounts, store, playerIds, targetDate, dryRun) {
  const results = { processed: 0, skipped: 0, errors: [], bytes: 0 };
  let accountIdx = 0;

  const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: sandboxEnabled() });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);

  async function login() {
    const account = accounts[accountIdx % accounts.length];
    accountIdx += 1;
    console.log(`  Logging in as ${account.username} (account ${accountIdx} of ${accounts.length})`);

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', account.username);
    await page.fill('input[name="password"]', account.password);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
      page.click('button[type="submit"]').catch(() => page.click('form button')),
    ]);

    if ((page.url() || '').includes('/login')) {
      const err = new Error(`CallofStats rejected credentials for ${account.username}`);
      err.code = 'BAD_CREDENTIALS';
      throw err;
    }
  }

  async function gotoLord(playerId) {
    const url = `${BASE}/lord/${playerId}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);

      if (page.url().includes('/login') || !page.url().includes('/lord/')) {
        try {
          await login();
        } catch (err) {
          if (accountIdx >= accounts.length * 2) {
            console.warn(`  All accounts exhausted`);
            return false;
          }
          continue;
        }
        continue;
      }
      return true;
    }
    return false;
  }

  try {
    await login();

    for (const playerId of playerIds) {
      try {
        const key = `players/${playerId}.json`;
        let existing;
        try {
          existing = await store.get(key);
        } catch (getErr) {
          console.warn(`store.get(${key}) threw:`, getErr.message);
          results.errors.push({ playerId, message: `store.get: ${getErr.message}` });
          continue;
        }
        if (!existing) {
          results.skipped += 1;
          continue;
        }

        // Skip players that already have avatar populated (fully enriched)
        if (existing.avatar && existing.avatar.includes('image-proxy')) {
          results.skipped += 1;
          continue;
        }

        const ok = await gotoLord(playerId);
        if (!ok) {
          results.errors.push({ playerId, message: 'Could not reach lord page' });
          console.warn(`  player ${playerId}: cannot reach lord page`);
          continue;
        }

        const lordData = await extractLordData(page);
        const enriched = enrichPlayer(existing, lordData, targetDate);
        const merged = mergeFile('player', existing, enriched);

        if (!dryRun) {
          const bytes = await store.put(key, merged, { cacheControl: 'public, max-age=3600' });
          results.bytes += bytes;
        }

        results.processed += 1;
        if (results.processed % 10 === 0) {
          console.log(`  ${results.processed} processed, ${results.skipped} skipped`);
        }

        // Delay between players to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (err) {
        results.errors.push({ playerId, message: err.message });
        console.warn(`  player ${playerId}: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out && !args.dryRun && !r2.configured()) {
    throw new Error(
      `R2 is not configured (missing ${r2.describeMissing()}). ` +
        'Add the R2_* variables to .env, or pass --out <dir> to write locally.',
    );
  }

  const accounts = accountList();
  if (!accounts.length) {
    throw new Error('No callofstats accounts configured. Set CALLOFSTATS_USERNAME/PASSWORD.');
  }
  const concurrency = Math.min(args.concurrency || 1, accounts.length);
  console.log(`[ENRICH] Using ${concurrency} concurrency with ${accounts.length} account(s)`);

  const store = createStore({ dir: args.out });

  const playerKeys = await store.list(PLAYERS_PREFIX);
  const playerIds = playerKeys.map((key) => path.basename(key, '.json'));
  console.log(`[ENRICH] Found ${playerIds.length} player files in ${store.label}`);

  const pw = require('playwright');

  // Shard players across concurrency
  const shards = [];
  const shardSize = Math.ceil(playerIds.length / concurrency);
  for (let i = 0; i < playerIds.length; i += shardSize) {
    shards.push(playerIds.slice(i, i + shardSize));
  }

  const started = Date.now();
  const shardResults = await Promise.all(
    shards.map((ids) => processPlayers(pw, accounts, store, ids, args.date, args.dryRun)),
  );

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalBytes = 0;
  for (const r of shardResults) {
    totalProcessed += r.processed;
    totalSkipped += r.skipped;
    totalErrors += r.errors.length;
    totalBytes += r.bytes;
    for (const e of r.errors) {
      console.warn(`[ENRICH] error: player ${e.playerId}: ${e.message}`);
    }
  }

  console.log(
    `[ENRICH] Done: ${totalProcessed} processed, ${totalSkipped} skipped, ${totalErrors} errors, ` +
      `${describe(totalBytes)}, ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  if (totalErrors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[ENRICH] Failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
