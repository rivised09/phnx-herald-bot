const { requirePlaywright } = require('./session');

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
 * Runs `work(parser)` with a single browser page for the duration.
 *
 * `parser.parse(html, reader)` installs the document and evaluates the reader
 * in it. Keeping one page alive across the run is what makes parsing cheap:
 * the launch, not the parse, is the expensive part.
 */
async function withParser(work) {
  const pw = requirePlaywright();
  const browser = await pw.chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(PARSE_TIMEOUT_MS);

    const parser = {
      async parse(html, reader) {
        if (!html) return null;
        await page.setContent(clean(html), { waitUntil: 'commit' });
        return page.evaluate(reader);
      },
    };

    return await work(parser);
  } finally {
    await browser.close();
  }
}

module.exports = { withParser };
