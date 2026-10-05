/**
 * Interpretation layer for a single player's public profile.
 *
 * Turns raw stored history (power/rank per snapshot) and stored detail metrics
 * (war stats, healing, resources, seasons) into the narrative structures the
 * player page renders: playstyle, profile signals, progress, timeline series,
 * efficiency ratios, biggest gains, milestones, season journey, site badges and
 * plain-language narrative.
 *
 * PRIVACY INVARIANT - this is the rule the whole module is built around:
 * every function here accepts only ONE player's own series. There is no
 * ranking, no percentile, no kingdom average, no "better than X% of players".
 * Every level, tier and threshold is an absolute number, and every comparison
 * is a player measured against their own earlier self. If a future feature
 * needs another player to compute something, it does not belong in a public
 * payload - route it behind leadership scope instead.
 *
 * DEGRADATION: only the newest ~230 players have ever had their detail page
 * read, so most players carry power/rank history and nothing else. Anything
 * that needs combat/healing/resource metrics is omitted with `available:false`
 * rather than reported as zero, because "0 kills" and "not measured yet" are
 * very different claims.
 */

const MAX_DATES = 60;

const M = {
  kills: 'Units Killed',
  deaths: 'Units Dead',
  healed: 'Units Healed',
  t45dead: 'T4/T5 Units Dead',
  t45healed: 'T4/T5 Units Rss Healed',
  merits: 'Merits',
  victories: 'Victories',
  defeats: 'Defeats',
  sieges: 'City Sieges',
  scouted: 'Times Scouted',
  donations: 'Alliance Donations',
  helps: 'Times Alliance Helps Given',
  gathered: 'Total Resources Gathered',
  buildingPower: 'Building Power',
  heroPower: 'Hero Power',
  legionPower: 'Legion Power',
  techPower: 'Tech Power',
  townHall: 'Town Hall',
  seasonsPlayed: 'Seasons Played',
  seasonVictories: 'Season Victories',
  seasonDefeats: 'Season Defeats',
  seasonWinrate: 'Season Winrate',
  bestMerits: 'Historical Highest Merits',
};

const POWER_BANDS = [10e6, 50e6, 100e6, 500e6, 1e9];
const KILL_BANDS = [1e6, 5e6, 2e7, 5e7, 1e8];
const HEAL_BANDS = [5e5, 2e6, 1e7, 3e7, 1e8];
const MERIT_BANDS = [1e3, 1e4, 5e4, 1e5, 5e5];
const VICTORY_BANDS = [100, 500, 1000, 5000, 10000];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Absolute, monotonic 0..1 step function over fixed milestones. */
function intensity(value, bands) {
  const n = num(value);
  if (n === null) return null;
  if (n <= 0) return 0;
  const step = 1 / bands.length;
  for (let i = 0; i < bands.length; i += 1) {
    if (n < bands[i]) return step * i + step * (n / bands[i]);
  }
  return 1;
}

function ratio(numerator, denominator) {
  const a = num(numerator);
  const b = num(denominator);
  if (a === null || b === null || b <= 0) return null;
  return a / b;
}

function percent(from, to) {
  const a = num(from);
  const b = num(to);
  if (a === null || b === null || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

function mean(values) {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (!present.length) return null;
  return present.reduce((sum, v) => sum + v, 0) / present.length;
}

function compact(value) {
  const n = num(value);
  if (n === null) return null;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return Math.round(n).toString();
}

function signed(value) {
  const n = num(value);
  if (n === null) return null;
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${compact(Math.abs(n))}`;
}

function signedPct(value) {
  const n = num(value);
  if (n === null) return null;
  const rounded = Math.abs(n) >= 10 ? Math.round(n) : Number(n.toFixed(1));
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(rounded)}%`;
}

/** 10 / 20 / 50 x10^n style targets, so goals are always round numbers. */
function nextRound(value) {
  const n = num(value);
  if (n === null || n <= 0) return 1000;
  const magnitude = 10 ** Math.floor(Math.log10(n));
  for (const multiple of [1, 2, 5, 10]) {
    const target = multiple * magnitude;
    if (target > n) return target;
  }
  return magnitude * 10;
}

/** Accepts `readSubjectMetrics` output (section -> rows) or an already-flat label map. */
function flatten(sectioned) {
  const flat = {};
  for (const [key, value] of Object.entries(sectioned || {})) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!entry || !entry.label) continue;
        const parsed = num(entry.number) !== null ? num(entry.number) : num(entry.text);
        if (parsed !== null) flat[entry.label] = parsed;
      }
      continue;
    }
    const parsed = num(value);
    if (parsed !== null) flat[key] = parsed;
  }
  return flat;
}

