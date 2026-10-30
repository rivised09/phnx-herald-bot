const { requirePlaywright } = require('./session');
const { sandboxEnabled } = require('../browser');

/**
 * Turning fetched HTML into data.
 *
 * The readers in `extract.js` run against a DOM, so something has to provide
 * one. A browser is used rather than a string-parsing HTML library because it
 * is already a dependency, is known to match what the site's own scripts
 * produce, and costs little when it is launched once for a whole run instead
 * of once per page.
 *
 * HTML is fed in with setContent rather than navigated to: no request is made,
 * so this step needs no session and cannot hit the network.
 */

const PARSE_TIMEOUT_MS = 20000;

/**
 * Scripts are removed before the document is installed.
 *
 * The source ships inline scripts, and running them against a document whose
 * base is about:blank replaces the execution context mid-evaluate and fails
 * the read. They contribute markup, not structure, so dropping them changes
 * nothing about what the readers see - verified by comparing extracted rows
 * from raw HTML against the same page after its scripts had run: identical
 * sections, labels and values.
 */
function clean(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
}

/**
 * Opens one reusable browser page and returns the parser around it.
 *
 * `load` installs a document once, `evaluate` runs readers against it, and
 * `parse` is the one-shot combination. A caller reading several fields from the
 * same page should load once and evaluate each reader, instead of installing
 * the same document again per field.
 */
async function createParser() {
  const pw = requirePlaywright();
  const browser = await pw.chromium.launch({
    headless: true,
    chromiumSandbox: sandboxEnabled(),
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(PARSE_TIMEOUT_MS);

  // The parser needs markup, not the network: cleaned HTML has no scripts
  // and its relative URLs cannot resolve from about:blank, but an absolute
  // one - a font, an og:image - would still be fetched under Playwright's
  // fingerprint. Nothing here needs it, so nothing here may leave.
  await page.route('**/*', (route) => route.abort());

  return {
    async load(html) {
      if (!html) return false;
      await page.setContent(clean(html), { waitUntil: 'commit' });
      return true;
    },
    evaluate(reader) {
      return page.evaluate(reader);
    },
    async parse(html, reader) {
      if (!(await this.load(html))) return null;
      return this.evaluate(reader);
    },
    async close() {
      await browser.close();
    },
  };
}

/**
 * Runs `work(parser)` with a single browser page for the duration.
 *
 * Keeping one page alive across the run is what makes parsing cheap: the
 * launch, not the parse, is the expensive part.
 */
async function withParser(work) {
  const parser = await createParser();
  try {
    return await work(parser);
  } finally {
    await parser.close();
  }
}

module.exports = { createParser, withParser };
