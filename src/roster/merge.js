/**
 * Additive merge: the rule is "never remove, just add".
 *
 * When a second source arrives, the same files get written twice - a new
 * source publishes the snapshot, callofstats fills in the fields it alone has -
 * and neither is allowed to erase what the other recorded. That is not the
 * default behaviour of an overwrite, so every write goes through here instead.
 *
 * The rules, in order:
 *
 *  1. A missing or null value never replaces a value we already have. "We did
 *     not read this today" is not the same as "this is no longer true".
 *  2. Objects merge key by key, recursively.
 *  3. Arrays merge by identity - `id` for rows, `url` for album images, `name`
 *     for achievements, `section` for stat blocks - so an existing item is
 *     updated in place and a new one is appended. Plain lists of strings
 *     (dates, names, server numbers) are unioned.
 *  4. Everything else is last-writer-wins, which is what a re-read of the same
 *     date should be.
 *
 * A snapshot is a complete roster for one date, so its membership is unioned
 * too: a player the newest read happens not to list stays, because the file is
 * never supposed to lose a fact. The entries are re-sorted by rank afterwards
 * so the extra rows land where the page expects them.
 */

/** Arrays whose items have an identity, and the field that carries it. */
const KEYED = {
  alliances: 'id',
  players: 'id',
  albums: 'url',
  achievements: 'name',
  sections: 'section',
  rows: 'label',
};

/** Plain lists that are sets of values rather than ordered sequences. */
const NUMERIC_LISTS = new Set(['otherServers', 'previousServers']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function identity(item, field) {
  if (!isPlainObject(item) || !field) return null;
  const value = item[field];
  return value === null || value === undefined ? null : String(value);
}

function mergeList(existing, incoming, key) {
  const field = KEYED[key];

  if (field) {
    const out = existing.slice();
    const positions = new Map();
    out.forEach((item, index) => {
      const id = identity(item, field);
      if (id !== null) positions.set(id, index);
    });
    for (const item of incoming) {
      const id = identity(item, field);
      if (id !== null && positions.has(id)) {
        const at = positions.get(id);
        out[at] = merge(out[at], item, key);
      } else {
        if (id !== null) positions.set(id, out.length);
        out.push(item);
      }
    }
    return out;
  }

  if (key === 'dates') {
    return [...new Set([...existing, ...incoming])].sort().reverse();
  }

  if (NUMERIC_LISTS.has(key)) {
    const values = [...new Set([...existing, ...incoming])];
    return values.sort((a, b) => Number(a) - Number(b));
  }

  // Primitives and unknown shapes: keep order, drop the repeats.
  const seen = new Set(existing.map((item) => JSON.stringify(item)));
  const out = existing.slice();
  for (const item of incoming) {
    const token = JSON.stringify(item);
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(item);
  }
  return out;
}

function merge(existing, incoming, key) {
  if (incoming === undefined || incoming === null) return existing;
  if (existing === undefined || existing === null) return incoming;

  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return mergeList(existing, incoming, key);
  }

  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const out = { ...existing };
    for (const [childKey, childValue] of Object.entries(incoming)) {
      out[childKey] = merge(existing[childKey], childValue, childKey);
    }
    return out;
  }

  return incoming;
}

/** Rank order is what both pages render, so keep it after a union. */
function sortSnapshot(snapshot) {
  if (Array.isArray(snapshot.players)) {
    snapshot.players.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
  }
  if (Array.isArray(snapshot.alliances)) {
    snapshot.alliances.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  }
  return snapshot;
}

/**
 * Merges one published file.
 *
 * `kind` is one of `index`, `snapshot`, `player`, `alliance` - the same names
 * `contract.js` uses. Passing `null`/`undefined` on either side is a no-op in
 * the direction you would expect: no existing file means the incoming one is
 * written as-is, and no incoming data means the file is left alone.
 */
function mergeFile(kind, existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged = merge(existing, incoming, kind);
  if (kind === 'snapshot') return sortSnapshot(merged);
  if (kind === 'index') {
    const dates = [...new Set([...(merged.dates || [])])].sort().reverse();
    return { ...merged, dates, latest: dates[0] || merged.latest };
  }
  return merged;
}

module.exports = { merge, mergeFile, KEYED, NUMERIC_LISTS };
