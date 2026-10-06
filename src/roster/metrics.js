const prisma = require('../db');

/**
 * Storage for the ~350 label/value fields the source exposes per snapshot.
 *
 * Values arrive as rendered strings ("56,921", "33.33%", "985,968 Sec",
 * "Silver III >=1600"). Each is kept verbatim in valueText so nothing is lost
 * when a field is not a number, and additionally parsed into valueNumber when
 * it cleanly is one - which makes totals and averages queryable without
 * re-parsing text later.
 *
 * SUBJECT TYPES: SERVER | ALLIANCE | LORD
 */

const SUBJECT = Object.freeze({ SERVER: 'SERVER', ALLIANCE: 'ALLIANCE', LORD: 'LORD' });

/**
 * A value is treated as numeric only when the entire string is a number with
 * an optional trailing unit. Anything else is stored as text alone rather than
 * partially parsed: reading 1600 out of "Silver III >=1600", or 3 out of
 * "S3-2638 | Season 3", would quietly invent facts that are not there.
 *
 * K/M/B/T are deliberately absent from the units: "1B" would become the number
 * 1, and a later SUM over the column would silently under-report by 999,999,999.
 * Unambiguous units only.
 */
const NUMERIC = /^([+-]?[\d,]+(?:\.\d+)?)\s*(%|Sec|secs?|seconds?|days?|d)?$/;

function parseMetricValue(raw) {
  if (raw === null || raw === undefined) {
    return { valueText: null, valueNumber: null, unit: null };
  }
  const text = String(raw).trim();
  if (!text) return { valueText: null, valueNumber: null, unit: null };

  const match = text.match(NUMERIC);
  if (match) {
    const number = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(number)) {
      return { valueText: text, valueNumber: number, unit: match[2] || null };
    }
  }
  return { valueText: text, valueNumber: null, unit: null };
}

/** `[{ section, label, value }]` -> rows ready for createMany. */
function toMetricRows(rows) {
  return (rows || [])
    .filter((row) => row && row.label)
    .map((row) => {
      const parsed = parseMetricValue(row.value);
      return {
        subjectType: row.subjectType,
        subjectId: row.subjectId || '',
        section: row.section || '',
        label: String(row.label).trim().slice(0, 160),
        ...parsed,
      };
    });
}

/**
 * Replaces every metric held for one subject on one snapshot.
 *
 * Delete-then-insert rather than per-row upsert: a source page renders a
 * fixed set of labels, so any label that disappeared must stop being stored,
 * and a blind upsert would leave it behind forever.
 */
async function saveSubjectMetrics(snapshotId, subjectType, subjectId, rows) {
  // subjectType/subjectId come from the call, not from each row: the caller is
  // the one that knows which subject the whole batch belongs to.
  const data = toMetricRows(rows).map((row) => ({
    ...row,
    snapshotId,
    subjectType,
    subjectId: subjectId || '',
  }));
  // Two statements, but two round trips: the same Supabase latency that makes
  // a snapshot write need a longer budget applies here, and a subject that
  // loses its transaction mid-run would abort the whole detail pass.
  const options = { maxWait: 15000, timeout: 60000 };
  await prisma.$transaction(async (tx) => {
    await tx.snapshotMetric.deleteMany({
      where: { snapshotId, subjectType, subjectId: subjectId || '' },
    });
    if (data.length) {
      await tx.snapshotMetric.createMany({ data });
    }
  }, options);
  return data.length;
}

/** Same, for many subjects at once - used when a whole page is written back. */
async function saveMetricsBatch(snapshotId, subjects) {
  let written = 0;
  for (const subject of subjects) {
    written += await saveSubjectMetrics(
      snapshotId,
      subject.subjectType,
      subject.subjectId,
      subject.rows,
    );
  }
  return written;
}

/**
 * Replaces one player's achievement list for one snapshot.
 *
 * progress/target are BigInt because the goals reach 500,000,000, and
 * completedText is kept alongside parsed fields because the source expresses
 * completion as either a date or the phrase "Not Completed (N)".
 */
async function saveAchievements(lordSnapshotId, rows) {
  const data = (rows || [])
    .filter((row) => row && row.name)
    .map((row) => ({
      lordSnapshotId,
      name: String(row.name).trim().slice(0, 160),
      progress: toBigInt(row.progress),
      target: toBigInt(row.target),
      completedText: row.completedText || null,
      completedAt: row.completedAt || null,
    }));

  await prisma.$transaction(async (tx) => {
    await tx.lordAchievement.deleteMany({ where: { lordSnapshotId } });
    if (data.length) await tx.lordAchievement.createMany({ data });
  }, { maxWait: 15000, timeout: 60000 });
  return data.length;
}

function toBigInt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  const digits = String(value).replace(/[^\d]/g, '');
  if (!digits) return null;
  try {
    return BigInt(digits);
  } catch {
    return null;
  }
}

const NOT_COMPLETED = /^Not Completed\s*\(([\d,]+)\)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads the "Time Completed" cell of an achievement.
 *
 * The source renders it as either "Not Completed (50,000,000)" - which carries
 * the goal in the parentheses - or as a completion date. Keeping both forms
 * apart means an unfinished achievement still records what it is aiming at.
 */
function parseAchievementCompletion(text) {
  const raw = text === null || text === undefined ? '' : String(text).trim();
  if (!raw) return { target: null, completedAt: null, completedText: null };

  const notCompleted = raw.match(NOT_COMPLETED);
  if (notCompleted) {
    return { target: toBigInt(notCompleted[1]), completedAt: null, completedText: raw };
  }
  if (ISO_DATE.test(raw)) {
    return { target: null, completedAt: new Date(`${raw}T00:00:00.000Z`), completedText: raw };
  }
  return { target: null, completedAt: null, completedText: raw };
}

/** Records every name seen for a player; already-known names are left alone. */
async function saveNameHistory(lordId, names) {
  const unique = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))];
  if (!unique.length) return 0;
  await prisma.lordNameHistory.createMany({
    data: unique.map((name) => ({ lordId, name })),
    skipDuplicates: true,
  });
  return unique.length;
}

/** Reads a subject's metrics back, grouped by section, for verification/UI. */
async function readSubjectMetrics(snapshotId, subjectType, subjectId) {
  const rows = await prisma.snapshotMetric.findMany({
    where: { snapshotId, subjectType, subjectId: subjectId || '' },
    orderBy: [{ section: 'asc' }, { label: 'asc' }],
  });

  const grouped = new Map();
  rows.forEach((row) => {
    const key = row.section || '';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      label: row.label,
      text: row.valueText,
      number: row.valueNumber,
      unit: row.unit,
    });
  });
  return Object.fromEntries(grouped);
}

module.exports = {
  SUBJECT,
  parseMetricValue,
  parseAchievementCompletion,
  toMetricRows,
  saveSubjectMetrics,
  saveMetricsBatch,
  saveAchievements,
  saveNameHistory,
  readSubjectMetrics,
};
