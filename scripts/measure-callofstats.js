const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const r2 = require('../src/roster/r2');
const { createLordSource } = require('../src/roster/lord');
const sidecar = require('../src/roster/sidecar');

const DATE = process.argv[2] || '2026-10-28';
const MODE = (process.argv[3] || 'stripe').toLowerCase();  // single | stripe
const STRIPE = Number(process.argv[4] || 4);
const LIMIT = Number(process.argv[5] || 0); // 0 = every id on the date's roster
const DELAY_MS = Number(process.argv[6] || 1500); // shared pace floor

(async () => {
  if (process.env.ROSTER_LORD_DELAY_MS) {
    console.log(`measure: ROSTER_LORD_DELAY_MS=${process.env.ROSTER_LORD_DELAY_MS} (from env)`);
  } else {
    console.log(`measure: using default gap ${DELAY_MS}ms (set ROSTER_LORD_DELAY_MS to override)`);
  }
  const snap = await r2.getJson(`snapshots/${DATE}.json`);
  const ids = [...new Set((snap.players || []).map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean))];
  const targets = LIMIT && LIMIT > 0 ? ids.slice(0, LIMIT) : ids;
  console.log(`measure: ${MODE}${MODE === 'stripe' ? ` x${STRIPE}` : ''}, ${targets.length} targets, date ${DATE}`);

  const source = createLordSource({ tag: 'MEASURE', stripe: MODE === 'stripe' ? STRIPE : 0 });

  let fetched = 0;
  let refused = 0;
  const byAccount = {};
  const firstRefusal = { page: null, url: null };
  const blocked = [];
  let accountUse = {};

  try {
    for (let index = 0; index < targets.length; index += 1) {
      const playerId = targets[index];
      if (source.blocked) {
        blocked.push(playerId);
        continue;
      }
      const res = await source.fetch(playerId);
      accountUse[res.account] = (accountUse[res.account] || 0) + 1;
      if (res.ok) {
        fetched += 1;
        process.stdout.write(`[${index + 1}/${targets.length}] acc${(res.account % STRIPE || 0) + 1} ok ${res.status} ${playerId}\r`);
      } else {
        refused += 1;
        byAccount[res.account] = (byAccount[res.account] || 0) + 1;
        if (!firstRefusal.page) {
          firstRefusal.page = index + 1;
          firstRefusal.url = res.url;
          firstRefusal.account = res.account;
        }
        process.stdout.write(`[${index + 1}/${targets.length}] acc${res.account + 1} REFUSED status=${res.status} ${playerId}\n`);
      }
      if (index % 20 === 0) process.stdout.write('\n');
    }
  } finally {
    await source.close();
    sidecar.shutdown();
  }

  console.log('\n-----------------------------');
  console.log('measure: results');
  console.log(`  targets: ${targets.length}`);
  console.log(`  fetched: ${fetched}`);
  console.log(`  refused: ${refused}`);
  console.log(`  blocked-remaining: ${blocked.length}`);
  if (firstRefusal.page) {
    console.log(`  first refusal: page ${firstRefusal.page} (${firstRefusal.url}) account ${firstRefusal.account + 1}`);
  }
  console.log('  refusals by account:', JSON.stringify(byAccount));
  console.log('  page uses by account:', JSON.stringify(accountUse));
  if (fetched + refused > 0) {
    const sustain = (fetched / (fetched + refused));
    console.log(`  sustain rate: ${(sustain * 100).toFixed(1)}%`);
  }
  process.exit(refused > 0 && fetched === 0 ? 1 : 0);
})().catch((err) => {
  console.error('measure: FATAL', err);
  sidecar.shutdown();
  process.exit(1);
});
