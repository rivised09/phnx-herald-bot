const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');

async function main() {
  const playerId = '25718805';
  const file = await r2.getJson(`players/${playerId}.json`);
  if (!file) { console.log('File not found'); return; }

  for (const date of ['2026-10-29', '2026-10-28', '2026-10-25']) {
    const entry = file.byDate?.[date];
    console.log(`\n=== ${date} ===`);
    console.log(`  avatar: ${entry?.avatar ? 'YES' : 'NO'}`);
    console.log(`  albums: ${entry?.albums?.length || 0} items`);
    if (entry?.albums?.length) {
      entry.albums.forEach((a, i) => {
        console.log(`    [${i}] url: ${(a.url || '').substring(0, 60)}...`);
        console.log(`        likes: ${a.likes ?? 'none'}`);
        console.log(`        caption: ${a.caption || 'none'}`);
        console.log(`        postedAt: ${a.postedAt || 'none'}`);
      });
    }
    console.log(`  achievements: ${entry?.achievements?.length || 0} items`);
    console.log(`  sections: ${entry?.sections?.length || 0} blocks`);
    if (entry?.sections?.length) {
      for (const section of entry.sections.slice(0, 3)) {
        console.log(`    [${section.section}] ${section.rows?.length || 0} rows`);
      }
    }
    // Check metrics
    const metrics = file.metrics?.[date];
    if (metrics) {
      const keys = Object.keys(metrics);
      console.log(`  metrics: ${keys.length} labels`);
      console.log(`    sample: ${keys.slice(0, 5).join(', ')}`);
    } else {
      console.log(`  metrics: NONE`);
    }
    // Check radar
    const radar = file.radar?.[date];
    if (radar) {
      console.log(`  radar: ${Object.keys(radar).length} labels`);
      console.log(`    sample: ${JSON.stringify(radar).substring(0, 120)}`);
    } else {
      console.log(`  radar: NONE`);
    }
  }
}

main().catch(console.error);