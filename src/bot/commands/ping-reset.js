const prisma = require('../../db');
const { CONFIG } = require('../../config');
const { isLeadershipUser } = require('../../utils/role-check');

const EPHEMERAL_FLAG = 64;

async function rearmStalePings() {
  const events = await prisma.event.findMany({
    where: { status: { in: ['SCHEDULED', 'ACTIVE'] } },
  });
  const now = Date.now();
  let armed = 0;

  for (const event of events) {
    const remainingMs = event.startTime.getTime() - now;
    const data = {};
    for (const windowInfo of CONFIG.BEHAVIOR.PING_WINDOWS) {
      if (event[windowInfo.key] && remainingMs > windowInfo.msBefore) {
        data[windowInfo.key] = false;
      }
    }
    if (Object.keys(data).length > 0) {
      await prisma.event.update({ where: { id: event.id }, data });
      armed += 1;
    }
  }

  return armed;
}

async function pingReset(interaction) {
  if (!isLeadershipUser(interaction)) {
    await interaction.reply({
      content: '⛔ You need leadership permissions to use this command.',
      flags: EPHEMERAL_FLAG,
    });
    return;
  }

  await interaction.deferReply({ flags: EPHEMERAL_FLAG });

  try {
    const armed = await rearmStalePings();
    await interaction.editReply(
      armed > 0
        ? `✅ Re-armed reminder pings for **${armed}** event${armed === 1 ? '' : 's'}. Pings will fire again at their next reminder window.`
        : '✅ No stale ping flags found — all reminders are already in sync.',
    );
  } catch (err) {
    console.error('[PING-RESET] Failed to rearm pings:', err.message);
    await interaction.editReply('⚠️ Failed to re-arm pings. Try again later.').catch(() => {});
  }
}

module.exports = { pingReset, rearmStalePings };