function seriesFrom(history, metricsByDate) {
  const byDate = new Map();
  for (const item of history || []) {
    if (!item || !item.date) continue;
    byDate.set(item.date, {
      date: item.date,
      power: num(item.power),
      rank: num(item.rank),
      metrics: {},
    });
  }
  for (const [date, flat] of Object.entries(metricsByDate || {})) {
    if (!byDate.has(date)) {
      byDate.set(date, { date, power: null, rank: null, metrics: {} });
    }
    byDate.get(date).metrics = flat;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_DATES);
}

function at(point, key) {
  if (key === 'power') return point ? point.power : null;
  if (key === 'rank') return point ? point.rank : null;
  if (!point) return null;
  return num(point.metrics[key]);
}

const TRACKED = [
  { key: 'power', label: 'Power', kind: 'power' },
  { key: 'rank', label: 'Rank', kind: 'rank' },
  { key: 'kills', label: 'Units Killed', kind: 'metric' },
  { key: 'deaths', label: 'Units Lost', kind: 'metric' },
  { key: 'healed', label: 'Units Healed', kind: 'metric' },
  // Merits are earned within a season and restart when a new one opens, so a
  // drop here is a reset rather than a loss. Everything else in TRACKED is
  // cumulative and only ever climbs.
  { key: 'merits', label: 'Merits', kind: 'metric', seasonScoped: true },
  { key: 'victories', label: 'Victories', kind: 'metric' },
  { key: 'defeats', label: 'Defeats', kind: 'metric' },
  { key: 'gathered', label: 'Resources Gathered', kind: 'metric' },
  { key: 'donations', label: 'Alliance Donations', kind: 'metric' },
];

/**
 * `at()` is label-addressed because detail metrics are stored under the source's
 * own wording ("Units Killed"). TRACKED rows carry a stable key for the API
 * payload instead, so reading a tracked series goes through here rather than
 * through `at()` directly.
 */
function trackValue(point, spec) {
  if (!point) return null;
  if (spec.kind === 'power') return point.power;
  if (spec.kind === 'rank') return point.rank;
  return num(point.metrics[spec.label]);
}

function buildProgress(series) {
  const last = series[series.length - 1];
  const rows = [];

  // Each metric is measured only on the dates the detail pass actually read,
  // so first/last are found per metric rather than assuming the oldest
  // snapshot carries every label.
  for (const spec of TRACKED) {
    let from = null;
    let fromDate = null;
    for (const point of series) {
      const value = trackValue(point, spec);
      if (value !== null) {
        from = value;
        fromDate = point.date;
        break;
      }
    }
    let to = null;
    let toDate = null;
    for (let i = series.length - 1; i >= 0; i -= 1) {
      const value = trackValue(series[i], spec);
      if (value !== null) {
        to = value;
        toDate = series[i].date;
        break;
      }
    }
    // A single reading is a level, not a change - progress needs two dates.
    if (from === null || to === null || fromDate === toDate) continue;

    const delta = to - from;
    const deltaPct = percent(from, to);
    const reset = Boolean(spec.seasonScoped) && delta < 0;
    rows.push({
      key: spec.key,
      label: spec.label,
      scope: spec.seasonScoped ? 'season' : 'cumulative',
      from,
      to,
      fromDate,
      toDate,
      delta,
      deltaText: reset ? null : signed(delta),
      deltaPct: reset ? null : deltaPct,
      deltaPctText: reset ? 'new season' : signedPct(deltaPct),
      direction: reset ? 'reset' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      better: reset ? null : spec.kind === 'rank' ? delta < 0 : delta > 0,
      note: reset
        ? `A new season opened between ${fromDate} and ${toDate}, so this counter restarted.`
        : null,
    });
  }

  const days = Math.max(
    0,
    Math.round((Date.parse(last.date) - Date.parse(series[0].date)) / 86400000),
  );
  return { windowDays: days, from: series[0].date, to: last.date, points: series.length, series: rows };
}

function buildTimeline(series) {
  return series.map((point) => ({
    date: point.date,
    power: point.power,
    rank: point.rank,
    kills: at(point, M.kills),
    deaths: at(point, M.deaths),
    healed: at(point, M.healed),
    merits: at(point, M.merits),
    victories: at(point, M.victories),
    defeats: at(point, M.defeats),
    gathered: at(point, M.gathered),
    donations: at(point, M.donations),
  }));
}

