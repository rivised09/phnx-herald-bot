/**
 * Full scrape of callofstats.com for one server.
 *
 *   npm run callofstats:scrape -- --server 973
 *   npm run callofstats:scrape -- --server 973 --concurrency 4
 *   npm run callofstats:scrape -- --server 973 --out ./.cof-test   write locally
 *   npm run callofstats:scrape -- --server 973 --dry-run              fetch and merge, write nothing
 *
 * Crawl chain:
 *   /server/{id}   -> alliances + their member players (each carries player_id)
 *   /lord/{id}     -> one player in depth (avatar, name history, gallery
 *                     albums with likes, all stats)
 *
 * Since callofstats publishes current data only, each run captures today's
 * date. Run it periodically to add new dates; older dates already in R2 get
 * their missing fields filled in additively.
 *
 * Files are written snapshot/player/alliance first and index.json last, same
 * as the dragonstats scrape, so a reader never sees a partial publish.
 *
 * Parallelism: N Playwright browser contexts, each logging in with a separate
 * callofstats account. Players are sharded across contexts.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { chromium } = require('playwright');
const r2 = require('../src/roster/r2');
const { mergeFile } = require('../src/roster/merge');

const BASE = 'https://callofstats.com';
const PLAYERS_PREFIX = 'players/';
const ALLIANCES_PREFIX = 'alliances/';
const SNAPSHOTS_PREFIX = 'snapshots/';

function parseArgs(argv) {
  const args = {
    server: null,
    concurrency: null,
    out: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server') args.server = argv[++i];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]) || 4;
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run callofstats:scrape -- --server 973 [--concurrency N] [--out <dir>] [--dry-run]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.server) throw new Error('--server is required, for example --server 973');
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

/** The date this scrape captures - today in YYYY-MM-DD. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * One authenticated browser context using a specific callofstats account.
 */
class AuthedContext {
  constructor(index, pw, accounts) {
    this.index = index;
    this.pw = pw;
    this.accounts = accounts;
    this.accountIdx = index % accounts.length;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async start() {
    this.browser = await this.pw.chromium.launch({ headless: true });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);
    this.page.setDefaultNavigationTimeout(30000);
    await this.login();
    return this;
  }

  async login() {
    const account = this.accounts[this.accountIdx % this.accounts.length];
    this.accountIdx += 1;

    const page = this.page;
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
    console.log(`  [context ${this.index}] logged in as ${account.username}`);
  }

