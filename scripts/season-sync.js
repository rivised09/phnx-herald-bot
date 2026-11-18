/**
 * Publishes `seasons.json` - the KVK season table (label, kingdom list, start
 * and end) the player profile uses for its Division row.
 *
 *   npm run seasons
 *   npm run seasons -- --server 973
 *
 * Reads https://dragonstats.com/kvk/list in a browser (the same gate the
 * scrapper mints) and writes one small file. Scrapes refresh it automatically;
 * run this by hand when the season table changes without a scrape.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');
const { publishSeasons, seasonOn } = require('../src/roster/seasons');

function parseArgs(argv) {
  const args = { server: '973' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--server') args.server = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!r2.configured()) throw new Error(`R2 is not configured (missing ${r2.describeMissing()}).`);
  const store = {
    put: (key, value, options) => r2.putJson(key, value, options),
  };

  const payload = await publishSeasons(store, { server: args.server });
  const mine = payload.seasons.filter((season) => season.servers.includes(Number(args.server)));
  console.log(
    `[SEASONS] wrote seasons.json: ${payload.seasons.length} seasons; #${args.server} plays ${mine
      .map((season) => `${season.label} (${season.start} - ${season.end || '?'}, ${season.status || '?'})`)
      .join(', ')}`,
  );
  for (const date of [new Date().toISOString().slice(0, 10)]) {
    const season = seasonOn(payload.seasons, args.server, date);
    console.log(`[SEASONS] today (${date}) -> ${season ? season.label : 'no season'}`);
  }
}

main().catch((err) => {
  console.error(`[SEASONS] failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
