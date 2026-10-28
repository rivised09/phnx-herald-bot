/**
 * Checks roster JSON against the published shape (src/roster/contract.js).
 *
 * Two uses:
 *
 *   npm run conform -- --dir ./.export
 *       every file in an export, with the gaps and the additions summarised
 *
 *   npm run conform -- --file sample.json
 *       one payload from a source nobody has explored yet - the kind is
 *       inferred from its keys, so a sample pasted out of a browser is enough
 *
 *   npm run conform -- --explain
 *       the contract itself: every field, whether it is required, and which
 *       source is expected to supply it
 *
 * Missing required fields fail. Unknown fields never do - they are printed as
 * "new", because the rule is that a source may only add.
 */
const fs = require('fs');
const path = require('path');

const contract = require('../src/roster/contract');

function parseArgs(argv) {
  const args = { dir: null, file: null, kind: null, json: false, explain: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') args.dir = argv[++i];
    else if (arg === '--file') args.file = argv[++i];
    else if (arg === '--kind') args.kind = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--explain') args.explain = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run conform -- [--dir <dir> | --file <json> [--kind index|snapshot|player|alliance]] [--json] [--quiet] | --explain',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.dir && !args.file && !args.explain) {
    throw new Error('Nothing to check: pass --dir, --file, or --explain.');
  }
  return args;
}

const DIR_KINDS = {
  snapshots: 'snapshot',
  players: 'player',
  alliances: 'alliance',
};

/** A file's kind from where it sits, falling back to what its keys say. */
function kindOf(file, value) {
  if (path.basename(file) === 'index.json') return 'index';
  const parent = path.basename(path.dirname(file));
  if (DIR_KINDS[parent]) return DIR_KINDS[parent];
  return contract.inferKind(value);
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function summarise(results) {
  const summary = { files: results.length, failed: 0, missing: {}, type: {}, extra: {} };
  for (const result of results) {
    if (!result.ok) summary.failed += 1;
    for (const key of result.missing) summary.missing[key] = (summary.missing[key] || 0) + 1;
    for (const key of result.type) summary.type[key] = (summary.type[key] || 0) + 1;
    for (const key of result.extra) summary.extra[key] = (summary.extra[key] || 0) + 1;
  }
  return summary;
}

function printSummary(summary) {
  const failures = Object.keys(summary.missing).length + Object.keys(summary.type).length;
  if (!failures) {
    console.log(`[CONFORM] ${summary.files} files, no gaps.`);
  } else {
    console.log(`[CONFORM] ${summary.files} files, ${summary.failed} with gaps:`);
    for (const [key, count] of Object.entries(summary.missing).sort()) {
      console.log(`  missing  ${key}  (${count} file${count === 1 ? '' : 's'})`);
    }
    for (const [key, count] of Object.entries(summary.type).sort()) {
      console.log(`  wrong    ${key}  (${count} file${count === 1 ? '' : 's'})`);
    }
  }

  const extra = Object.keys(summary.extra).sort();
  if (extra.length) {
    console.log('[CONFORM] new fields present (kept, never an error):');
    for (const key of extra) console.log(`  + ${key}`);
  }
}

function explain() {
  for (const kind of Object.keys(contract.KINDS)) {
    console.log(`\n${kind}`);
    for (const field of contract.describe(kind)) {
      if (field.path === '<root>') continue;
      const mark = field.required ? '*' : ' ';
      const source = (field.source || '—').padEnd(9);
      console.log(`  ${mark} ${field.path.padEnd(34)} ${source} ${field.type}`);
    }
  }
  console.log('\n* = required. primary = new main source, fallback = callofstats, derived = computed by us.');
  console.log('Rule: missing required fields fail; unknown fields are added, never removed.');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.explain) {
    explain();
    return;
  }

  const files = args.dir ? walk(args.dir) : [args.file];
  if (!files.length) throw new Error(`No JSON files under ${args.dir}.`);

  const results = [];
  for (const file of files) {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      results.push({ file, kind: 'unknown', ok: false, missing: [`<unreadable: ${err.message}>`], type: [], extra: [] });
      continue;
    }
    const kind = args.kind || kindOf(file, value);
    if (!kind) {
      results.push({ file, kind: 'unknown', ok: false, missing: ['<kind could not be inferred>'], type: [], extra: [] });
      continue;
    }
    results.push({ file, ...contract.check(kind, value) });
  }

  const summary = summarise(results);
  if (args.json) {
    console.log(JSON.stringify({ summary, results: results.filter((item) => !item.ok) }, null, 2));
  } else if (!args.quiet) {
    for (const result of results) {
      if (result.ok && !result.extra.length) continue;
      const name = args.dir ? path.relative(args.dir, result.file) : result.file;
      const state = result.ok ? 'ok  ' : 'GAP ';
      const notes = [
        ...result.missing.map((key) => `missing ${key}`),
        ...result.type.map((key) => `wrong ${key}`),
        ...result.extra.map((key) => `new ${key}`),
      ];
      console.log(`${state} ${name}${notes.length ? `  ${notes.join('; ')}` : ''}`);
    }
    printSummary(summary);
  } else {
    printSummary(summary);
  }

  if (summary.failed) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`[CONFORM] ${err.message}`);
  process.exitCode = 1;
}