  /**
   * Navigate to a lord page and wait for client-rendered content.
   * Returns false if we can't reach it even after re-login.
   */
  async gotoLord(playerId) {
    const url = `${BASE}/lord/${playerId}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      try {
        await this.page.waitForSelector('.stat-item, .gallery-item, .history-item', {
          timeout: 8000,
        });
      } catch {
        // Selector might not exist on all pages
      }

      if (this.page.url().includes('/login') || !this.page.url().includes('/lord/')) {
        await this.login();
        continue;
      }
      return true;
    }
    return false;
  }

  async close() {
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
  }
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
 * Turns extracted lord-page data into a player file entry for one date.
 */
function enrichPlayer(player, lordData, targetDate) {
  const date = targetDate || lordData.date || today();

  const incoming = JSON.parse(JSON.stringify(player));

  // Non-date fields
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

  // If we have no name from existing data, try to get it from the page
  if (!entry.name && player.name) entry.name = player.name;

  const sectionFor = (label) => {
    const l = label.toLowerCase();
    if (l.includes('kill') || l.includes('defeat') || l.includes('victor') || l.includes('siege') || l.includes('scout')) return 'War Stats';
    if (l.includes('gather') || l.includes('assistance') || l.includes('resource')) return 'Gathered Resources';
    if (l.includes('spent')) return 'Historic Resources Spent';
    if (l.includes('merit') || l.includes('behemoth') || l.includes('build') || l.includes('destruction')) return 'Advanced War Stats';
    if (l.includes('donation') || l.includes('helps given')) return 'Alliance Activity';
    if (l.includes('season') || l.includes('historical')) return 'Historical Season Stats';
    if (l.includes('toc')) return 'ToC Stats';
    if (l.includes('row')) return 'RoW Stats';
    if (l.includes('power') || l.includes('troop') || l.includes('building') || l.includes('hero') || l.includes('tech') || l.includes('policy')) return 'Power Spread';
    return 'Callof Stats';
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
 * Processes one shard of players with one account context.
 */
async function processShard(ctx, store, playerIds, targetDate, dryRun) {
  const results = { processed: 0, skipped: 0, errors: [], newPlayers: 0 };

  for (const playerId of playerIds) {
    try {
      const key = `players/${playerId}.json`;
      let existing;
      try {
        existing = await store.get(key);
      } catch (getErr) {
        console.warn(`  [context ${ctx.index}] store.get(${key}) threw:`, getErr.message);
        results.errors.push({ playerId, message: `store.get: ${getErr.message}` });
        continue;
      }

      const ok = await ctx.gotoLord(playerId);
      if (!ok) {
        results.errors.push({ playerId, message: 'Could not reach lord page after retries' });
        console.warn(`  [context ${ctx.index}] player ${playerId}: cannot reach lord page`);
        continue;
      }

      const lordData = await extractLordData(ctx.page);

      const playerName = lordData.stats?.['Current Power'] ? null : null;
      // Try to get the player name from the page title or stats
      const pageTitle = await ctx.page.title().catch(() => '');
      const nameMatch = pageTitle.match(/Lord Profile — (.+) \|/);
      const lordName = nameMatch ? nameMatch[1] : null;

      const enriched = enrichPlayer(existing, lordData, targetDate);
      if (lordName && !enriched.name) enriched.name = lordName;

      const merged = mergeFile('player', existing, enriched);

      if (!dryRun) {
        const bytes = await store.put(key, merged, { cacheControl: 'public, max-age=3600' });
        results.bytes = (results.bytes || 0) + bytes;
      }

      results.processed += 1;
      if (!existing) results.newPlayers += 1;
      if (results.processed % 25 === 0) {
        console.log(`  [context ${ctx.index}] ${results.processed}/${playerIds.length} players`);
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (err) {
      results.errors.push({ playerId, message: err.message });
      console.warn(`  [context ${ctx.index}] player ${playerId}: ${err.message}`);
    }
  }

  return results;
}

/** Shards an array into N roughly equal chunks. */
function shard(array, n) {
  const chunks = Array.from({ length: n }, () => []);
  array.forEach((item, i) => chunks[i % n].push(item));
  return chunks;
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
  const concurrency = Math.min(args.concurrency || accounts.length, accounts.length);
  console.log(`[CALLSTATS] Using ${concurrency} context(s) with ${accounts.length} account(s)`);
  console.log(`[CALLSTATS] Server: #${args.server}`);

  const store = createStore({ dir: args.out });
  const targetDate = today();
  console.log(`[CALLSTATS] Target date: ${targetDate}`);

  // Gather every player file already in R2 (we enrich these, don't re-discover)
  const playerKeys = await store.list(PLAYERS_PREFIX);
  const playerIds = playerKeys.map((key) => path.basename(key, '.json'));
  console.log(`[CALLSTATS] Found ${playerIds.length} existing player files in ${store.label}`);

  const shards = shard(playerIds, concurrency);
  const pw = require('playwright');

  const started = Date.now();
  const shardResults = await Promise.all(
    shards.map((ids, i) =>
      (async () => {
        let ctx;
        try {
          ctx = new AuthedContext(i, pw, accounts);
          await ctx.start();
          return await processShard(ctx, store, ids, targetDate, args.dryRun);
        } catch (err) {
          console.warn(`[CALLSTATS] context ${i} failed: ${err.message}`);
          return { processed: 0, skipped: 0, errors: [], bytes: 0, newPlayers: 0 };
        } finally {
          if (ctx) await ctx.close();
        }
      })(),
  ));

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalNewPlayers = 0;
  let totalBytes = 0;
  for (const r of shardResults) {
    totalProcessed += r.processed;
    totalSkipped += r.skipped;
    totalErrors += r.errors.length;
    totalNewPlayers += r.newPlayers || 0;
    totalBytes += r.bytes || 0;
    for (const e of r.errors) {
      console.warn(`[CALLSTATS] error: player ${e.playerId}: ${e.message}`);
    }
  }

  console.log(
    `[CALLSTATS] Done: ${totalProcessed} processed, ${totalNewPlayers} new, ${totalSkipped} skipped, ` +
      `${totalErrors} errors, ${describe(totalBytes)}, ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  if (totalErrors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[CALLSTATS] Failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
