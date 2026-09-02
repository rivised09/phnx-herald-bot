const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const prisma = require('../../db');
const { CONFIG, dashboardUrl } = require('../../config');
const { buildEventListEmbed, isUpcoming, sortByStart } = require('../commands/helpers');
const { isLeadershipUser } = require('../../utils/role-check');
const { formatUtcDateTime, formatUtcInput, parseUtcInput } = require('../../utils/time');
const { syncEventUpdate, cancelEventDiscord, deleteEventDiscord } = require('../events/event-actions');
const { updateEventMessage, sendNotification } = require('../events/posting');

const EPHEMERAL_FLAG = 64;
const MAX_SELECT_OPTIONS = 25;

function dashboardButton() {
  return new ButtonBuilder()
    .setStyle(ButtonStyle.Secondary)
    .setLabel('🌐 Open Dashboard')
    .setCustomId('phnx_dashboard_open');
}

function allEventsButton() {
  return new ButtonBuilder()
    .setStyle(ButtonStyle.Primary)
    .setLabel('📋 All Events')
    .setCustomId('phnx_show_all');
}

function idAfter(customId, prefix) {
  return customId.slice(prefix.length);
}

function afterColon(customId) {
  return customId.slice(customId.indexOf(':') + 1);
}

function denyUnauthorized(interaction) {
  return interaction.reply({
    content: '⛔ Only authorized leadership members can do this.',
    flags: EPHEMERAL_FLAG,
  });
}

function eventActionButtons(event) {
  const row = new ActionRowBuilder();

  row.addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Primary)
      .setLabel('✏️ Edit')
      .setCustomId(`phnx_edit:${event.id}`),
  );

  if (event.status !== 'CANCELLED' && event.status !== 'COMPLETED') {
    row.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Danger)
        .setLabel('🚫 Cancel')
        .setCustomId(`phnx_cancel:${event.id}`),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Danger)
      .setLabel('🗑️ Delete')
      .setCustomId(`phnx_delete:${event.id}`),
  );

  return row;
}

function confirmationRow(confirmId, confirmLabel) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel(confirmLabel).setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`phnx_confirm_no:${afterColon(confirmId)}`)
      .setLabel('✖️ No')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function handleAllEvents(interaction) {
  const events = await prisma.event.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ACTIVE'] },
      guildId: interaction.guildId || undefined,
    },
    orderBy: { startTime: 'asc' },
  });

  const sorted = sortByStart(events);
  const upcoming = sorted.filter(isUpcoming);

  const embed = buildEventListEmbed(upcoming, {
    title: '📋 All Upcoming Events',
    description: upcoming.length > 0 ? `Showing ${upcoming.length} upcoming event(s)` : 'No upcoming events.',
  });

  const row = new ActionRowBuilder().addComponents(dashboardButton());
  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleDashboardOpen(interaction) {
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const link = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel('📋 Open Dashboard')
    .setURL(dashboardUrl());

  const row = new ActionRowBuilder().addComponents(link);
  await interaction.reply({
    content: '✅ Dashboard access granted. Click the button to open it in your browser:',
    components: [row],
    flags: EPHEMERAL_FLAG,
  });
}

async function handleManageEvents(interaction) {
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const events = await prisma.event.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ACTIVE'] },
      guildId: interaction.guildId || undefined,
    },
    orderBy: { startTime: 'asc' },
  });

  if (events.length === 0) {
    await interaction.reply({ content: '🎉 No events to manage right now.', flags: EPHEMERAL_FLAG });
    return;
  }

  const list = events.slice(0, MAX_SELECT_OPTIONS);
  const select = new StringSelectMenuBuilder()
    .setCustomId('phnx_pick_event')
    .setPlaceholder(
      events.length > MAX_SELECT_OPTIONS
        ? `Select an event (showing first ${MAX_SELECT_OPTIONS} of ${events.length})`
        : 'Select an event to manage',
    )
    .addOptions(
      list.map((e) => ({
        label: e.title.length > 100 ? `${e.title.slice(0, 97)}...` : e.title,
        value: e.id,
        description: `${formatUtcDateTime(e.startTime)} · ${e.status}`,
      })),
    );

  const row = new ActionRowBuilder().addComponents(select);
  await interaction.reply({ content: '🛠️ Pick an event to manage:', components: [row], flags: EPHEMERAL_FLAG });
}

async function handleEventSelected(interaction) {
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const eventId = interaction.values?.[0];
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    await interaction.reply({ content: '⚠️ This event no longer exists.', flags: EPHEMERAL_FLAG });
    return;
  }

  const timeLabel = event.endTime
    ? `${formatUtcDateTime(event.startTime)} → ${formatUtcDateTime(event.endTime)}`
    : formatUtcDateTime(event.startTime);

  await interaction.update({
    content: `🛠️ **${event.title}**\n${timeLabel} · _${event.status}_\n\nChoose an action below:`,
    components: [eventActionButtons(event)],
  });
}

