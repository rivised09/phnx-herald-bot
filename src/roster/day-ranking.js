/**
 * The weekday activity ranking across the whole stored history.
 *
 * Every published summary already carries its window's per-day counts
 * (`timeline[].activePlayers`), and a date's count is the same whichever
 * window reads it - it compares that day with the previous usable snapshot, not
 * with the window's start. Collecting them across every summary therefore
 * yields one series for the entire history without re-reading the raw player
 * files, which is what the Overview's "most active day" card is built from.
 *
 * The ranking is by average active lords per weekday, so a weekday that appears
 * more often in the history cannot outrank a busier one just by being counted
 * more times.
 */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayOf(date) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/** How many player files to sample, and how many must cover a date. */
const COVERAGE_SAMPLE = 12;
const COVERAGE_MIN = 0.8;

/**
 * The oldest date the stored player histories actually cover.
 *
 * The Aug-Sep history predates the per-player metric records: its summaries can
 * count a window but there is nothing to compare, so those days read as zero.
 * Averaging them in would drown the real pattern (~200 lords a day) in dates
 * that were never measured, so the ranking starts where the history does. The
 * answer is found by sampling player files rather than trusting a hardcoded
 * date, and only the unbroken covered run up to the newest day is kept - one
 * hole after the start would put a fake zero in the middle of the average.
 */
async function historyCoverage(store) {
  if (typeof store.list !== 'function') return null;
  const keys = await store.list('players/');
  if (!keys?.length) return null;
  const step = Math.max(1, Math.floor(keys.length / COVERAGE_SAMPLE));
  const sample = keys.filter((_, index) => index % step === 0).slice(0, COVERAGE_SAMPLE);
  const files = [];
  for (const key of sample) {
    const doc = await store.get(key).catch(() => null);
    if (doc?.metrics && Object.keys(doc.metrics).length) files.push(doc);
  }
  if (!files.length) return null;

  const spans = files.map((file) => {
    const dates = Object.keys(file.metrics).sort();
    return { file, first: dates[0], last: dates[dates.length - 1] };
  });
  const dates = [...new Set(spans.flatMap((span) => Object.keys(span.file.metrics)))].sort();

  let start = null;
  for (const date of dates) {
    // Only files whose history spans the date can speak for it: a lord who
    // joined later or stopped playing earlier must not count as a gap.
    const eligible = spans.filter((span) => span.first <= date && span.last >= date);
    if (!eligible.length) {
      start = null;
      continue;
    }
    const covered = eligible.filter((span) => span.file.metrics[date]).length;
    start = covered / eligible.length >= COVERAGE_MIN ? start || date : null;
  }
  return start;
}

async function buildDayRanking(store) {
  const index = await store.get('index.json');
  const dates = Array.isArray(index?.dates) ? index.dates : [];
  const coverageStart = await historyCoverage(store);

  // date -> active lords. Later windows overwrite earlier ones with the same
  // number; a summary that could not be read simply contributes nothing.
  const perDate = new Map();
  let summaries = 0;

  for (const date of dates) {
    const summary = await store.get(`leadership/${date}.json`).catch(() => null);
    if (!summary || !Array.isArray(summary.timeline)) continue;
    summaries += 1;
    for (const point of summary.timeline) {
      if (!point || !point.date) continue;
      if (point.activePlayers === null || point.activePlayers === undefined) continue;
      perDate.set(point.date, point.activePlayers);
    }
  }

  const days = [...perDate.entries()]
    .filter(([date]) => !coverageStart || date >= coverageStart)
    .map(([date, activePlayers]) => ({ date, activePlayers, weekday: weekdayOf(date) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const buckets = WEEKDAYS.map((label, weekday) => ({ weekday, label, days: 0, total: 0 }));
  for (const day of days) {
    const bucket = buckets[day.weekday];
    if (!bucket) continue;
    bucket.days += 1;
    bucket.total += day.activePlayers;
  }

  const weekdays = buckets
    .filter((bucket) => bucket.days > 0)
    .map((bucket) => ({
      weekday: bucket.weekday,
      label: bucket.label,
      days: bucket.days,
      totalActivePlayers: bucket.total,
      averageActivePlayers: Math.round((bucket.total / bucket.days) * 10) / 10,
    }))
    .sort(
      (a, b) => b.averageActivePlayers - a.averageActivePlayers || b.days - a.days,
    );

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    dayCount: days.length,
    summaries,
    coverageStart,
    firstDate: days[0]?.date || null,
    lastDate: days[days.length - 1]?.date || null,
    weekdays,
    // The ranking the Overview card shows: the busiest measured dates, newest
    // of the ties first so an equal count does not look arbitrary.
    topDays: [...days]
      .sort((a, b) => b.activePlayers - a.activePlayers || b.date.localeCompare(a.date))
      .slice(0, 10)
      .map((day) => ({ ...day, label: WEEKDAYS[day.weekday] })),
    // The same ranking over the newest seven measured days, so the card can
    // answer "busiest day this week" as well as "busiest day ever" - the two
    // disagree whenever the kingdom is on a run.
    recent: buildRecent(days),
    days,
  };
}

function buildRecent(days, length = 7) {
  const recent = days.slice(-length);
  return {
    dayCount: recent.length,
    firstDate: recent[0]?.date || null,
    lastDate: recent[recent.length - 1]?.date || null,
    topDays: [...recent]
      .sort((a, b) => b.activePlayers - a.activePlayers || b.date.localeCompare(a.date))
      .slice(0, 10)
      .map((day) => ({ ...day, label: WEEKDAYS[day.weekday] })),
  };
}

/**
 * Writes `leadership/days.json` next to the summaries it was derived from.
 *
 * `no-store` because the file changes with every rebuild and is tiny; the web
 * version-tags its read with the same publish stamp as the other summaries.
 */
async function writeDayRanking(store) {
  const ranking = await buildDayRanking(store);
  await store.put('leadership/days.json', ranking, { cacheControl: 'no-store' });
  return ranking;
}

module.exports = { buildDayRanking, writeDayRanking, WEEKDAYS };
