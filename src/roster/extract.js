const { BASE } = require('./session');
const { USER_AGENT } = require('./http');

/**
 * Reading the stat blocks the roster crawl does not touch.
 *
 * The roster only needs the alliance cards and member rows on /server/{id}.
 * Everything else the source exposes - server totals, alliance war stats, a
 * player's achievements and name history - lives in the same markup family on
 * three page types, so one set of readers covers all of them:
 *
 *   section heading   <h3 class="higher-label">Server War Stats</h3>
 *   stat cell         <div class="stat-item"><span class="subtle">Total Power</span>
 *                     <div class="value">4,062,807,339</div></div>
 *   achievement       .achievement-name + .achievement-values > (progress, completion)
 *   name history      .history-dropdown > .history-grid > .history-item
 *   avatar            .profile-picture-wrapper > img[alt="PFP"]
 *
 * The heading-to-cell pairing is done by document order rather than by DOM
 * nesting: the same `.stat-item` markup is wrapped in `server-glass` on one
 * page and `card-scale > stats-section` on another, and Power Spread splits a
 * single section across two sibling grids. Walking in order means every cell
 * belongs to the heading above it whatever the wrapper happens to be.
 *
 * The functions below run inside the browser (they are passed to
 * page.evaluate), so they must stay self-contained.
 */

/**
 * `[{ section, label, value }]` for every stat cell on the page.
 *
 * Two shapes have to work, because they are the same page seen at different
 * times: raw HTML straight from the server, and the DOM after the page's own
 * scripts have run. The scripts add the `stat-item` wrapper but the pairing
 * they leave behind is `<span class="subtle">Label</span><div class="value">V`
 * in both - and in the raw form several pairs sit inside one wrapper div
 * ("Building Power"/"Legion Power"/"Tech Power" share one), so a cell cannot
 * be identified by its parent.
 *
 * Labels are therefore matched on `.subtle` / `.exact-time-label` and each one
 * takes the next value sibling, stopping at another label or at the end of its
 * wrapper. Cells above the first heading have no section of their own - the
 * player's identity card on /lord/{id} and the scan timestamp both sit there -
 * and they keep an empty section rather than an invented name.
 */
function readStatSections() {
  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const nodes = document.querySelectorAll('h3.higher-label, .subtle, .exact-time-label');
  const rows = [];
  let section = '';

  nodes.forEach((node) => {
    if (node.matches('h3.higher-label')) {
      section = text(node);
      return;
    }

    let valueEl = null;
    let sibling = node.nextElementSibling;
    while (sibling) {
      if (sibling.matches('.value, .exact-time-value')) {
        valueEl = sibling;
        break;
      }
      // Another label means this one had no value of its own - for example
      // the "Minimum Power:" filter label, which precedes a <select>.
      if (sibling.matches('.subtle, .exact-time-label')) break;
      sibling = sibling.nextElementSibling;
    }
    if (!valueEl) return;

    const label = text(node);
    if (!label) return;
    rows.push({ section, label, value: text(valueEl) });
  });

  return rows;
}

/**
 * `[{ name, progressText, completedText }]`.
 *
 * `.achievement-name` is matched rather than `.achievement-row` because the
 * two achievements pinned above the grid ("Max Decorations") use their own
 * element but share the name/value shape.
 */
function readAchievements() {
  const box = document.querySelector('.achievements-container');
  if (!box) return [];
  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  return [...box.querySelectorAll('.achievement-name')]
    .map((nameEl) => {
      const row = nameEl.parentElement;
      const values = row ? row.querySelector('.achievement-values') : null;
      const cells = values ? [...values.children] : [];
      return {
        name: text(nameEl),
        progressText: text(cells[0]),
        completedText: text(cells[1]),
      };
    })
    .filter((row) => row.name);
}

