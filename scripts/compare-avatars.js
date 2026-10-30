const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const r2 = require('../src/roster/r2');

function createStore() {
  return {
    async get(key) {
      try { return await r2.getJson(key); } catch { return null; }
    }
  };
}

async function main() {
  const playerId = '25718805';
  const store = createStore();
  const file = await store.get(`players/${playerId}.json`);
  if (!file) {
    console.log('File not found');
    return;
  }

  console.log(`Player: ${file.name}\n`);
  console.log('Avatar comparison:\n');

  const dates = ['2026-10-29', '2026-10-28', '2026-10-27', '2026-10-26', '2026-10-25'];
  for (const date of dates) {
    const avatar = file.byDate?.[date]?.avatar;
    const status = avatar ? 'YES' : 'NO';
    console.log(`${date}: ${status}`);
    if (avatar) {
      console.log(`  ${avatar.substring(0, 80)}...\n`);
    }
  }

  console.log('\nTop-level avatar:');
  console.log(`  ${file.avatar ? file.avatar.substring(0, 80) : 'empty'}...`);
}

main().catch(console.error);