async function handleCancelEvent(interaction) {
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const eventId = idAfter(interaction.customId, 'phnx_cancel:');
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    await interaction.reply({ content: '⚠️ This event no longer exists.', flags: EPHEMERAL_FLAG });
    return;
  }

  const row = confirmationRow(`phnx_confirm_cancel:${event.id}`, '✅ Yes, cancel it');
  await interaction.reply({
    content: `⚠️ Are you sure you want to **cancel** "${event.title}"?\n${formatUtcDateTime(event.startTime)}`,
    components: [row],
    flags: EPHEMERAL_FLAG,
  });
}

async function handleConfirmCancel(interaction) {
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const eventId = idAfter(interaction.customId, 'phnx_confirm_cancel:');
  await interaction.deferUpdate();

  try {
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      await interaction.editReply({ content: '⚠️ This event no longer exists.', components: [] });
      return;
    }
    if (event.status === 'CANCELLED') {
      await interaction.editReply({ content: 'ℹ️ This event is already cancelled.', components: [] });
      return;
    }

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: { status: 'CANCELLED' },
    });
    await cancelEventDiscord(interaction.client, updated);
    await interaction.editReply({ content: `❌ **"${updated.title}"** has been cancelled.`, components: [] });
  } catch (err) {
    console.error('[BUTTONS] Confirm cancel failed:', err.message);
    await interaction.editReply({ content: '⚠️ Failed to cancel the event.', components: [] }).catch(() => {});
  }
}

async function handleDeleteEvent(interaction) {
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const eventId = idAfter(interaction.customId, 'phnx_delete:');
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    await interaction.reply({ content: '⚠️ This event no longer exists.', flags: EPHEMERAL_FLAG });
    return;
  }

  const row = confirmationRow(`phnx_confirm_delete:${event.id}`, '✅ Yes, delete it');
  await interaction.reply({
    content: `⚠️ Are you sure you want to **delete** "${event.title}"? This permanently removes its announcement, scheduled event, and all records. This cannot be undone.`,
    components: [row],
    flags: EPHEMERAL_FLAG,
  });
}

async function handleConfirmDelete(interaction) {
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const eventId = idAfter(interaction.customId, 'phnx_confirm_delete:');
  await interaction.deferUpdate();

  try {
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      await interaction.editReply({ content: '⚠️ This event no longer exists or was already deleted.', components: [] });
      return;
    }

    const title = event.title;
    await deleteEventDiscord(interaction.client, event);
    await interaction.editReply({ content: `🗑️ **"${title}"** has been deleted.`, components: [] });
  } catch (err) {
    console.error('[BUTTONS] Confirm delete failed:', err.message);
    await interaction.editReply({ content: '⚠️ Failed to delete the event.', components: [] }).catch(() => {});
  }
}

async function handleConfirmNo(interaction) {
  await interaction.update({ content: '✖️ Action cancelled.', components: [] });
}

async function handleEditEvent(interaction) {
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const eventId = idAfter(interaction.customId, 'phnx_edit:');
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    await interaction.reply({ content: '⚠️ This event no longer exists.', flags: EPHEMERAL_FLAG });
    return;
  }

  const modal = new ModalBuilder().setCustomId(`phnx_edit_modal:${event.id}`).setTitle(`Edit: ${event.title}`);

  const titleInput = new TextInputBuilder()
    .setCustomId('phnx_m_title')
    .setLabel('Title')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(event.title)
    .setMaxLength(100);

  const startInput = new TextInputBuilder()
    .setCustomId('phnx_m_start')
    .setLabel('Start (UTC) · YYYY-MM-DD HH:mm')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(formatUtcInput(event.startTime));

  const endInput = new TextInputBuilder()
    .setCustomId('phnx_m_end')
    .setLabel('End (UTC) · YYYY-MM-DD HH:mm (optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(event.endTime ? formatUtcInput(event.endTime) : '');

  const locationInput = new TextInputBuilder()
    .setCustomId('phnx_m_location')
    .setLabel('Location (optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(event.location || '')
    .setMaxLength(100);

  const descriptionInput = new TextInputBuilder()
    .setCustomId('phnx_m_description')
    .setLabel('Description (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue(event.description || '')
    .setMaxLength(1000);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(endInput),
    new ActionRowBuilder().addComponents(locationInput),
    new ActionRowBuilder().addComponents(descriptionInput),
  );

  await interaction.showModal(modal);
}

async function handleCompleteSelect(interaction) {
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const eventId = interaction.values[0];
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    await interaction.update({ content: '⚠️ Event not found.', components: [] });
    return;
  }

  const row = confirmationRow(`phnx_confirm_complete:${event.id}`, '✅ Complete');
  await interaction.update({
    content: `Are you sure you want to mark **${event.title}** as completed?\n${formatUtcDateTime(event.startTime)}`,
    components: [row],
  });
}