function buildEfficiency(last) {
  const rows = [];
  const kills = at(last, M.kills);
  const deaths = at(last, M.deaths);
  const healed = at(last, M.healed);
  const victories = at(last, M.victories);
  const defeats = at(last, M.defeats);
  const merits = at(last, M.merits);
  const t45dead = at(last, M.t45dead);
  const power = last ? last.power : null;

  const killDeath = ratio(kills, deaths);
  if (killDeath !== null) {
    rows.push({
      key: 'killDeath',
      label: 'Kill to loss ratio',
      value: Number(killDeath.toFixed(2)),
      text: `${killDeath.toFixed(1)} kills per unit lost`,
      narrative: `For every unit this account loses, it takes ${killDeath.toFixed(1)} enemy units with it.`,
    });
  }

  const healDeath = ratio(healed, deaths);
  if (healDeath !== null) {
    rows.push({
      key: 'healDeath',
      label: 'Recovery ratio',
      value: Number(healDeath.toFixed(2)),
      text: `${healDeath.toFixed(1)} units healed per unit lost`,
      narrative: `Losses are topped up ${healDeath.toFixed(1)} times over by healing - most attrition is reversible.`,
    });
  }

  const winRate = ratio(victories, num(victories) + num(defeats));
  if (winRate !== null) {
    rows.push({
      key: 'winRate',
      label: 'Battle win rate',
      value: Number(winRate.toFixed(6)),
      text: `${(winRate * 100).toFixed(0)}% of battles won`,
      narrative: `${compact(victories)} wins against ${compact(defeats)} losses.`,
    });
  }

  const meritPower = ratio(merits, power);
  if (meritPower !== null && num(merits) > 0) {
    rows.push({
      key: 'meritPower',
      label: 'Merit efficiency',
      value: Number(meritPower.toFixed(6)),
      text: `${meritPower.toFixed(4)} merit per power`,
      narrative: 'Merits earned in proportion to the account is carrying.',
    });
  }

  const t45Share = ratio(t45dead, deaths);
  if (t45Share !== null) {
    rows.push({
      key: 't45LossShare',
      label: 'Elite unit losses',
      value: Number(t45Share.toFixed(4)),
      text: `${(t45Share * 100).toFixed(0)}% of losses were T4/T5`,
      narrative:
        t45Share > 0.5
          ? 'The bulk of losses sit in high-tier units, which is expensive to rebuild.'
          : 'Losses skew toward cheaper units, so recovery stays affordable.',
    });
  }

  return rows;
}

function buildGains(series, progress) {
  // Rank is tracked but never a "gain": a smaller number is a climb, and
  // listing it alongside rising counters would read as a loss.
  const gains = progress.series
    .filter((row) => row.key !== 'power' && row.key !== 'rank' && row.direction !== 'reset' && row.from > 0)
    .map((row) => ({ ...row, relative: row.delta / row.from }))
    .sort((a, b) => b.relative - a.relative)
    .slice(0, 4)
    .map((row) => ({
      key: row.key,
      label: row.label,
      delta: row.delta,
      deltaText: row.deltaText,
      deltaPctText: row.deltaPctText,
      from: row.from,
      to: row.to,
      narrative: `${row.label} moved from ${compact(row.from)} to ${compact(row.to)}.`,
    }));

  const powerRow = progress.series.find((row) => row.key === 'power');
  if (powerRow) {
    gains.unshift({
      key: 'power',
      label: 'Power',
      delta: powerRow.delta,
      deltaText: powerRow.deltaText,
      deltaPctText: powerRow.deltaPctText,
      from: powerRow.from,
      to: powerRow.to,
      narrative: `Power moved from ${compact(powerRow.from)} to ${compact(powerRow.to)}.`,
    });
  }
  return gains.slice(0, 5);
}

function buildMilestones(last) {
  const definitions = [
    { key: 'power', label: 'Power', value: last ? last.power : null, bands: POWER_BANDS },
    { key: 'kills', label: 'Units Killed', value: at(last, M.kills), bands: KILL_BANDS },
    { key: 'healed', label: 'Units Healed', value: at(last, M.healed), bands: HEAL_BANDS },
    { key: 'merits', label: 'Merits', value: at(last, M.merits), bands: MERIT_BANDS },
    { key: 'victories', label: 'Victories', value: at(last, M.victories), bands: VICTORY_BANDS },
  ];

  return definitions
    // A counter sitting at zero (a season that just opened) has no useful
    // progress bar, and "0% complete" would read as a failure rather than as
    // "nothing banked yet".
    .filter((item) => num(item.value) !== null && num(item.value) > 0)
    .map((item) => {
      const current = num(item.value);
      const target = item.bands.find((band) => band > current) ?? nextRound(current);
      return {
        key: item.key,
        label: item.label,
        current,
        currentText: compact(current),
        target,
        targetText: compact(target),
        remaining: Math.max(0, target - current),
        remainingText: compact(Math.max(0, target - current)),
        pct: clamp((current / target) * 100, 0, 100),
      };
    });
}

function levelFor(score) {
  if (score === null) return 'unknown';
  if (score >= 0.75) return 'strong';
  if (score >= 0.55) return 'good';
  if (score >= 0.35) return 'steady';
  if (score >= 0.15) return 'building';
  return 'new';
}

