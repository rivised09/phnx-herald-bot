/**
 * Reads a DragonStats websocket capture and prints what the dashboard asked for.
 *
 *   node scripts/dragon-frames.js [path-to-ws-frames.jsonl]
 *
 * DragonStats is a Convex client: every table on screen is the result of a
 * query named like `module:function`, sent as JSON over the socket. This turns
 * a capture from `npm run dragon:probe` into a readable list of
 *
 *   queryId  udfPath  args  ->  result size and top-level keys
 *
 * which is what a mapper needs: the function responsible for each table, the
 * arguments it needs (server id, date range) and the field names it returns.
 */
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(__dirname, '..', 'data', 'dragon-probe', 'ws-frames.jsonl');
const SAVE = process.argv.includes('--save');
const RESULTS_DIR = path.join(path.dirname(FILE), 'results');

function parseFrame(payload) {
  if (!payload) return null;
  let value = payload;
  if (typeof value !== 'string') value = String(value);
  try {
    const first = JSON.parse(value);
    if (typeof first === 'string') return JSON.parse(first);
    return first;
  } catch {
    return null;
  }
}

function parseValue(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function describeValue(raw) {
  const value = parseValue(raw);
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    return `object(${keys.length}: ${keys.slice(0, 12).join(', ')})`;
  }
  return typeof value;
}

function collectModifications(message) {
  const out = [];
  if (!message || typeof message !== 'object') return out;
  const batches = Array.isArray(message) ? message : [message];
  for (const batch of batches) {
    if (!batch || typeof batch !== 'object') continue;
    for (const mod of batch.modifications || []) out.push(mod);
    if (batch.udfPath) out.push(batch);
  }
  return out;
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`[DRAGON] No capture at ${FILE}. Run: npm run dragon:probe`);
    process.exitCode = 1;
    return;
  }

  const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
  const queries = new Map();
  const results = new Map();

  for (const line of lines) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    const message = parseFrame(frame.payload);
    if (!message) continue;

    for (const mod of collectModifications(message)) {
      if (mod.udfPath) {
        queries.set(String(mod.queryId ?? queries.size), {
          path: mod.udfPath,
          args: mod.args,
          dir: frame.dir,
        });
      }
      if (mod.type === 'QueryUpdated' && mod.queryId !== undefined) {
        const entry = queries.get(String(mod.queryId)) || { queryId: mod.queryId };
        entry.result = describeValue(mod.value);
        entry.resultBytes = typeof mod.value === 'string' ? mod.value.length : 0;
        entry.value = parseValue(mod.value);
        results.set(String(mod.queryId), entry);
      }
    }
  }

  console.log(`[DRAGON] ${lines.length} frames in ${path.basename(FILE)}`);
  if (!queries.size && !results.size) {
    console.log('[DRAGON] No Convex queries recognised. The dashboard may not have finished loading.');
    return;
  }

  for (const [id, entry] of [...queries].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`\nquery ${id}`);
    console.log(`  path: ${entry.path}`);
    console.log(`  args: ${JSON.stringify(entry.args)}`);
    if (entry.result) console.log(`  result: ${entry.result}${entry.resultBytes ? ` (${entry.resultBytes}B)` : ''}`);
    if (!SAVE || !entry.value) continue;

    // The result, as the mapper will see it.
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const name = String(entry.path || `query-${id}`).replace(/[^A-Za-z0-9_.-]+/g, '_');
    const file = path.join(RESULTS_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(entry.value, null, 2));
    console.log(`  saved: ${path.relative(process.cwd(), file)}`);

    const sample = Array.isArray(entry.value) ? entry.value[0] : entry.value;
    if (sample && typeof sample === 'object') {
      console.log(`  fields: ${Object.keys(sample).join(', ')}`);
      console.log(`  first:  ${JSON.stringify(sample).slice(0, 600)}`);
    }
  }
}

main();
