/**
 * The published archive's shape, written down once.
 *
 * The JSON in R2 is the contract between the scraper and the website: the
 * pages were built against these keys, so a new scraping source is only usable
 * if it can fill them. Rather than discovering that in production, the shape
 * lives here as data and `scripts/conform.js` checks any payload against it -
 * so a sample from a source nobody has explored yet answers three questions
 * immediately: what does it already provide, what is still missing, and what
 * does it offer that we do not have a home for yet.
 *
 * Two rules run through everything:
 *
 *  1. **Nothing is removed.** Every field below is either required (a source
 *     that cannot produce it has a gap) or optional (an addition). A field that
 *     disappears from a payload is a conformance failure, not a schema change -
 *     `merge.js` is what makes sure a partial source cannot blank out what an
 *     earlier one already recorded.
 *  2. **New data is additive.** Unknown keys are listed as `new` and kept; they
 *     are never an error, because the rule is "never remove, just add".
 *
 * `source` says who is expected to supply a field once a second source exists:
 *
 *   primary   the new scraping source (the one that becomes the main feed)
 *   fallback  callofstats, asked only for what the primary cannot provide
 *   derived   computed by us from the rest (ids, counts, dates)
 *
 * Until the new source is known, `primary` is simply "whoever writes the
 * snapshot"; the annotations are what the enrichment pass will read later.
 */

const S = (extra) => ({ type: 'string', ...extra });
const N = (extra) => ({ type: 'number', ...extra });
/** A metric is a number when it parsed and the rendered string when it did not. */
const NS = (extra) => ({ type: ['number', 'string'], ...extra });
const O = (fields, extra) => ({ type: 'object', fields: fields || {}, ...extra });
const A = (items, extra) => ({ type: 'array', items: items || { type: 'any' }, ...extra });

/** One player on one date, inside their own file. */
const PLAYER_ENTRY = O({
  name: S({ source: 'primary' }),
  rank: N({ nullable: true, source: 'primary' }),
  power: N({ nullable: true, source: 'primary' }),
  avatar: S({ nullable: true, source: 'fallback' }),
  alliance: S({ nullable: true, source: 'primary' }),
  achievements: A(
    O({
      name: S(),
      progress: S({ nullable: true }),
      target: S({ nullable: true }),
      completedAt: S({ nullable: true }),
    }),
    { source: 'fallback' },
  ),
  sections: A(
    O({
      section: S(),
      rows: A(O({ label: S(), value: S({ nullable: true }) })),
    }),
    { source: 'fallback' },
  ),
  albums: A(
    O({
      url: S(),
      likes: N({ nullable: true }),
      postedAt: S({ nullable: true }),
      caption: S({ nullable: true }),
    }),
    { source: 'fallback', note: 'Image gallery with per-image likes for this date.' },
  ),
});

/** One player's whole history: the file the profile page reads. */
const PLAYER = O({
  id: S({ required: true, source: 'primary' }),
  name: S({ required: true, nullable: true, source: 'primary' }),
  dates: A(S(), { required: true, source: 'derived' }),
  byDate: O({}, { required: true, source: 'primary', dynamic: PLAYER_ENTRY }),
  metrics: O({}, { required: true, source: 'fallback', dynamic: O({}, { dynamic: NS({ nullable: true }) }) }),
  radar: O({}, { required: true, source: 'fallback', dynamic: O({}, { dynamic: NS({ nullable: true }) }) }),
  nameHistory: A(S(), { source: 'fallback' }),
  otherServers: A(N(), { source: 'derived' }),
  previousServers: A(S(), {
    source: 'fallback',
    note: 'Server history as the fallback source prints it; supersedes otherServers for display.',
  }),
  albums: A(
    O({
      url: S(),
      likes: N({ nullable: true }),
      postedAt: S({ nullable: true }),
      caption: S({ nullable: true }),
    }),
    { source: 'fallback', note: 'Image gallery with per-image likes.' },
  ),
});

/** One alliance on one date, inside its own file. */
const ALLIANCE_ENTRY = O({
  name: S(),
  rank: N({ nullable: true }),
  power: N({ nullable: true }),
  memberCount: N({ nullable: true }),
  players: A(O({ id: S(), name: S(), rank: N({ nullable: true }), power: N({ nullable: true }) })),
  sections: A(
    O({
      section: S(),
      rows: A(O({ label: S(), value: S({ nullable: true }) })),
    }),
    { source: 'fallback' },
  ),
});

const ALLIANCE = O({
  id: S({ required: true, source: 'primary' }),
  name: S({ required: true, nullable: true, source: 'primary' }),
  dates: A(S(), { required: true, source: 'derived' }),
  byDate: O({}, { required: true, source: 'primary', dynamic: ALLIANCE_ENTRY }),
});

/** One date's roster: the file the home page reads. */
const SNAPSHOT = O({
  status: S({ required: true, source: 'derived' }),
  server: O({ id: S(), url: S() }, { required: true, source: 'derived' }),
  alliances: A(
    O({
      id: S(),
      name: S(),
      rank: N({ nullable: true }),
      stats: O({}, { dynamic: S({ nullable: true }) }),
    }),
    { required: true, source: 'primary' },
  ),
  players: A(
    O({
      id: S(),
      name: S(),
      index: N({ nullable: true }),
      allianceId: S({ nullable: true }),
      avatar: S({ nullable: true }),
      stats: O({}, { dynamic: S({ nullable: true }) }),
      merits: O({
        infantry: N({ nullable: true }),
        cavalry: N({ nullable: true }),
        mage: N({ nullable: true }),
        marksman: N({ nullable: true }),
      }, { nullable: true, source: 'fallback' }),
    }),
    { required: true, source: 'primary' },
  ),
  crawledAt: S({ required: true, source: 'derived' }),
  snapshot: O({
    date: S({ required: true, source: 'derived' }),
    ingestedAt: S({ required: true, source: 'derived' }),
  }, { required: true, source: 'derived' }),
});

