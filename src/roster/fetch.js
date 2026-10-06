const { runSync } = require('./ingest');
const { runDetail, getDetailState } = require('./detail');

let state = {
  running: false,
  date: null,
  phase: 'idle',
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};

function validDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function getFetchState() {
  return {
    ...state,
    progress: state.phase === 'details' ? getDetailState() : null,
  };
}

function startTargetedFetch(date) {
  if (!validDate(date)) {
    const error = new Error('A valid snapshot date is required (YYYY-MM-DD).');
    error.code = 'INVALID_DATE';
    throw error;
  }
  if (state.running) return { accepted: false, state: getFetchState() };

  state = {
    running: true,
    date,
    phase: 'snapshot',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  };

  Promise.resolve().then(async () => {
    try {
      const snapshot = await runSync({ reason: 'targeted', targetDate: date });
      if (snapshot.error || snapshot.skipped) {
        throw new Error(snapshot.detail || snapshot.reason || 'The snapshot fetch could not start.');
      }
      state = { ...state, phase: 'details' };
      const details = await runDetail({ reason: 'targeted', targetDate: date });
      if (details.error) throw new Error(details.error);
      state = {
        ...state,
        running: false,
        phase: 'complete',
        finishedAt: new Date().toISOString(),
        result: { snapshot, details },
      };
    } catch (error) {
      state = {
        ...state,
        running: false,
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        error: error.message,
      };
    }
  });

  return { accepted: true, state: getFetchState() };
}

module.exports = { getFetchState, startTargetedFetch };
