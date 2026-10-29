/**
 * Carry callofstats-only fields into a day from another source.
 *
 * DragonStats has no achievements, radar, ToC/RoW blocks, king/division
 * profile fields, or tiered kills. When a DragonStats day is built, the newest
 * earlier value for every missing label is copied into that day. The copy is
 * additive: a value DragonStats did publish always wins, and nothing is ever
 * invented.
 *
 * The fallback is per label, so a label that only exists on a much older day
 * (for example the last callofstats scrape) still survives a gap of several
 * DragonStats-only days.
 */
const { sectionFor } = require('./sections');

const NON_ZERO_LABELS = new Set([
  'T1 Kills',
  'T2 Kills',
  'T3 Kills',
  'T4 Kills',
  'T5 Kills',
  'T4/T5 Units Dead',
  'T4/T5 Units Rss Healed',
  'Historical Highest Merits',
  'Historical Most Resource Healing',
]);

function numeric(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/,/g, '').replace(/%/g, '').replace(/ Sec$/, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function carryForward(existing, incoming, date) {
  if (!existing || !incoming || !incoming.byDate || !incoming.byDate[date]) return incoming;

  const entry = incoming.byDate[date];
  const earlier = (existing.dates || [])
    .filter((day) => day < date && existing.byDate && existing.byDate[day])
    .sort()
    .reverse();
  if (!earlier.length) return incoming;

  const rowsByLabel = new Map();
  for (const block of entry.sections || []) {
    for (const row of block.rows || []) rowsByLabel.set(row.label, row);
  }

  const sections = (entry.sections || []).map((block) => ({
    ...block,
    rows: [...(block.rows || [])],
  }));
  const bySection = new Map(sections.map((block) => [block.section, block]));

  const fillSection = (section, label, value) => {
    if (value === null || value === undefined || value === '') return;
    const current = rowsByLabel.get(label);
    if (current) {
      if (
        NON_ZERO_LABELS.has(label) &&
        numeric(current.value) === 0 &&
        numeric(value) !== 0
      ) {
        current.value = value;
      }
      return;
    }
    let target = bySection.get(section);
    if (!target) {
      target = { section, rows: [] };
      bySection.set(section, target);
      sections.push(target);
    }
    const added = { label, value };
    target.rows.push(added);
    rowsByLabel.set(label, added);
  };

  for (const earlierDate of earlier) {
    const source = existing.byDate[earlierDate];
    for (const block of source.sections || []) {
      for (const row of block.rows || []) {
        // Older enrichment wrote the label's section rather than the block's;
        // use the label's canonical home so the carried row joins the history.
        const target = block.section === 'Dragon Stats' ? 'Dragon Stats' : sectionFor(row.label);
        fillSection(target, row.label, row.value);
      }
    }
    if (!entry.achievements?.length && source.achievements?.length) {
      entry.achievements = source.achievements.map((item) => ({ ...item }));
    }
    if (!entry.avatar && source.avatar) entry.avatar = source.avatar;
  }
  entry.sections = sections;

  if (!incoming.metrics) incoming.metrics = {};
  const metrics = { ...(incoming.metrics[date] || {}) };
  for (const earlierDate of earlier) {
    for (const [label, value] of Object.entries(existing.metrics?.[earlierDate] || {})) {
      if (metrics[label] === undefined || metrics[label] === null || metrics[label] === '') {
        metrics[label] = value;
      }
    }
  }
  incoming.metrics[date] = metrics;

  if (!incoming.radar) incoming.radar = {};
  if (!incoming.radar[date]) {
    for (const earlierDate of earlier) {
      if (existing.radar?.[earlierDate]) {
        incoming.radar[date] = existing.radar[earlierDate];
        break;
      }
    }
  }

  return incoming;
}

module.exports = { carryForward };
