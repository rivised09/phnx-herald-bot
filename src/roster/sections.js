/**
 * Where a callofstats label belongs.
 *
 * The full scrape and the enrichment pass used to invent section names
 * ("ToC Stats", "RoW Stats", "Callof Stats"), so the same label could land
 * beside the history instead of in it. These rules use the section names the
 * published days already have, so an enrichment merges into the existing block
 * rather than creating a second one.
 *
 * Order matters: the specific labels (ratios, tiered kills, RoW leagues) are
 * matched before the broad "merit" and "power" fallbacks.
 */
const RULES = [
  // Profile fields are rendered above the stat sections, with no header.
  [
    /^(id|alliance|server|current power|highest power|town hall|currently king|days as king|division|faction|leadership time|migration score)$/i,
    '',
  ],

  // Events.
  [/^toc\b|^tournament/i, 'Tournament of Champion Stats'],
  [/league/i, 'Root of War League Stats'],
  [/row\b|roots? of war/i, 'Roots of War Stats'],

  // Historical and seasonal counters.
  [/^historical\b|^season/i, 'Historical Season Stats'],
  [/^t[1-5] kills?$/i, 'Historic Tiered Kills'],

  // Resource counters that the old days kept together.
  [/resource assistance/i, 'Extra Resource Stats'],
  [/^total resources gathered$/i, 'Extra Resource Stats'],
  [/^times alliance helps given$/i, 'Extra Resource Stats'],
  [/^gather|gathered$/i, 'Gathered Resources'],
  [/^spent\b| spent$/i, 'Historic Resources Spent'],

  // War ratios and counters.
  [/^(city sieges|defeats|times scouted|victories|victory to defeat ratio)$/i, 'Extra War Stats'],
  [/^(kill to heal|merit to power) ratio$/i, 'War Stats'],
  [/^alliance donations?$|^alliance helps$|^behemoth\b|^build time$|^destruction time$/i, 'Alliance Activity'],
  [/^t[45](?:\/t[45])? units/i, 'Advanced War Stats'],
  [/^(cavalry|infantry|mage|marksman|other) merits$/i, 'Advanced War Stats'],
  [/^merits$/i, 'War Stats'],
  [/kill|defeat|victor|siege|scout|unit|dead|heal/i, 'War Stats'],

  // Everything else that is a stat.
  [/power|troop|building|hero|tech|policy/i, 'Power Spread'],
  [/merit/i, 'Advanced War Stats'],
];

function sectionFor(label) {
  const text = String(label || '').trim();
  for (const [pattern, section] of RULES) {
    if (pattern.test(text)) return section;
  }
  return 'Callof Stats';
}

module.exports = { sectionFor, RULES };
