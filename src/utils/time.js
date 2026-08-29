/**
 * Timezone and date formatting helpers.
 * All stored times are UTC; Discord renders relative timestamps per viewer.
 */

function toUnixSeconds(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function formatUtc(date) {
  const d = new Date(date);
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function formatDiscordRelative(date) {
  return `<t:${toUnixSeconds(date)}:R>`;
}

function formatDiscordDateTime(date) {
  return `<t:${toUnixSeconds(date)}:f>`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatUtcDateTime(date) {
  const d = new Date(date);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

function formatUtcInput(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function parseUtcInput(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const iso = trimmed.replace(' ', 'T');
  const fullIso = /\d{2}:\d{2}$/.test(iso) ? `${iso}:00.000Z` : `${iso}.000Z`;
  const ts = Date.parse(fullIso);
  return Number.isFinite(ts) ? new Date(ts) : null;
}

function isSameUtcDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}

function msUntil(date) {
  return new Date(date).getTime() - Date.now();
}

function formatDuration(start, end) {
  const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
  if (parts.length === 0) return 'Less than a minute';
  return parts.join(' ');
}

module.exports = {
  toUnixSeconds,
  formatUtc,
  formatDiscordRelative,
  formatDiscordDateTime,
  formatUtcDateTime,
  formatUtcInput,
  parseUtcInput,
  isSameUtcDay,
  msUntil,
  formatDuration,
};