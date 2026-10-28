/**
 * Dry run: turn the newest DragonStats scan for one server into our files.
 *
 *   npm run dragon:map -- --server 973
 *   npm run dragon:map -- --server 973 --date 2026-10-26 --out data/dragon-out
 *
 * Nothing is uploaded and nothing existing is touched: the output is written to
 * a scratch directory so it can be compared with the archive we publish today.
 * `--existing <dir>` points at an export to borrow alliance ids from, so the
 * day links to the same alliance pages as the callofstats days.
 */
const fs = require('fs');
const path = require('path');

const api = require('../src/dragon/api');
const map = require('../src/dragon/map');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const SERVER = arg('server', '973');
const DATE = arg('date', null);
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'data', 'dragon-out')));
const EXISTING = arg('existing', null);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** name -> id from the newest snapshot we already publish for this server. */
function existingAllianceIds(dir, server) {
  if (!dir || !fs.existsSync(dir)) return {};
  const snapshots = path.join(dir, 'snapshots');
  if (!fs.existsSync(snapshots)) return {};
  const files = fs
    .readdirSync(snapshots)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();
  for (const file of files) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(snapshots, file), 'utf8'));
      if (String(snapshot.server?.id) !== String(server)) continue;
      const out = {};
      for (const alliance of snapshot.alliances || []) {
        if (alliance?.name && alliance?.id) out[alliance.name] = alliance.id;
      }
      console.log(`[DRAGON] Alliance ids borrowed from ${file} (${Object.keys(out).length} alliances).`);
      return out;
    } catch {
      continue;
    }
  }
  return {};
}

(async () => {
  const { scan, url, createdAt, server } = await api.withClient(async (client, gate) => {
    const found = await api.findServer(client, gate, SERVER);
    if (!found) throw new Error(`DragonStats does not track server #${SERVER}.`);
    const latest = await api.latestScan(client, gate, SERVER);
    if (!latest) throw new Error(`Server #${SERVER} has no scans on DragonStats yet.`);
    console.log(`[DRAGON] Server #${SERVER} -> ${found._id}`);
    console.log(`[DRAGON] Newest scan: ${latest.createdAt.toISOString()}`);
    const body = await api.fetchScan(latest.url);
    console.log(`[DRAGON] Scan: ${body.length} players, ${latest.url.split('/').pop()}`);
    return { scan: body, url: latest.url, createdAt: latest.createdAt, server: found };
  });

  const date = DATE || createdAt.toISOString().slice(0, 10);
  const built = map.fromScan(scan, {
    server: SERVER,
    date,
    existingAlliances: existingAllianceIds(EXISTING, SERVER),
  });

  writeJson(path.join(OUT, 'snapshots', `${date}.json`), built.snapshot);
  for (const [id, file] of built.players) writeJson(path.join(OUT, 'players', `${id}.json`), file);
  for (const alliance of built.alliances) writeJson(path.join(OUT, 'alliances', `${alliance.id}.json`), {
    id: alliance.id,
    name: alliance.name,
    dates: [date],
    byDate: {
      [date]: {
        name: alliance.name,
        rank: alliance.rank,
        power: Number(alliance.stats.Power.replace(/,/g, '')),
        memberCount: Number(alliance.stats.Members),
        players: built.snapshot.players
          .filter((player) => player.allianceId === alliance.name)
          .map((player) => ({ id: player.id, name: player.name, rank: player.index, power: Number(player.stats.Power.replace(/,/g, '')) })),
      },
    },
  });

  const first = built.players.values().next().value;
  const metrics = Object.keys(first.metrics[date]).length;
  const sections = first.byDate[date].sections.length;

  console.log('');
  console.log(`[DRAGON] date ${date}`);
  console.log(`[DRAGON] players ${built.snapshot.players.length}, alliances ${built.alliances.length}`);
  console.log(`[DRAGON] per player: ${metrics} metrics in ${sections} sections`);
  console.log(`[DRAGON] wrote ${path.relative(process.cwd(), OUT)}`);

  console.log('\n[DRAGON] sections');
  for (const section of first.byDate[date].sections) {
    console.log(`  ${section.section || '(top)'}: ${section.rows.length} rows`);
  }

  console.log('\n[DRAGON] top 5 by power');
  for (const player of built.snapshot.players.slice(0, 5)) {
    console.log(`  #${player.stats.Rank.padStart(3)} ${player.name} - ${player.stats.Power} - ${player.allianceId || 'no alliance'}`);
  }
})().catch((err) => {
  console.error(`[DRAGON] ${err.message}`);
  process.exitCode = 1;
});