async function handleConfirmComplete(interaction) {
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const eventId = idAfter(interaction.customId, 'phnx_confirm_complete:');
  await interaction.deferUpdate();

  try {
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      await interaction.editReply({ content: '⚠️ This event no longer exists.', components: [] });
      return;
    }
    if (event.status === 'COMPLETED') {
      await interaction.editReply({ content: 'ℹ️ This event is already completed.', components: [] });
      return;
    }

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: { status: 'COMPLETED' },
    });
    await updateEventMessage(interaction.client, updated);
    await sendNotification(
      interaction.client,
      updated,
      `@everyone ✅ **${updated.title}** has ended. Thanks everyone for attending!`
    );
    await interaction.editReply({ content: `✅ **"${updated.title}"** has been marked as completed.`, components: [] });
  } catch (err) {
    console.error('[BUTTONS] Confirm complete failed:', err.message);
    await interaction.editReply({ content: '⚠️ Failed to complete the event.', components: [] }).catch(() => {});
  }
}

async function handleModalSubmit(interaction) {
  if (!interaction.isModalSubmit()) return;

  const prefix = 'phnx_edit_modal:';
  if (!interaction.customId.startsWith(prefix)) {
    await interaction.reply({ content: 'Unknown modal.', flags: EPHEMERAL_FLAG });
    return;
  }
  if (!isLeadershipUser(interaction)) {
    await denyUnauthorized(interaction);
    return;
  }

  const eventId = idAfter(interaction.customId, prefix);
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    await interaction.reply({ content: '⚠️ This event no longer exists.', flags: EPHEMERAL_FLAG });
    return;
  }

  const fields = interaction.fields;
  const title = fields.getTextInputValue('phnx_m_title').trim();
  const startVal = fields.getTextInputValue('phnx_m_start').trim();
  const endVal = fields.getTextInputValue('phnx_m_end').trim();

  let error = null;
  if (!title) error = 'Title is required.';
  const startTime = startVal ? parseUtcInput(startVal) : null;
  if (!error && !startTime) error = 'Start time must be a valid UTC time in YYYY-MM-DD HH:mm format.';
  const endTime = endVal ? parseUtcInput(endVal) : null;
  if (!error && startTime && endTime && endTime <= startTime) error = 'End time must be after the start time.';

  if (error) {
    await interaction.reply({ content: `⚠️ ${error}`, flags: EPHEMERAL_FLAG });
    return;
  }

  await interaction.deferReply({ flags: EPHEMERAL_FLAG });

  try {
    const updated = await prisma.event.update({
      where: { id: event.id },
      data: {
        title,
        description: fields.getTextInputValue('phnx_m_description').trim() || null,
        location: fields.getTextInputValue('phnx_m_location').trim() || null,
        startTime,
        endTime,
      },
    });
    await syncEventUpdate(interaction.client, updated, { previousStartTime: event.startTime });
    await interaction.editReply(`✅ **"${updated.title}"** has been updated!`);
  } catch (err) {
    console.error('[MODAL] Edit failed:', err.message);
    await interaction.editReply('⚠️ Failed to update the event.').catch(() => {});
  }
}

async function handleButtonInteraction(interaction) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
  const { customId } = interaction;

  try {
    if (customId === 'phnx_show_all') {
      await handleAllEvents(interaction);
    } else if (customId === 'phnx_dashboard_open') {
      await handleDashboardOpen(interaction);
    } else if (customId === 'phnx_manage_events') {
      await handleManageEvents(interaction);
    } else if (customId === 'phnx_pick_event') {
      await handleEventSelected(interaction);
    } else if (customId.startsWith('phnx_cancel:')) {
      await handleCancelEvent(interaction);
    } else if (customId.startsWith('phnx_confirm_cancel:')) {
      await handleConfirmCancel(interaction);
    } else if (customId.startsWith('phnx_delete:')) {
      await handleDeleteEvent(interaction);
    } else if (customId.startsWith('phnx_confirm_delete:')) {
      await handleConfirmDelete(interaction);
    } else if (customId.startsWith('phnx_confirm_no:')) {
      await handleConfirmNo(interaction);
    } else if (customId.startsWith('phnx_edit:')) {
      await handleEditEvent(interaction);
    } else if (customId === 'phnx_complete_select') {
      await handleCompleteSelect(interaction);
    } else if (customId.startsWith('phnx_confirm_complete:')) {
      await handleConfirmComplete(interaction);
    } else {
      await interaction.reply({
        content: 'Unknown button.',
        flags: EPHEMERAL_FLAG,
      });
    }
  } catch (err) {
    console.error('[BUTTONS] Error handling button:', err.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: '⚠️ Something went wrong.', flags: EPHEMERAL_FLAG })
        .catch(() => {});
    }
  }
}

module.exports = { handleButtonInteraction, handleModalSubmit };