const ARCHETYPES = [
  {
    key: 'warlord',
    label: 'Warlord',
    blurb: 'Measures progress in battles won and units taken off the field.',
    strengths: ['Front-line pressure', 'Battle volume'],
    growth: ['Recovery between fights', 'City upkeep'],
  },
  {
    key: 'guardian',
    label: 'Guardian',
    blurb: 'Keeps the account - and often the alliance - standing after every fight.',
    strengths: ['Sustain and recovery', 'Low net attrition'],
    growth: ['Damage output', 'Finishing fights'],
  },
  {
    key: 'architect',
    label: 'Architect',
    blurb: 'Power leans on buildings and research rather than raw troop volume.',
    strengths: ['Buildings and technology', 'Efficient power base'],
    growth: ['Troop depth', 'Field presence'],
  },
  {
    key: 'rallyer',
    label: 'Rallyer',
    blurb: 'Contributes steadily to alliance activity instead of playing solo.',
    strengths: ['Alliance contributions', 'Team events'],
    growth: ['Personal combat record', 'Independent gains'],
  },
  {
    key: 'settler',
    label: 'Settler',
    blurb: 'Gathering and resource flow are the engine behind the account.',
    strengths: ['Resource income', 'Sustainable growth'],
    growth: ['Combat statistics', 'War participation'],
  },
  {
    key: 'riser',
    label: 'Rising Star',
    blurb: 'Still climbing quickly - growth is outpacing everything else.',
    strengths: ['Fast power growth', 'Momentum'],
    growth: ['Combat record', 'Efficiency ratios'],
  },
  {
    key: 'balanced',
    label: 'All-Rounder',
    blurb: 'No single axis dominates; the account develops evenly.',
    strengths: ['Even development', 'Flexibility'],
    growth: ['A standout specialty'],
  },
];

function buildPlaystyle(last, progress) {
  const spreadTotal = ['buildingPower', 'heroPower', 'legionPower', 'techPower']
    .map((key) => num(at(last, key)))
    .filter((v) => v !== null)
    .reduce((sum, v) => sum + v, 0);

  const structureShare =
    spreadTotal > 0
      ? ((num(at(last, M.buildingPower)) || 0) + (num(at(last, M.techPower)) || 0)) / spreadTotal
      : null;

  const winRate = ratio(at(last, M.victories), num(at(last, M.victories)) + num(at(last, M.defeats)));
  const combat = mean([
    intensity(at(last, M.kills), KILL_BANDS),
    winRate === null ? null : clamp(winRate, 0, 1),
    intensity(at(last, M.sieges), [10, 50, 150, 400, 1000]),
  ]);
  const support = mean([
    intensity(at(last, M.healed), HEAL_BANDS),
    intensity(at(last, M.donations), [1e4, 5e4, 2e5, 1e6, 5e6]),
  ]);
  const builder = mean([
    structureShare === null ? null : clamp(structureShare, 0, 1),
    intensity(at(last, M.buildingPower), [1e6, 5e6, 2e7, 5e7, 1e8]),
  ]);
  const settler = intensity(at(last, M.gathered), [1e6, 1e7, 1e8, 5e8, 2e9]);
  const growthRow = progress.series.find((row) => row.key === 'power');
  const growth =
    growthRow && growthRow.deltaPct !== null ? clamp(Math.abs(growthRow.deltaPct) / 50, 0, 1) : null;
  const riser = growth === null ? null : growth * (1 - clamp(combat || 0, 0, 1));
  const rallyer = mean([
    intensity(at(last, M.donations), [1e4, 5e4, 2e5, 1e6, 5e6]),
    intensity(at(last, M.helps), [5e3, 2e4, 1e5, 5e5, 2e6]),
  ]);

  const scores = [
    { key: 'warlord', score: combat },
    { key: 'guardian', score: support },
    { key: 'architect', score: builder },
    { key: 'rallyer', score: rallyer },
    { key: 'settler', score: settler },
    { key: 'riser', score: riser },
  ].filter((item) => item.score !== null);

  if (!scores.length) return { key: 'balanced', label: 'All-Rounder', available: false };

  const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
  const archetype = ARCHETYPES.find((item) => item.key === best.key);
  return {
    ...archetype,
    available: true,
    score: Number(best.score.toFixed(3)),
    level: levelFor(best.score),
    inputs: {
      combat: combat === null ? null : Number(combat.toFixed(3)),
      support: support === null ? null : Number(support.toFixed(3)),
      builder: builder === null ? null : Number(builder.toFixed(3)),
      settler: settler === null ? null : Number(settler.toFixed(3)),
      rallyer: rallyer === null ? null : Number(rallyer.toFixed(3)),
      growth: growth === null ? null : Number(growth.toFixed(3)),
    },
  };
}

function signal(key, label, score, reason) {
  return { key, label, level: levelFor(score), score: score === null ? null : Number(score.toFixed(3)), reason };
}

