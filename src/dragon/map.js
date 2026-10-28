const crypto = require('crypto');

/**
 * DragonStats scan -> our published shape.
 *
 * A scan is one JSON file per server: an array of up to ~300 players with about
 * a hundred numeric fields each, all as exact strings ("127231063"), which is
 * why the site can show "127.2M" without us ever receiving a rounded number.
 *
 * Two rules shape this mapping:
 *
 *  1. **Our labels win.** Where a DragonStats field is the same fact as
 *     something we already publish - "Current Power", "T4 Kills", "Merits" -
 *     it is written under that existing label, in the same section, so the
 *     site and its charts keep working without a change.
 *  2. **Nothing is dropped.** A field with no counterpart is not discarded: it
 *     gets a readable label and lands in a "Dragon Stats" section, and the same
 *     value goes into `metrics` so it is chartable like the rest. The one
 *     exception is the handful of metadata keys (`id`, `name`, `rank`, ...),
 *     which are already carried by the shape itself.
 *
 * The resource order is not a guess: GatherRes1..4 / CostRes1..4 are Gold,
 * Wood, Ore, Mana, verified against callofstats' per-resource totals for the
 * same player days apart (405M/442M/419M vs Wood/Ore/Mana).
 */

/** Numbers arrive as strings and are published raw in metrics. */
function num(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Thousands separators, matching what the current snapshot renders. */
function formatted(value) {
  const parsed = num(value);
  return parsed === null ? null : parsed.toLocaleString('en-US');
}

/** `#973` from either 973 or "#973". */
function serverLabel(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.startsWith('#') ? text : `#${text}`;
}

/** How a field is read, written and displayed. */
const TEXT = 'text';
const SERVER = 'server';
const NUMBER = 'number';
const SECONDS = 'seconds';

/**
 * DragonStats field -> our label, section and formatting.
 *
 * `section` uses the names the callofstats scrape already publishes, so a
 * DragonStats day groups exactly like the days around it on the player page.
 */
const FIELD_MAP = [
  { from: 'id', label: 'ID', section: '', kind: TEXT },
  { from: 'alliance', label: 'Alliance', section: '', kind: TEXT },
  { from: 'serverId', label: 'Server', section: '', kind: SERVER },
  { from: 'power', label: 'Current Power', section: '', kind: NUMBER },
  { from: 'TopPower', label: 'Highest Power', section: '', kind: NUMBER },
  { from: 'castleLevel', label: 'Town Hall', section: '', kind: NUMBER },
  { from: 'migrationScore', label: 'Migration Score', section: '', kind: NUMBER },
  { from: 'currentlyKing', label: 'Currently King', section: '', kind: TEXT },
  { from: 'daysAsKing', label: 'Days as King', section: '', kind: TEXT },
  { from: 'division', label: 'Division', section: '', kind: TEXT },
  { from: 'faction', label: 'Faction', section: '', kind: TEXT },
  { from: 'leadershipTime', label: 'Leadership Time', section: '', kind: TEXT },

  { from: 'infantry_merits', label: 'Infantry Merits', section: 'Advanced War Stats', kind: NUMBER },
  { from: 'rider_merits', label: 'Cavalry Merits', section: 'Advanced War Stats', kind: NUMBER },
  { from: 'caster_merits', label: 'Mage Merits', section: 'Advanced War Stats', kind: NUMBER },
  { from: 'archer_merits', label: 'Marksman Merits', section: 'Advanced War Stats', kind: NUMBER },
  { from: 'other_merits', label: 'Other Merits', section: 'Advanced War Stats', kind: NUMBER },
  { from: 't4_dead', label: 'T4 Units Dead', section: 'Advanced War Stats', kind: NUMBER },
  { from: 't5_dead', label: 'T5 Units Dead', section: 'Advanced War Stats', kind: NUMBER },
  { from: 't4_heal', label: 'T4 Units Rss Healed', section: 'Advanced War Stats', kind: NUMBER },
  { from: 't5_heal', label: 'T5 Units Rss Healed', section: 'Advanced War Stats', kind: NUMBER },

  { from: 'allianceDonationPoints', label: 'Alliance Donations', section: 'Alliance Activity', kind: NUMBER },
  { from: 'bossbattle_cnt', label: 'Behemoth Raid Wins', section: 'Alliance Activity', kind: NUMBER },
  { from: 'build_time', label: 'Build Time', section: 'Alliance Activity', kind: SECONDS },
  { from: 'destroy_time', label: 'Destruction Time', section: 'Alliance Activity', kind: SECONDS },

  { from: 'HelpTimes', label: 'Times Alliance Helps Given', section: 'Extra Resource Stats', kind: NUMBER },
  { from: 'CollectedVolume', label: 'Total Resources Gathered', section: 'Extra Resource Stats', kind: NUMBER },

  { from: 'AttackCityTimes', label: 'City Sieges', section: 'Extra War Stats', kind: NUMBER },
  { from: 'FailureTimes', label: 'Defeats', section: 'Extra War Stats', kind: NUMBER },
  { from: 'ScoutTimes', label: 'Times Scouted', section: 'Extra War Stats', kind: NUMBER },
  { from: 'VictoryTimes', label: 'Victories', section: 'Extra War Stats', kind: NUMBER },

  { from: 'GatherGem', label: 'Gems Gathered', section: 'Gathered Resources', kind: NUMBER },
  { from: 'GatherRes1', label: 'Gold Gathered', section: 'Gathered Resources', kind: NUMBER },
  { from: 'GatherRes2', label: 'Wood Gathered', section: 'Gathered Resources', kind: NUMBER },
  { from: 'GatherRes3', label: 'Ore Gathered', section: 'Gathered Resources', kind: NUMBER },
  { from: 'GatherRes4', label: 'Mana Gathered', section: 'Gathered Resources', kind: NUMBER },

  { from: 'CostGem', label: 'Gems Spent', section: 'Historic Resources Spent', kind: NUMBER },
  { from: 'CostRes1', label: 'Gold Spent', section: 'Historic Resources Spent', kind: NUMBER },
  { from: 'CostRes2', label: 'Wood Spent', section: 'Historic Resources Spent', kind: NUMBER },
  { from: 'CostRes3', label: 'Ore Spent', section: 'Historic Resources Spent', kind: NUMBER },
  { from: 'CostRes4', label: 'Mana Spent', section: 'Historic Resources Spent', kind: NUMBER },

  { from: 't1kill', label: 'T1 Kills', section: 'Historic Tiered Kills', kind: NUMBER },
  { from: 't2kill', label: 'T2 Kills', section: 'Historic Tiered Kills', kind: NUMBER },
  { from: 't3kill', label: 'T3 Kills', section: 'Historic Tiered Kills', kind: NUMBER },
  { from: 't4kill', label: 'T4 Kills', section: 'Historic Tiered Kills', kind: NUMBER },
  { from: 't5kill', label: 'T5 Kills', section: 'Historic Tiered Kills', kind: NUMBER },

  { from: 'maxRssHealCnt', label: 'Historical Most Resource Healing', section: 'Historical Season Stats', kind: NUMBER },
  { from: 'kvkWinCnt', label: 'Season Victories', section: 'Historical Season Stats', kind: NUMBER },
  { from: 'kvkJoinCnt', label: 'Seasons Played', section: 'Historical Season Stats', kind: NUMBER },

  { from: 'BuildingPower', label: 'Building Power', section: 'Power Spread', kind: NUMBER },
  { from: 'HeroPower', label: 'Hero Power', section: 'Power Spread', kind: NUMBER },
  { from: 'TroopPower', label: 'Legion Power', section: 'Power Spread', kind: NUMBER },
  { from: 'TechPower', label: 'Tech Power', section: 'Power Spread', kind: NUMBER },

  { from: 'UnitKill', label: 'Units Killed', section: 'War Stats', kind: NUMBER },
  { from: 'NumberOfHeal', label: 'Units Healed', section: 'War Stats', kind: NUMBER },
  { from: 'NumberOfDeath', label: 'Units Dead', section: 'War Stats', kind: NUMBER },
  { from: 'totalMerits', label: 'Merits', section: 'War Stats', kind: NUMBER },
];

/**
 * Fields that are genuinely new to us.
 *
 * They are the reason a second source is worth having: things callofstats never
 * published. They go into their own section so the familiar ones stay exactly
 * where the page expects them.
 */
const EXTRA_MAP = [
  { from: 'pvpPoint', label: 'PvP Points' },
  { from: 'maxPvpPoint', label: 'Highest PvP Points' },
  { from: 'abyssMerits', label: 'Abyss Merits' },
  { from: 'kvk_merits', label: 'KvK Merits' },
  { from: 'honourKill', label: 'Honour Kills' },
  { from: 'arenaClassTier', label: 'Arena Class Tier' },
  { from: 'PolicyPower', label: 'Policy Power' },
  { from: 'paramountWins', label: 'Paramount Wins' },
  { from: 'anointedRewards', label: 'Anointed Rewards' },
  { from: 'warPets3StarSkills', label: '3 Star War Pet Skills' },
  { from: 'maxUnitTier', label: 'Max Unit Tier' },
  { from: 'VolumeOfTrade', label: 'Trade Volume' },
  { from: 'CountOfTrade', label: 'Trades Completed' },
  { from: 'allianceTrades', label: 'Alliance Trades' },
  { from: 'legendaryArtifacts', label: 'Legendary Artifacts' },
  { from: 'artifactDraws', label: 'Artifact Draws' },
  { from: 'awakenedLegendaryHeroes', label: 'Legendary Heroes Awakened' },
  { from: 'exchangeCoinsSpent', label: 'Exchange Coins Spent' },
  { from: 'decorationsBuilt', label: 'Decorations Built' },
  { from: 'maxedDecorations', label: 'Maxed Decorations' },
  { from: 'epicCityThemes', label: 'Epic City Themes' },
  { from: 'legendaryCityThemes', label: 'Legendary City Themes' },
  { from: 'tripleEpicDecorationLevel', label: 'Triple Epic Decoration Level' },
  { from: 'bestLegendaryDecorationLevel', label: 'Best Legendary Decoration Level' },
  { from: 'allianceGrade', label: 'Alliance Grade' },
  { from: 'allianceTitle', label: 'Alliance Title' },
  { from: 'allianceHelps', label: 'Alliance Helps' },
  { from: 'allianceBuildMinutes', label: 'Alliance Build Minutes' },
  { from: 'allianceBlessingsChestLevel', label: 'Alliance Blessing Chest Level' },
  { from: 'loginStreakDays', label: 'Login Streak Days' },
  { from: 'lastLoginTime', label: 'Last Login Time' },
  { from: 'castleX', label: 'Castle X' },
  { from: 'castleY', label: 'Castle Y' },
  { from: 'castleServerId', label: 'Castle Server' },
  { from: 'castleHidden', label: 'Castle Hidden' },
  { from: 'skinId', label: 'Skin ID' },
  { from: 'gemsSpent', label: 'Gems Spent (Total)' },
  { from: 'weekMeritsInfantry', label: 'Week Merits Infantry' },
  { from: 'weekMeritsCavalry', label: 'Week Merits Cavalry' },
  { from: 'weekMeritsArchers', label: 'Week Merits Archers' },
  { from: 'weekMeritsMages', label: 'Week Merits Mages' },
  { from: 'weekMeritsOther', label: 'Week Merits Other' },
  { from: 't4_hurt', label: 'T4 Units Wounded' },
  { from: 't5_hurt', label: 'T5 Units Wounded' },
  { from: 'enemy_pvpmoney', label: 'Enemy PvP Money' },
];

/**
 * Values computed from several fields, published under the labels we already
 * use so the day joins the existing history instead of sitting beside it.
 */
const DERIVED = [
  {
    label: 'T4/T5 Units Dead',
    section: 'Advanced War Stats',
    compute: (player) => {
      const t4 = num(player.t4_dead);
      const t5 = num(player.t5_dead);
      return t4 === null && t5 === null ? null : (t4 || 0) + (t5 || 0);
    },
  },
  {
    label: 'T4/T5 Units Rss Healed',
    section: 'Advanced War Stats',
    compute: (player) => {
      const t4 = num(player.t4_heal);
      const t5 = num(player.t5_heal);
      return t4 === null && t5 === null ? null : (t4 || 0) + (t5 || 0);
    },
  },
  {
    label: 'Victory to Defeat Ratio',
    section: 'Extra War Stats',
    compute: (player) => {
      const wins = num(player.VictoryTimes);
      const losses = num(player.FailureTimes);
      if (wins === null || losses === null) return null;
      return losses ? Math.round((wins / losses) * 100) / 100 : wins;
    },
  },
  {
    label: 'Season Winrate',
    section: 'Historical Season Stats',
    compute: (player) => {
      const played = num(player.kvkJoinCnt);
      if (!played) return null;
      return Math.round(((num(player.kvkWinCnt) || 0) / played) * 10000) / 100;
    },
  },
  {
    label: 'Kill to Heal Ratio',
    section: 'War Stats',
    compute: (player) => {
      const kills = num(player.UnitKill);
      const heals = num(player.NumberOfHeal);
      if (kills === null || !heals) return null;
      return Math.round((kills / heals) * 1000) / 1000;
    },
  },
  {
    label: 'Merit to Power Ratio',
    section: 'War Stats',
    compute: (player) => {
      const merits = num(player.totalMerits);
      const power = num(player.power);
      if (!merits || !power) return null;
      return Math.round((merits / power) * 1000) / 1000;
    },
  },
];

/** Carried by the shape already, or not meaningful on its own. */
const IGNORED = new Set(['name', 'rank', 'serverName']);

function prettify(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/** A stable id for an alliance we have never seen, so its page never moves. */
function allianceId(name) {
  const hash = crypto.createHash('sha1').update(`dragonstats:${name}`).digest('hex');
  const variant = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

/** The raw value a field contributes to `metrics`. */
function metricValue(field, player) {
  const raw = player[field.from];
  if (field.kind === TEXT) {
    const text = String(raw ?? '').trim();
    return text || null;
  }
  if (field.kind === SERVER) return serverLabel(raw);
  return num(raw);
}

/** The formatted value a field shows in `sections`. */
function displayValue(field, player) {
  const raw = player[field.from];
  if (field.kind === TEXT) {
    const text = String(raw ?? '').trim();
    return text || null;
  }
  if (field.kind === SERVER) return serverLabel(raw);
  if (field.kind === SECONDS) {
    const seconds = num(raw);
    return seconds === null ? null : `${seconds.toLocaleString('en-US')} Sec`;
  }
  return formatted(raw);
}

/** Every metric for one player on one day: label -> number or text. */
function metricsFor(player) {
  const metrics = {};

  for (const field of FIELD_MAP) {
    const value = metricValue(field, player);
    if (value !== null) metrics[field.label] = value;
  }
  for (const field of EXTRA_MAP) {
    const value = num(player[field.from]);
    if (value !== null) metrics[field.label] = value;
  }
  for (const derived of DERIVED) {
    const value = derived.compute(player);
    if (value !== null) metrics[derived.label] = value;
  }

  // Anything numeric the tables above do not name still becomes a metric.
  const known = new Set([
    ...FIELD_MAP.map((field) => field.from),
    ...EXTRA_MAP.map((field) => field.from),
    ...IGNORED,
  ]);
  for (const [key, raw] of Object.entries(player)) {
    if (known.has(key)) continue;
    const value = num(raw);
    if (value !== null) metrics[prettify(key)] = value;
  }

  return metrics;
}

/** Sections for the player page, grouped the way the existing days are. */
function sectionsFor(player) {
  const groups = new Map();
  const push = (section, label, value) => {
    if (value === null || value === undefined) return;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push({ label, value });
  };

  for (const field of FIELD_MAP) push(field.section, field.label, displayValue(field, player));
  for (const field of EXTRA_MAP) push('Dragon Stats', field.label, formatted(player[field.from]));
  for (const derived of DERIVED) {
    const value = derived.compute(player);
    if (value !== null) push(derived.section, derived.label, value.toLocaleString('en-US'));
  }

  const known = new Set([
    ...FIELD_MAP.map((field) => field.from),
    ...EXTRA_MAP.map((field) => field.from),
    ...IGNORED,
  ]);
  for (const [key, raw] of Object.entries(player)) {
    if (known.has(key)) continue;
    push('Dragon Stats', prettify(key), formatted(raw));
  }

  return [...groups].map(([section, rows]) => ({ section, rows }));
}

/**
 * One scan -> the files for that date.
 *
 * `existingAlliances` maps a name to the id already published for it, so a day
 * scraped from DragonStats links to the same alliance page as the days scraped
 * from callofstats instead of creating a second one.
 */
function fromScan(scan, { server, date, existingAlliances = {}, crawledAt = null, serverUrl = null } = {}) {
  if (!Array.isArray(scan) || !scan.length) throw new Error('The scan is empty.');

  const players = [];
  const byAlliance = new Map();

  for (const record of scan) {
    const id = String(record.id || '').trim();
    if (!id) continue;
    const name = String(record.name || '').trim();
    const power = num(record.power);
    const alliance = String(record.alliance || '').trim();

    players.push({
      id,
      name,
      index: num(record.rank),
      allianceId: alliance || null,
      avatar: null,
      stats: {
        Rank: formatted(record.rank) ?? '',
        Power: formatted(record.power) ?? '',
      },
      merits: {
        infantry: num(record.infantry_merits) ?? 0,
        cavalry: num(record.rider_merits) ?? 0,
        mage: num(record.caster_merits) ?? 0,
        marksman: num(record.archer_merits) ?? 0,
      },
    });

    if (alliance) {
      const entry = byAlliance.get(alliance) || { power: 0, members: 0 };
      entry.power += power ?? 0;
      entry.members += 1;
      byAlliance.set(alliance, entry);
    }
  }

  const alliances = [...byAlliance]
    .sort((a, b) => b[1].power - a[1].power)
    .map(([name, entry], index) => ({
      id: existingAlliances[name] || allianceId(name),
      name,
      rank: index + 1,
      stats: {
        Power: entry.power.toLocaleString('en-US'),
        Members: String(entry.members),
      },
    }));

  const playerFiles = new Map();
  for (const record of scan) {
    const id = String(record.id || '').trim();
    if (!id) continue;
    const name = String(record.name || '').trim() || null;
    playerFiles.set(id, {
      id,
      name,
      dates: [date],
      byDate: {
        [date]: {
          name,
          rank: num(record.rank),
          power: num(record.power),
          avatar: null,
          alliance: String(record.alliance || '').trim() || null,
          sections: sectionsFor(record),
        },
      },
      metrics: { [date]: metricsFor(record) },
      radar: {},
      nameHistory: [],
      otherServers: [],
    });
  }

  const snapshot = {
    status: 'ok',
    server: { id: String(server), url: serverUrl || `https://dragonstats.com/dashboard/${server}` },
    alliances,
    players,
    crawledAt: (crawledAt || new Date()).toISOString(),
    snapshot: { date, ingestedAt: new Date().toISOString() },
  };

  return { snapshot, players: playerFiles, alliances };
}

module.exports = {
  fromScan,
  metricsFor,
  sectionsFor,
  allianceId,
  FIELD_MAP,
  EXTRA_MAP,
  DERIVED,
  IGNORED,
};