/** The date list and counts the home page and the pickers are built from. */
const INDEX = O({
  version: N({ required: true, source: 'derived' }),
  server: O({ id: S(), url: S() }, { required: true, source: 'derived' }),
  latest: S({ required: true, source: 'derived' }),
  dates: A(S(), { required: true, source: 'derived' }),
  generatedAt: S({ required: true, source: 'derived' }),
  counts: O(
    { snapshots: N(), players: N(), alliances: N() },
    { required: true, source: 'derived' },
  ),
});

const KINDS = { index: INDEX, snapshot: SNAPSHOT, player: PLAYER, alliance: ALLIANCE };

/** What a file is, judged by its keys alone - for checking a pasted sample. */
function inferKind(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if ('latest' in value && 'dates' in value) return 'index';
  if ('players' in value && 'alliances' in value) return 'snapshot';
  if ('byDate' in value && 'metrics' in value) return 'player';
  if ('byDate' in value) return 'alliance';
  return null;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function sameType(value, expected) {
  if (expected === 'any') return true;
  const allowed = Array.isArray(expected) ? expected : [expected];
  const actual = typeOf(value);
  return allowed.includes(actual);
}

function join(path, key) {
  return path ? `${path}.${key}` : key;
}

/**
 * Walks a payload against a spec and collects what does not fit.
 *
 * `extra` is deliberately not an error: an unknown key is new data, which is
 * the thing we want more of. Everything else - a required key that is absent,
 * a value of the wrong type - is a gap a source has to close before it can
 * replace the current one.
 */
function checkValue(value, spec, path, out) {
  if (value === undefined || value === null) {
    if (spec.required) out.missing.push(path || '<root>');
    if (value === null && spec.required && !spec.nullable) out.type.push(`${path}: null is not allowed`);
    return;
  }
  if (!sameType(value, spec.type)) {
    out.type.push(`${path || '<root>'}: expected ${spec.type}, got ${typeOf(value)}`);
    return;
  }

  if (spec.type === 'object') {
    const fixed = spec.fields || {};
    for (const [key, sub] of Object.entries(fixed)) {
      checkValue(value[key], sub, join(path, key), out);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in fixed) continue;
      // A date-keyed map is reported once per field, not once per date.
      const keyPath = /^\d{4}-\d{2}-\d{2}$/.test(key) ? '*' : key;
      if (spec.dynamic) checkValue(child, spec.dynamic, join(path, keyPath), out);
      else out.extra.add(join(path, keyPath));
    }
    return;
  }

  if (spec.type === 'array') {
    const seen = new Set();
    for (const item of value) {
      // One report per shape, not per row: 300 players sharing a new key is
      // one finding, not three hundred.
      const before = out.extra.size;
      checkValue(item, spec.items, `${path}[]`, out);
      if (out.extra.size > before) {
        for (const key of [...out.extra].slice(before)) seen.add(key);
      }
    }
  }
}

/** `{ ok, missing, type, extra }` for one payload of the given kind. */
function check(kind, value) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unknown file kind: ${kind} (expected ${Object.keys(KINDS).join(', ')})`);
  const out = { kind, missing: [], type: [], extra: new Set() };
  checkValue(value, spec, '', out);
  return {
    kind,
    ok: out.missing.length === 0 && out.type.length === 0,
    missing: out.missing,
    type: out.type,
    extra: [...out.extra],
  };
}

/**
 * The fields a source is expected to supply, as dotted paths.
 *
 * Used to answer "what is still missing from the primary source?" without
 * checking a payload first - the enrichment pass starts from this list.
 */
function pathsFor(kind, source, spec = KINDS[kind], path = '') {
  const out = [];
  if (!spec) return out;
  if (spec.source === source && spec.required) out.push(path || '<root>');
  if (spec.type === 'object') {
    for (const [key, sub] of Object.entries(spec.fields || {})) {
      out.push(...pathsFor(kind, source, sub, join(path, key)));
    }
  }
  return out;
}

/**
 * Every field of a kind, flat, with who supplies it.
 *
 * `pathsFor` answers "what must a source provide"; this answers "what does the
 * whole target look like", optional fields included - which is what somebody
 * exploring a new site needs in front of them.
 */
function describe(kind, spec = KINDS[kind], path = '', out = []) {
  const label = path || '<root>';
  out.push({
    kind,
    path: label,
    source: spec.source || null,
    required: Boolean(spec.required),
    type: Array.isArray(spec.type) ? spec.type.join('|') : spec.type,
  });
  if (spec.type === 'object') {
    for (const [key, sub] of Object.entries(spec.fields || {})) {
      describe(kind, sub, join(path, key), out);
    }
    if (spec.dynamic) describe(kind, spec.dynamic, join(path, '*'), out);
  }
  if (spec.type === 'array' && spec.items && spec.items.type === 'object') {
    describe(kind, spec.items, `${path}[]`, out);
  }
  return out;
}

const REQUIRED = {
  primary: ['snapshot', 'player', 'alliance'].flatMap((kind) => pathsFor(kind, 'primary')),
  fallback: ['player', 'alliance'].flatMap((kind) => pathsFor(kind, 'fallback')),
};

module.exports = { KINDS, check, inferKind, pathsFor, describe, REQUIRED };