function buildProfile(last, progress, playstyle) {
  const powerIntensity = intensity(last ? last.power : null, POWER_BANDS);
  const growthRow = progress.series.find((row) => row.key === 'power');
  const growth =
    growthRow && growthRow.deltaPct !== null ? clamp(Math.abs(growthRow.deltaPct) / 50, 0, 1) : null;
  const rankRow = progress.series.find((row) => row.key === 'rank');
  const rankClimb =
    rankRow && rankRow.delta !== null ? clamp(-rankRow.delta / 50, 0, 1) : null;

  const combat = mean([
    intensity(at(last, M.kills), KILL_BANDS),
    intensity(num(at(last, M.victories)) + num(at(last, M.defeats)), [50, 250, 1000, 5000, 20000]),
  ]);
  const contribution = mean([
    intensity(at(last, M.merits), MERIT_BANDS),
    intensity(at(last, M.healed), HEAL_BANDS),
    intensity(at(last, M.victories), VICTORY_BANDS),
  ]);
  const progression = mean([
    intensity(at(last, M.townHall), [15, 20, 24, 27, 30]),
    intensity(at(last, M.seasonsPlayed), [1, 2, 4, 7, 10]),
    intensity(at(last, M.buildingPower), [1e6, 5e6, 2e7, 5e7, 1e8]),
  ]);

  const overall = mean([powerIntensity, combat, growth]);

  return [
    signal('overall', 'Overall', overall, 'Combined scale, momentum and battle record.'),
    signal(
      'combatActivity',
      'Combat activity',
      combat,
      'How much fighting this account has recorded.',
    ),
    signal(
      'growth',
      'Growth',
      mean([growth, rankClimb]),
      growthRow && growthRow.deltaPctText
        ? `Power ${growthRow.deltaPctText} over the tracked window.`
        : 'Power momentum over the tracked window.',
    ),
    signal(
      'warContribution',
      'War contribution',
      contribution,
      'Merits, healing and victories earned.',
    ),
    signal(
      'accountProgression',
      'Account progression',
      progression,
      'Town hall, seasons played and building investment.',
    ),
  ].map((item) => ({ ...item, driver: playstyle ? playstyle.key : null }));
}

function buildSeason(last) {
  const seasons = num(at(last, M.seasonsPlayed));
  if (seasons === null) return { available: false };
  const wins = num(at(last, M.seasonVictories)) ?? 0;
  const losses = num(at(last, M.seasonDefeats)) ?? 0;
  const winrate = ratio(wins, wins + losses);
  const tier =
    winrate === null
      ? 'Unranked'
      : winrate >= 0.6
        ? 'Veteran'
        : winrate >= 0.45
          ? 'Contender'
          : winrate >= 0.3
            ? 'Climber'
            : 'Developing';
  return {
    available: true,
    seasonsPlayed: seasons,
    record: { victories: wins, defeats: losses },
    winrate: winrate === null ? null : Number(winrate.toFixed(4)),
    winrateText: winrate === null ? null : `${(winrate * 100).toFixed(0)}%`,
    bestMerits: num(at(last, M.bestMerits)),
    bestMeritsText: compact(at(last, M.bestMerits)),
    tier,
    narrative: `${seasons} season${seasons === 1 ? '' : 's'} played, ${wins} wins against ${losses} losses - ${tier.toLowerCase()} by win rate.`,
  };
}

