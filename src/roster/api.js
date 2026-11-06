/**
 * CallOfStats API client.
 *
 * The site now offers an authenticated JSON API that returns server rosters,
 * player listings, war stats, migrations and name changes without HTML
 * scraping. Each normal scan costs 2 Dracoin; repeat scans of the same server
 * and date are free (`already_bought`).
 *
 *   GET /api/v1/scan/server/{server_num}?minimum_power=20&selected_date=YYYY-MM-DD
 *
 * Authentication: Authorization: Bearer {api_key}
 *
 * Set CALLOFSTATS_API_KEY to use this instead of (or alongside) the paced
 * HTML source. When the key is missing, every function throws NOT_CONFIGURED
 * so callers can fall back to HTML scraping.
 */

const BASE = process.env.CALLOFSTATS_BASE_URL || 'https://callofstats.com';

function apiKey() {
  const key = String(process.env.CALLOFSTATS_API_KEY || '').trim();
  if (!key) {
    const err = new Error('CALLOFSTATS_API_KEY is not set');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return key;
}

/**
 * Scan one server for one date (normal scan, 2 Dracoin).
 *
 * @param {number|string} serverNumber
 * @param {{ selectedDate?: string, minimumPower?: number }} options
 * @returns {Promise<import('./types').ApiScanResponse>}
 */
async function scanServer(serverNumber, { selectedDate, minimumPower = 0 } = {}) {
  const url = new URL(`/api/v1/scan/server/${serverNumber}`, BASE);
  url.searchParams.set('minimum_power', String(minimumPower));
  if (selectedDate) url.searchParams.set('selected_date', selectedDate);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });

  if (!res.ok) {
    const err = new Error(`CallOfStats API scan failed: HTTP ${res.status}`);
    err.code = 'API_ERROR';
    err.status = res.status;
    try {
      const body = await res.json();
      if (body.dracoin_charged != null) err.dracoinCharged = body.dracoin_charged;
      if (body.new_balance != null) err.newBalance = body.new_balance;
      if (body.already_bought != null) err.alreadyBought = body.already_bought;
    } catch {
      // Non-JSON error body; nothing more to extract.
    }
    throw err;
  }

  return res.json();
}

/**
 * Extract player IDs (lord_id) from a normal scan response, newest date first.
 *
 * The `main` array carries the current roster; each entry's `lord_id` is the
 * player id used on /lord/{id} pages.
 */
function playerIdsFromScan(response) {
  return (response.main || [])
    .map((p) => (p.lord_id == null ? null : String(p.lord_id)))
    .filter(Boolean);
}

module.exports = { scanServer, playerIdsFromScan, apiKey, BASE };
