const { CONFIG } = require('../config');

/**
 * v2 roster source: an alliance spreadsheet.
 *
 * Independent of v1 (scraping) by design. The sheet is not available yet, so
 * this returns clearly-flagged placeholder rows: enough to exercise layout and
 * wiring, never mistaken for real members. Replace readSheetRows() once the
 * sheet exists and the rest of this file works unchanged.
 */

const PLACEHOLDER_ROWS = [
  { name: 'Placeholder One', troop: 'Infantry' },
  { name: 'Placeholder Two', troop: 'Mage' },
  { name: 'Placeholder Three', troop: 'Archer' },
  { name: 'Placeholder Four', troop: 'Cavalry' },
  { name: 'Placeholder Five', troop: 'Infantry' },
  { name: 'Placeholder Six', troop: 'Archer' },
];

/**
 * TODO(roster-v2): read the real sheet.
 *
 * Should return rows shaped like { id, name, stats: {...} }. The sheet id and
 * range will be configured alongside the existing survey sheet settings.
 */
async function readSheetRows() {
  return PLACEHOLDER_ROWS.map((row, i) => ({
    id: `placeholder-${i + 1}`,
    name: row.name,
    stats: { troop: row.troop },
  }));
}

function normalize(rows) {
  return rows
    .map((row, i) => ({
      id: String(row.id || row.name || i),
      name: String(row.name || row.id || `Player ${i + 1}`),
      stats: row.stats && typeof row.stats === 'object' ? row.stats : {},
    }))
    .filter((row) => row.name);
}

async function getRoster() {
  let rows;
  try {
    rows = normalize(await readSheetRows());
  } catch (err) {
    return {
      version: 'v2',
      status: 'fetch_failed',
      detail: err.message,
      alliances: [],
      players: [],
    };
  }

  const placeholderAlliance = rows.map((row, index) => ({
    id: `placeholder-alliance-${index + 1}`,
    name: row.name || `Placeholder Alliance ${index + 1}`,
    stats: { troop: row.stats?.troop || 'Placeholder' },
  }));

  return {
    version: 'v2',
    status: 'ok',
    placeholder: true,
    detail: 'Placeholder data. The v2 spreadsheet is not connected yet.',
    alliances: placeholderAlliance,
    players: rows,
    guild: CONFIG.DISCORD.GUILD_NAME || null,
  };
}

module.exports = { getRoster };