const SITE_BADGES = [
  { key: 'power-10m', label: 'Towns of note', group: 'Power', band: 1e7, get: (p) => p.power },
  { key: 'power-50m', label: 'Major power', group: 'Power', band: 5e7, get: (p) => p.power },
  { key: 'power-100m', label: 'Heavyweight', group: 'Power', band: 1e8, get: (p) => p.power },
  { key: 'power-500m', label: 'Dominant force', group: 'Power', band: 5e8, get: (p) => p.power },
  { key: 'power-1b', label: 'Titan', group: 'Power', band: 1e9, get: (p) => p.power },
  { key: 'kills-1m', label: 'First million', group: 'Combat', band: 1e6, get: (p) => at(p, M.kills) },
  { key: 'kills-10m', label: 'Ten million', group: 'Combat', band: 1e7, get: (p) => at(p, M.kills) },
  { key: 'kills-50m', label: 'Fifty million', group: 'Combat', band: 5e7, get: (p) => at(p, M.kills) },
  { key: 'kills-100m', label: 'Hundred million', group: 'Combat', band: 1e8, get: (p) => at(p, M.kills) },
  { key: 'healed-1m', label: 'Field medic', group: 'Sustain', band: 1e6, get: (p) => at(p, M.healed) },
  { key: 'healed-10m', label: 'Lifeline', group: 'Sustain', band: 1e7, get: (p) => at(p, M.healed) },
  { key: 'healed-50m', label: 'Unbreakable', group: 'Sustain', band: 5e7, get: (p) => at(p, M.healed) },
  { key: 'victories-100', label: 'Century of wins', group: 'Combat', band: 100, get: (p) => at(p, M.victories) },
  { key: 'victories-1000', label: 'Thousand wins', group: 'Combat', band: 1000, get: (p) => at(p, M.victories) },
  { key: 'victories-5000', label: 'Five thousand wins', group: 'Combat', band: 5000, get: (p) => at(p, M.victories) },
  { key: 'merits-10k', label: 'Decorated', group: 'Honours', band: 1e4, get: (p) => at(p, M.merits) },
  { key: 'merits-100k', label: 'Highly decorated', group: 'Honours', band: 1e5, get: (p) => at(p, M.merits) },
  { key: 'merits-500k', label: 'Legend of the season', group: 'Honours', band: 5e5, get: (p) => at(p, M.merits) },
  { key: 'seasons-1', label: 'Seasoned', group: 'Journey', band: 1, get: (p) => at(p, M.seasonsPlayed) },
  { key: 'seasons-3', label: 'Three seasons in', group: 'Journey', band: 3, get: (p) => at(p, M.seasonsPlayed) },
  { key: 'seasons-5', label: 'Five seasons in', group: 'Journey', band: 5, get: (p) => at(p, M.seasonsPlayed) },
];

function buildBadges(series) {
  const first = series[0];
  const last = series[series.length - 1];
  return SITE_BADGES.map((badge) => {
    const current = num(badge.get(last));
    if (current === null) return null;
    let earnedOn = null;
    for (const point of series) {
      const value = num(badge.get(point));
      if (value !== null && value >= badge.band) {
        earnedOn = point.date;
        break;
      }
    }
    const previous = num(badge.get(first));
    return {
      key: badge.key,
      label: badge.label,
      group: badge.group,
      threshold: badge.band,
      thresholdText: compact(badge.band),
      earned: current >= badge.band,
      earnedOn,
      pct: clamp((current / badge.band) * 100, 0, 100),
      nearest: previous === null || previous >= badge.band,
    };
  }).filter(Boolean);
}

function buildActivity(series) {
  if (series.length < 2) {
    return {
      available: false,
      narrative: 'Activity levels appear once this player has been captured in at least two snapshots.',
      areas: [],
    };
  }
  const areas = [
    { key: 'combat', label: 'Combat', points: (p) => [at(p, M.kills), at(p, M.victories), at(p, M.defeats)] },
    { key: 'growth', label: 'Growth', points: (p) => [p.power] },
    { key: 'support', label: 'Support', points: (p) => [at(p, M.healed), at(p, M.donations)] },
    { key: 'gathering', label: 'Gathering', points: (p) => [at(p, M.gathered)] },
    { key: 'alliance', label: 'Alliance', points: (p) => [at(p, M.donations), at(p, M.helps)] },
  ];

  const rows = areas.map((area) => {
    // Detail metrics land on scattered dates, so readings are paired by "the
    // dates this area was actually measured" rather than by neighbouring
    // snapshots - otherwise a gap in coverage reads as no activity at all.
    const readings = [];
    for (const point of series) {
      const values = area.points(point).map(num);
      if (values.some((value) => value === null)) continue;
      readings.push(values.reduce((sum, value) => sum + value, 0));
    }
    const deltas = [];
    for (let i = 1; i < readings.length; i += 1) {
      deltas.push(readings[i] - readings[i - 1]);
    }

    if (!deltas.length) {
      return { key: area.key, label: area.label, level: 'unknown', delta: null, readings: readings.length };
    }
    const latest = deltas[deltas.length - 1];
    const prior = deltas.slice(0, -1);
    const priorMean = prior.length ? prior.reduce((s, v) => s + v, 0) / prior.length : null;
    let level;
    if (latest <= 0) level = 'idle';
    else if (priorMean === null) level = 'active';
    else if (latest > priorMean * 1.5) level = 'surging';
    else if (latest > priorMean * 0.5) level = 'active';
    else if (latest > priorMean * 0.15) level = 'steady';
    else level = 'quiet';
    return {
      key: area.key,
      label: area.label,
      level,
      delta: latest,
      deltaText: signed(latest),
      readings: readings.length,
    };
  });

  const measured = rows.filter((row) => row.level !== 'unknown');
  if (!measured.length) {
    return {
      available: false,
      narrative: 'Activity levels appear once this player has been captured in at least two snapshots.',
      areas: rows,
    };
  }

  const activeCount = measured.filter(
    (row) => row.level === 'surging' || row.level === 'active',
  ).length;
  const narrative =
    activeCount >= 3
      ? 'Moving on several fronts at once right now.'
      : activeCount === 2
        ? 'Active on two fronts over the last interval.'
        : activeCount === 1
          ? 'One area is carrying the momentum right now.'
          : 'Quiet across the board over the last interval.';

  return { available: true, narrative, areas: rows };
}

