/**
 * What DragonStats actually gives us, for server 973.
 *
 *   npm run dragon:probe                 (read-only look around)
 *   npm run dragon:probe -- --act        (also switch comparison off + all columns)
 *
 * The dashboard is a Convex client: the table is not in the HTML, it arrives
 * over a websocket as query results. This records that traffic - function
 * paths, arguments, payloads - plus an inventory of the controls and the
 * rendered tables, all into data/dragon-probe/, so the mapping to our own
 * snapshot shape can be written from facts instead of guesses.
 *
 * Nothing here is a scraper yet; it is the map.
 */
const fs = require('fs');
const path = require('path');

const session = require('../src/dragon/session');

const OUT_DIR = path.join(__dirname, '..', 'data', 'dragon-probe');
const SERVER = (process.argv.find((arg) => arg.startsWith('--server=')) || '').split('=')[1] || '973';
const URL_ARG = (process.argv.find((arg) => arg.startsWith('--url=')) || '').split('=')[1] || null;
const HEADED = process.argv.includes('--headed');
const ACT = process.argv.includes('--act');
const WAIT_MS = Number((process.argv.find((arg) => arg.startsWith('--wait=')) || '').split('=')[1] || 12000);

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

function redact(value) {
  return String(value)
    .replace(JWT, '<jwt>')
    .replace(/("?(?:token|jwt|idToken|refreshToken|accessToken)"?\s*:\s*")[^"]{8,}"/gi, '$1<redacted>"');
}

async function inventory(page) {
  return page.evaluate(() => {
    const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const nodes = [
      ...document.querySelectorAll(
        'button, [role="button"], [role="switch"], [role="checkbox"], [role="combobox"], [role="tab"], [role="menuitemcheckbox"], input, select',
      ),
    ];
    return nodes
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        text: text(el).slice(0, 120),
        label: el.getAttribute('aria-label') || null,
        placeholder: el.getAttribute('placeholder') || null,
        type: el.getAttribute('type') || null,
        state: el.getAttribute('data-state') || el.getAttribute('aria-checked') || null,
        checked: 'checked' in el ? Boolean(el.checked) : null,
      }))
      .filter((item) => item.text || item.label || item.placeholder);
  });
}

async function tables(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('table')].map((table, index) => {
      const head = [...table.querySelectorAll('thead th, thead td')].map((cell) =>
        (cell.innerText || '').replace(/\s+/g, ' ').trim(),
      );
      const rows = [...table.querySelectorAll('tbody tr')].slice(0, 5).map((row) =>
        [...row.querySelectorAll('td, th')].map((cell) => ({
          text: (cell.innerText || '').replace(/\s+/g, ' ').trim(),
          title: cell.getAttribute('title'),
          value: cell.getAttribute('data-value'),
        })),
      );
      return {
        index,
        headers: head,
        rowCount: table.querySelectorAll('tbody tr').length,
        sampleRows: rows,
      };
    });
  });
}

/** Buttons/labels whose visible text or aria-label matches, with a count. */
async function find(page, pattern) {
  const re = new RegExp(pattern, 'i');
  return page.evaluate(({ source, flags }) => {
    const rx = new RegExp(source, flags);
    const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll('button, [role="switch"], [role="checkbox"], [role="combobox"], label, [role="tab"]')];
    return nodes
      .filter((el) => rx.test(text(el)) || rx.test(el.getAttribute('aria-label') || ''))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: text(el).slice(0, 100),
        label: el.getAttribute('aria-label'),
        role: el.getAttribute('role'),
        state: el.getAttribute('data-state') || el.getAttribute('aria-checked'),
      }))
      .slice(0, 20);
  }, { source: re.source, flags: re.flags });
}

