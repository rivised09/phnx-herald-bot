/**
 * The last alliance we actually recorded for a player, walking backwards from
 * a date.
 *
 * DragonStats leaves `alliance` empty for players it has no alliance record
 * for, and the read path used to turn that empty string into "Not In An
 * Alliance" - so a lord who was in [PHW-] on the last callofstats day and has
 * no DragonStats alliance record afterwards suddenly appeared unallied on
 * every page. An empty field is missing information, not a change of state,
 * so the newest earlier *statement* about the player's alliance stands.
 *
 * The walk treats three earlier states differently:
 *
 *   a real name            -> that is the answer, stop.
 *   null with power there  -> callofstats read the player and recorded no
 *                             alliance: a genuine "unallied", stop (an older
 *                             alliance must not be resurrected).
 *   null without power     -> a date with no data for this player: keep going.
 *   "Not In An Alliance"   -> the marker this module exists to replace: keep
 *                             going, it only repeats "DragonStats did not know".
 *
 * Returns the alliance name, or null when the player is confirmed unallied /
 * has no history at all.
 */
const UNAFFILIATED = 'Not In An Alliance';

function lastKnownAlliance(file, date) {
  if (!file || !file.byDate) return null;

  const earlier = Object.keys(file.byDate)
    .filter((day) => day < date)
    .sort()
    .reverse();

  for (const day of earlier) {
    const entry = file.byDate[day];
    if (!entry) continue;
    const alliance = entry.alliance;
    if (typeof alliance === 'string') {
      const name = alliance.trim();
      if (name && name !== UNAFFILIATED) return name;
      continue; // the empty-marker, or an empty string: no information
    }
    if (alliance === null || alliance === undefined) {
      // callofstats recorded the player with power but no alliance: unallied.
      if (entry.power !== null && entry.power !== undefined) return null;
      continue; // no data for this player on that date
    }
  }
  return null;
}

/**
 * Builds the `resolveAlliance(id)` callback `map.fromScan` accepts out of the
 * already-loaded player files (`Map<id, file>`).
 */
function allianceResolver(filesById, date) {
  return (id) => lastKnownAlliance(filesById.get(String(id)), date);
}

module.exports = { lastKnownAlliance, allianceResolver, UNAFFILIATED };
