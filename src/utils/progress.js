/**
 * Per-item progress lines for long loops (scraping, enrichment).
 *
 * The same stream feeds a terminal and the web panel, so every line is a whole
 * line that ends with a newline. A bar that rewrites itself with `\r` is
 * invisible in a captured log and leaves half-written lines in a file, so the
 * bar is printed as its own periodic line instead.
 *
 *   const progress = createProgress({ total: 302, tag: 'ENRICH' });
 *   progress.item({ index: 12, id: '25632604', name: 'The Priestess', status: 'done', ms: 4200 });
 *   progress.bar();
 */

const ITEM_BAR_WIDTH = 20;
const WIDE_BAR_WIDTH = 40;
const WIDE_EVERY = 25;

const MARKS = {
  done: '✓',
  skipped: '↷',
  error: '✗',
  info: '·',
};

function bar(ratio, width) {
  const safe = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const filled = Math.round(safe * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function duration(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

function eta(rate, remaining) {
  if (!Number.isFinite(rate) || rate <= 0) return '?';
  const seconds = Math.round(remaining / rate);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * @param {{ total?: number, tag?: string, wideEvery?: number }} options
 */
function createProgress({ total = null, tag = null, wideEvery = WIDE_EVERY } = {}) {
  const started = Date.now();
  const prefix = tag ? `[${tag}]` : '';
  const digits = String(total || 1).length;
  let done = 0;
  let errors = 0;
  let lastBar = 0;

  function wide() {
    const elapsed = (Date.now() - started) / 1000;
    const rate = elapsed > 0 ? done / elapsed : 0;
    const ratio = total ? done / total : 0;
    const pct = total ? Math.round(ratio * 100) : 0;
    const parts = [
      `${prefix} ${bar(ratio, WIDE_BAR_WIDTH)}`,
      `${done}/${total ?? '?'}`,
      `${pct}%`,
      `${rate.toFixed(1)}/s`,
    ];
    if (total) parts.push(`ETA ${eta(rate, Math.max(0, total - done))}`);
    if (errors) parts.push(`${errors} error(s)`);
    console.log(parts.join(' · '));
  }

  /**
   * One line for one item. `count: false` prints an in-flight line (for
   * example "fetching lord page…") without advancing the counter.
   */
  function item({ index = null, id = null, name = null, status = 'info', detail = null, ms = null, count = true }) {
    if (count) done += 1;
    if (status === 'error') errors += 1;
    const n = index === null ? done : index;
    const ratio = total ? n / total : 0;
    const pct = total ? `${Math.round(ratio * 100)}%`.padStart(4) : '   -';
    const parts = [
      `${prefix} [${String(n).padStart(digits)}/${total ?? '?'}]`,
      bar(ratio, ITEM_BAR_WIDTH),
      pct,
      MARKS[status] || MARKS.info,
      id === null ? '' : String(id),
      name ? `· ${name}` : '',
      detail ? `· ${detail}` : '',
      ms === null || ms === undefined ? '' : `· ${duration(ms)}`,
    ];
    console.log(parts.filter((part) => part !== '').join(' '));
    if (total && n - lastBar >= wideEvery) {
      lastBar = n;
      wide();
    }
  }

  return {
    item,
    bar: wide,
    get done() {
      return done;
    },
    get errors() {
      return errors;
    },
  };
}

module.exports = { createProgress, bar, duration, eta };
