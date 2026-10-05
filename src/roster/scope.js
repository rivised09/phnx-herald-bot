/**
 * How much history a run is allowed to work through.
 *
 * The two halves of this project have deliberately different jobs:
 *
 *  - The deployed bot keeps the homepage current. It reads the roster the
 *    source is showing *now*, refreshes the detail rows that belong to that
 *    newest date, and stops. Anything more would mean walking the source for
 *    dates nobody is looking at, on a schedule, forever.
 *
 *  - The machine this runs on by hand does the history: every date the source
 *    still offers, scraped and injected into Supabase in one sitting.
 *
 * `ROSTER_HISTORY=1` opts the current process into the second job. It is off
 * by default so the deployed bot is the latest-only one without needing a
 * variable set on the host - the safe behaviour is the one that ships.
 */
function historyEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ROSTER_HISTORY || ''));
}

/** "latest" or "history" - recorded in run summaries so a log says which. */
function scopeLabel() {
  return historyEnabled() ? 'history' : 'latest';
}

module.exports = { historyEnabled, scopeLabel };