function buildComparison(series) {
  if (series.length < 2) return { available: false, periods: [], narrative: null };

  const periods = [];
  for (const spec of TRACKED) {
    const readings = [];
    for (let i = series.length - 1; i >= 0 && readings.length < 2; i -= 1) {
      const value = trackValue(series[i], spec);
      if (value !== null) readings.push({ value, date: series[i].date });
    }
    if (readings.length < 2) continue;
    const now = readings[0];
    const before = readings[1];
    const delta = now.value - before.value;
    const reset = Boolean(spec.seasonScoped) && delta < 0;
    periods.push({
      key: spec.key,
      label: spec.label,
      scope: spec.seasonScoped ? 'season' : 'cumulative',
      recent: now.value,
      previous: before.value,
      recentDate: now.date,
      previousDate: before.date,
      delta,
      deltaText: reset ? null : signed(delta),
      deltaPctText: reset ? 'new season' : signedPct(percent(before.value, now.value)),
      direction: reset ? 'reset' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      // Rank inverts: falling is climbing.
      better: reset ? null : spec.kind === 'rank' ? delta < 0 : delta > 0,
    });
  }

  const dates = periods.map((row) => row.previousDate);
  const toDates = periods.map((row) => row.recentDate);
  return {
    available: periods.length > 0,
    from: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
    to: toDates.length ? toDates.reduce((a, b) => (a > b ? a : b)) : null,
    periods,
    narrative: periods.length
      ? 'Comparing this player against their own previous reading - no other account is involved.'
      : null,
  };
}

/**
 * The source's own playstyle hexagon, in the game's axis order.
 *
 * Values are percentiles where **lower is better** - the source prints
 * "Lower percentages indicate a higher KvK ranking" under the chart, and its
 * own geometry puts a smaller percentage further from the centre, so a bigger
 * polygon is the better account. Everything else in this module is
 * "higher is better"; this block deliberately is not.
 */
const PLAYSTYLE_AXES = [
  { key: 'merits', label: 'Merits' },
  { key: 'behemoths', label: 'Behemoths' },
  { key: 'gathering', label: 'Gathering' },
  { key: 'peacekeeping', label: 'Peacekeeping' },
  { key: 'healing', label: 'Healing' },
  { key: 'engineering', label: 'Engineering' },
];

const PLAYSTYLE_NOTE = 'Lower percentages indicate a higher KvK ranking.';

function seasonFromDivision(raw) {
  const match = /Season\s*(\d+)/i.exec(String(raw || ''));
  return match ? Number(match[1]) : null;
}

function readingLabel(reading) {
  if (!reading) return 'unknown';
  return reading.season ? `Season ${reading.season}` : reading.date;
}

function buildRadar(radarByDate = {}, metricsByDate = {}) {
  const readings = Object.entries(radarByDate || {})
    .map(([date, values]) => ({
      date,
      season: seasonFromDivision(metricsByDate[date] && metricsByDate[date].Division),
      values: PLAYSTYLE_AXES.map((axis) => {
        const value = num(values ? values[axis.label] : null);
        return value === null ? null : clamp(value, 0, 100);
      }),
    }))
    .filter((reading) => reading.values.some((value) => value !== null))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!readings.length) {
    return {
      available: false,
      reason: 'awaiting_capture',
      note: PLAYSTYLE_NOTE,
      axes: PLAYSTYLE_AXES,
      readings: [],
      current: null,
      previous: null,
      deltas: [],
      summary:
        'The playstyle hexagon is captured from the player page on the next detail pass.',
    };
  }

  const current = readings[readings.length - 1];
  const previous = readings.length > 1 ? readings[readings.length - 2] : null;

  const deltas = PLAYSTYLE_AXES.map((axis, index) => {
    if (!previous) return null;
    const now = current.values[index];
    const before = previous.values[index];
    if (now === null || before === null) return null;
    const delta = Number((now - before).toFixed(1));
    return {
      key: axis.key,
      label: axis.label,
      current: now,
      previous: before,
      delta,
      deltaText: `${delta > 0 ? '+' : ''}${delta}`,
      direction: delta < 0 ? 'better' : delta > 0 ? 'worse' : 'flat',
    };
  }).filter(Boolean);

  const better = deltas.filter((row) => row.direction === 'better');
  const worse = deltas.filter((row) => row.direction === 'worse');
  const parts = previous
    ? [`${readingLabel(previous)} → ${readingLabel(current)}`]
    : [`${readingLabel(current)} captured`];
  if (previous) {
    if (better.length) parts.push(`improved on ${better.map((row) => row.label.toLowerCase()).join(', ')}`);
    if (worse.length) parts.push(`slipped on ${worse.map((row) => row.label.toLowerCase()).join(', ')}`);
    if (!better.length && !worse.length) parts.push('unchanged on every axis');
  }

  return {
    available: true,
    note: PLAYSTYLE_NOTE,
    axes: PLAYSTYLE_AXES,
    readings,
    current,
    previous,
    deltas,
    improved: better.length,
    worsened: worse.length,
    summary: parts.join(' · '),
  };
}