/** Previous names of a player, oldest first as the source lists them. */
function readNameHistory() {
  const heading = [...document.querySelectorAll('h3.higher-label')].find((h) =>
    /lord name history/i.test(h.textContent || ''),
  );
  if (!heading) return [];
  const box = heading.closest('.history-dropdown') || heading.parentElement;
  if (!box) return [];
  return [...box.querySelectorAll('.history-item')]
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * The player's picture, absolute.
 *
 * Two elements carry `profile-picture`: the site's own logo in the header and
 * the player's actual image. The player's is the one inside the wrapper, and
 * `alt="PFP"` is checked first because it is the more specific signal.
 */
function readAvatar() {
  const img =
    document.querySelector('.profile-picture-wrapper img[alt="PFP"]') ||
    document.querySelector('.profile-picture-wrapper img');
  if (!img) return null;
  const raw = img.getAttribute('src') || img.getAttribute('data-src');
  if (!raw || /codweb_all_three_avatar|\/static\/images\//.test(raw)) return null;
  try {
    return new URL(raw, location.href).toString();
  } catch {
    return raw;
  }
}

/**
 * Member ids shown on the current page, used to confirm that an alliance page
 * found by name really belongs to the server we are syncing.
 */
function readMemberIds() {
  const ids = new Set();
  document.querySelectorAll('.lord-id').forEach((el) => {
    const match = (el.textContent || '').match(/\d+/);
    if (match) ids.add(match[0]);
  });
  return [...ids];
}

/** The roster's label for a player with no alliance; not a real one to fetch. */
const NOT_AN_ALLIANCE = /^not in an alliance$/i;

/**
 * Queries the search endpoint will actually match on.
 *
 * The endpoint refuses a query containing a bracket: `[PHW2] Phoenix of the
 * War` returns nothing while `PHW2` returns exactly that alliance, so the
 * stored name has to be reduced before it can be searched. Each variant is
 * still verified by exact label, so a variant that matches something else
 * cannot attach the wrong id.
 */
function queryVariants(name) {
  const out = [];

  // The tag goes first when there is one: it is the form the endpoint
  // accepts, and putting it first saves a wasted round trip on every
  // bracketed name - which is nearly all of them. Exact-label verification
  // later in the lookup makes the order a performance choice, never a
  // correctness one.
  const tag = name.match(/^\[([^\]]+)\]/);
  if (tag) out.push(tag[1]);

  out.push(name);

  const unbracketed = name.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  if (unbracketed && unbracketed !== name) out.push(unbracketed);

  const rest = name.replace(/^\[[^\]]+\]\s*/, '').trim();
  if (rest && rest !== name) out.push(rest);

  return [...new Set(out)];
}

async function searchAlliances(query) {
  const url = new URL('/search', BASE);
  url.searchParams.set('mode', 'alliance');
  url.searchParams.set('query', query);

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) return [];

  const hits = await res.json();
  return Array.isArray(hits) ? hits : [];
}

/**
 * Alliance name -> candidate numeric ids, using the source's public search
 * endpoint.
 *
 * The roster grid renders alliance names but no ids, and neither the
 * `/alliance/{id}` page nor `/server_alliance_rankings` carries a link back,
 * so the id has to come from somewhere else. `/search?mode=alliance` needs no
 * session, which keeps this off the browser entirely.
 *
 * Every label match is kept, not just the first: alliance names are unique
 * within a server but not across servers, so a name that appears twice needs
 * the member list to tell which one belongs to us. Callers narrow the list by
 * checking that the page's members are ours.
 */
async function resolveAllianceIds(names) {
  const found = new Map();
  const wanted = [...new Set((names || []).filter(Boolean))].filter(
    (name) => !NOT_AN_ALLIANCE.test(name),
  );

  for (const name of wanted) {
    try {
      const candidates = [];

      for (const query of queryVariants(name)) {
        const hits = await searchAlliances(query);
        for (const hit of hits) {
          if (!hit || hit.label !== name) continue;
          const value = String(hit.value);
          if (!/^\d+$/.test(value) || candidates.includes(value)) continue;
          candidates.push(value);
        }
        // The label matched, so a further variant cannot add anything useful.
        if (candidates.length) break;
      }

      if (candidates.length) found.set(name, candidates);
    } catch {
      // A missing id only means that alliance's detail page is skipped for
      // now; the roster itself was already read from the server page.
    }
  }

  return found;
}

module.exports = {
  readStatSections,
  readAchievements,
  readNameHistory,
  readAvatar,
  readMemberIds,
  queryVariants,
  resolveAllianceIds,
};
