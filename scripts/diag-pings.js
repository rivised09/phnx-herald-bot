/**
 * Read-only dump of ping-related event state, used to diagnose the reminder
 * spam: duplicate rows, stuck flags, ended events still marked SCHEDULED.
 *
 *   node scripts/diag-pings.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const url = process.env.DATABASE_URL || '';
console.log('DATABASE_URL host:', url.replace(/:[^:@/]+@/, ':****@'));

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT id, title, status,
           start_time, end_time,
           ping_seven_hours AS p7, ping_one_hour AS p1,
           ping_thirty_min AS p30, ping_ten_min AS p10, ping_started AS ps,
           discord_message_id, reminder_message_id, updated_at, created_at
    FROM events
    ORDER BY created_at DESC
    LIMIT 8
  `);
  console.log(`\nnewest events:`);
  for (const r of rows) {
    console.log(JSON.stringify({
      title: r.title,
      status: r.status,
      start: r.start_time,
      end: r.end_time,
      flags: { p7: r.p7, p1: r.p1, p30: r.p30, p10: r.p10, ps: r.ps },
      reminderMsg: Boolean(r.reminder_message_id),
      created: r.created_at,
      updated: r.updated_at,
    }));
  }

  const stuck = await prisma.$queryRawUnsafe(`
    SELECT title, status, end_time
    FROM events
    WHERE status IN ('SCHEDULED','ACTIVE') AND end_time < NOW()
    ORDER BY end_time DESC
    LIMIT 10
  `);
  console.log('\nended but still SCHEDULED/ACTIVE:', JSON.stringify(stuck));

  const byStatus = await prisma.event.groupBy({ by: ['status'], _count: true });
  console.log('by status:', JSON.stringify(byStatus));
}

main()
  .catch((err) => {
    console.error('ERR', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