function buildNarrative(name, playstyle, progress, profile, season, activity) {
  const powerRow = progress.series.find((row) => row.key === 'power');
  // "Overall" is a roll-up of the other signals, so naming it as both the top
  // strength and the weakest area would just echo the same number twice.
  const ranked = profile
    .filter((item) => item.key !== 'overall' && item.score !== null)
    .sort((a, b) => b.score - a.score);
  const strongest = ranked[0] || null;
  const weakest = ranked[ranked.length - 1] || null;

  const summary = [
    `${name} plays as a ${playstyle.label}${playstyle.available ? '' : ' (partial data)'}.`,
    powerRow
      ? `Power sits at ${powerRow.toText || compact(powerRow.to)} after ${powerRow.deltaPctText || 'no measurable'} change across ${progress.windowDays} days.`
      : 'Power history is still being collected.',
    season.available ? season.narrative : null,
    activity.available ? activity.narrative : null,
  ].filter(Boolean);

  return {
    summary: summary.join(' '),
    strengths: [
      ...(strongest ? [strongest.label] : []),
      ...((playstyle.strengths || []).slice(0, 1)),
    ],
    improvements:
      weakest && (!strongest || weakest.key !== strongest.key)
        ? [weakest.label]
        : (playstyle.growth || []),
    meaning:
      playstyle.key === 'balanced'
        ? 'Development is spread evenly rather than concentrated in one area.'
        : `The clearest signal in the numbers is ${playstyle.label.toLowerCase()} behaviour${
            strongest ? `, matching the ${strongest.label.toLowerCase()} reading` : ''
          }.`,
    privacyNote:
      'Every figure here is compared against this player\u2019s own earlier readings. No other player\u2019s data is used.',
  };
}

function buildInsights({
  history = [],
  metricsByDate = {},
  radarByDate = {},
  serverNumber = null,
  name = 'This player',
} = {}) {
  const series = seriesFrom(history, metricsByDate);
  if (!series.length) {
    return { available: false, reason: 'no_history' };
  }

  const last = series[series.length - 1];
  const progress = buildProgress(series);
  progress.series.forEach((row) => {
    row.toText = compact(row.to);
  });

  const playstyle = buildPlaystyle(last, progress);
  const profile = buildProfile(last, progress, playstyle);
  const efficiency = buildEfficiency(last);
  const season = buildSeason(last);
  const activity = buildActivity(series);
  const badges = buildBadges(series);
  const radar = buildRadar(radarByDate, metricsByDate);

  const seasonsSeen = series
    .map((point) => num(point.metrics[M.seasonsPlayed]))
    .filter((value) => value !== null);
  const seasonReset =
    seasonsSeen.length >= 2 && seasonsSeen[seasonsSeen.length - 1] > seasonsSeen[0];

  const narrative = buildNarrative(name, playstyle, progress, profile, season, activity);
  if (seasonReset) {
    narrative.summary += ' A new season opened during the tracked window, so current-season counters restarted.';
  }

  return {
    available: true,
    privacy: 'self-comparison-only',
    generatedAt: new Date().toISOString(),
    serverNumber,
    coverage: {
      snapshots: series.length,
      first: series[0].date,
      last: last.date,
      detailDates: Object.keys(metricsByDate).length,
      hasDetail: Object.keys(metricsByDate).length > 0,
      hasCombat: at(last, M.kills) !== null,
      seasonReset,
      missing: [
        at(last, M.kills) === null ? 'combat' : null,
        at(last, M.healed) === null ? 'sustain' : null,
        at(last, M.gathered) === null ? 'gathering' : null,
      ].filter(Boolean),
    },
    playstyle,
    profile,
    progress,
    timeline: buildTimeline(series),
    efficiency,
    gains: buildGains(series, progress),
    milestones: buildMilestones(last),
    seasonJourney: season,
    radar,
    activity,
    comparison: buildComparison(series),
    achievements: badges,
    narrative,
  };
}

module.exports = {
  buildInsights,
  buildPlaystyle,
  buildProfile,
  buildProgress,
  buildEfficiency,
  buildMilestones,
  buildGains,
  buildBadges,
  buildSeason,
  buildRadar,
  buildActivity,
  buildComparison,
  PLAYSTYLE_AXES,
  intensity,
  nextRound,
  compact,
  flatten,
};