(async () => {
  const pageUrl = URL_ARG ? new URL(URL_ARG, session.BASE).toString() : `${session.BASE}/dashboard/${SERVER}`;
  const slug = new URL(pageUrl).pathname.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root';
  const runDir = path.join(OUT_DIR, slug);
  fs.mkdirSync(runDir, { recursive: true });

  const frames = [];
  const requests = [];
  const consoleLines = [];
  const errors = [];

  const summary = await session.withPage(async (page) => {
    page.on('console', (message) => {
      const type = message.type();
      if (type !== 'error' && type !== 'warning') return;
      consoleLines.push({ type, text: redact(message.text()).slice(0, 500) });
    });
    page.on('pageerror', (err) => errors.push({ kind: 'pageerror', text: redact(err.message).slice(0, 500) }));
    page.on('requestfailed', (request) =>
      errors.push({ kind: 'requestfailed', url: redact(request.url()), reason: request.failure()?.errorText }),
    );
    page.on('response', (response) => {
      if (response.status() < 400) return;
      errors.push({ kind: 'http', status: response.status(), url: redact(response.url()).slice(0, 400) });
    });
    page.on('websocket', (ws) => {
      const url = redact(ws.url());
      ws.on('framesent', (frame) => frames.push({ dir: 'sent', url, payload: redact(frame.payload) }));
      ws.on('framereceived', (frame) => frames.push({ dir: 'recv', url, payload: redact(frame.payload) }));
    });
    page.on('request', (request) => {
      const type = request.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      requests.push({ method: request.method(), url: redact(request.url()), body: redact(request.postData() || '').slice(0, 2000) });
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_MS);
    await page.screenshot({ path: path.join(runDir, 'dashboard.png'), fullPage: true }).catch(() => {});

    const before = {
      url: page.url(),
      title: await page.title(),
      signedIn: await session.signedIn(page),
      bodyText: (await page.evaluate(() => document.body.innerText)).slice(0, 4000),
      inventory: await inventory(page),
      tables: await tables(page),
      controls: {
        comparison: await find(page, 'comparison'),
        columns: await find(page, 'column'),
        serverSearch: await find(page, 'server'),
      },
    };

    let acted = null;
    if (ACT) {
      const steps = [];
      steps.push({ step: 'comparison off', matches: before.controls.comparison.length });
      // A switch reports its state in data-state; anything that is "on" gets clicked.
      const switches = page.locator('[role="switch"][data-state="on"], [role="checkbox"][data-state="checked"], [role="switch"][aria-checked="true"]');
      const switchCount = await switches.count();
      for (let i = 0; i < switchCount; i += 1) {
        const el = switches.nth(i);
        const label = ((await el.getAttribute('aria-label')) || (await el.innerText().catch(() => '')) || '').trim();
        if (/comparison/i.test(label) || switchCount === 1) {
          await el.click({ timeout: 5000 }).catch(() => {});
          steps.push({ step: `clicked switch "${label.slice(0, 60)}"` });
        }
      }
      await page.waitForTimeout(2500);
      steps.push({ step: 'columns: see buttons matching "column"', matches: (await find(page, 'column')).map((item) => item.text || item.label) });
      acted = { steps, inventoryAfter: await inventory(page), tablesAfter: await tables(page) };
    }

    return { before, acted };
  }, { headless: !HEADED });

  fs.writeFileSync(path.join(runDir, 'ws-frames.jsonl'), frames.map((f) => JSON.stringify(f)).join('\n'));
  fs.writeFileSync(path.join(runDir, 'requests.json'), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.join(runDir, 'console.json'), JSON.stringify({ consoleLines, errors }, null, 2));
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));

  const sent = frames.filter((f) => f.dir === 'sent');
  const recv = frames.filter((f) => f.dir === 'recv');
  const paths = new Set();
  for (const frame of sent) {
    for (const match of frame.payload.matchAll(/"udfPath":"([^"]+)"/g)) paths.add(match[1]);
    for (const match of frame.payload.matchAll(/"path":"([^"]+)"/g)) paths.add(match[1]);
  }

  console.log(`\n[DRAGON] ${summary.before.url}`);
  console.log(`[DRAGON] title: ${summary.before.title}`);
  console.log(`[DRAGON] signed in: ${summary.before.signedIn}`);
  console.log(`[DRAGON] tables: ${summary.before.tables.map((t) => `${t.rowCount} rows / ${t.headers.length} columns`).join(' | ') || 'none'}`);
  console.log(`[DRAGON] ws frames: ${sent.length} sent, ${recv.length} received`);
  console.log(`[DRAGON] query paths seen: ${[...paths].join(', ') || 'none yet'}`);
  console.log(`[DRAGON] controls matching "comparison": ${summary.before.controls.comparison.length}`);
  console.log(`[DRAGON] controls matching "column": ${summary.before.controls.columns.length}`);
  console.log(`[DRAGON] console errors/warnings: ${consoleLines.length}, page errors: ${errors.length}`);
  for (const item of consoleLines.slice(0, 5)) console.log(`  ${item.type}: ${item.text.slice(0, 160)}`);
  for (const item of errors.slice(0, 8)) {
    console.log(`  ${item.kind}${item.status ? ' ' + item.status : ''}: ${(item.text || item.reason || item.url || '').slice(0, 160)}`);
  }
  if (summary.acted) console.log('[DRAGON] actions taken:', JSON.stringify(summary.acted.steps));
  console.log(`[DRAGON] written to ${path.relative(process.cwd(), runDir)}`);
})().catch((err) => {
  console.error(`[DRAGON] Probe failed: ${err.message}`);
  process.exitCode = 1;
});
