const { Router } = require('express');
const prisma = require('../../db');
const { CONFIG } = require('../../config');
const { postEventMessage } = require('../../bot/events/posting');
const { syncEventUpdate, cancelEventDiscord, deleteEventDiscord } = require('../../bot/events/event-actions');
const { createScheduledEvent } = require('../../bot/events/scheduled');

const VALID_STATUS = ['SCHEDULED', 'ACTIVE', 'CANCELLED', 'COMPLETED'];
const VALID_ENTITY_TYPES = ['EXTERNAL', 'VOICE', 'STAGE_INSTANCE'];

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function validateEventPayload(body, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      errors.push('title is required');
    } else if (body.title.trim().length > 100) {
      errors.push('title must be 100 characters or fewer');
    } else {
      data.title = body.title.trim();
    }
  }

  if (!partial || body.description !== undefined) {
    if (body.description !== null && body.description !== undefined) {
      if (typeof body.description !== 'string') errors.push('description must be a string');
      else data.description = body.description.trim() || null;
    }
  }

  if (!partial || body.startTime !== undefined) {
    const startTs = Date.parse(body.startTime);
    if (!Number.isFinite(startTs)) {
      errors.push('startTime must be a valid date string');
    } else {
      data.startTime = new Date(startTs);
    }
  }

  if (!partial || body.endTime !== undefined) {
    if (body.endTime === null || body.endTime === undefined) {
      if (!partial) errors.push('endTime is required');
    } else {
      const endTs = Date.parse(body.endTime);
      if (!Number.isFinite(endTs)) errors.push('endTime must be a valid date string');
      else data.endTime = new Date(endTs);
    }
  }

  if (!partial || body.location !== undefined) {
    if (body.location === null || body.location === undefined) {
      data.location = null;
    } else if (typeof body.location !== 'string') {
      errors.push('location must be a string');
    } else {
      data.location = body.location.trim() || null;
    }
  }

  if (!partial || body.entityType !== undefined) {
    const entityType = (body.entityType || 'EXTERNAL').toUpperCase();
    if (!VALID_ENTITY_TYPES.includes(entityType)) {
      errors.push(`entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}`);
    } else {
      data.entityType = entityType;
    }
  }

  if (!partial || body.channelId !== undefined) {
    if (body.channelId === null || body.channelId === undefined) {
      if (data.entityType && data.entityType !== 'EXTERNAL' && !partial) {
        errors.push('channelId is required for voice/stage events');
      } else if (!partial) {
        data.channelId = null;
      }
    } else if (typeof body.channelId !== 'string') {
      errors.push('channelId must be a string');
    } else {
      data.channelId = body.channelId;
    }
  }

  if (data.startTime && data.endTime && data.endTime <= data.startTime) {
    errors.push('endTime must be after startTime');
  }

  return { errors, data };
}

async function waitForClient(context, timeoutMs = 15_000) {
  const start = Date.now();
  while (!context.client.isReady()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Discord client is not ready');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return context.client;
}

function createEventsRouter(context) {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { status, upcoming } = req.query;
    const where = {
      guildId: CONFIG.DISCORD.GUILD_ID,
    };
    if (status) {
      const list = String(status).split(',').map((s) => s.toUpperCase());
      if (list.some((s) => !VALID_STATUS.includes(s))) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUS.join(', ')}` });
      }
      where.status = { in: list };
    }
    if (upcoming === 'true') {
      where.startTime = { gte: new Date() };
    }
    const events = await prisma.event.findMany({
      where,
      orderBy: { startTime: 'asc' },
    });
    res.json({ events });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json({ event });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const { errors, data } = validateEventPayload(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('. ') });

    data.guildId = CONFIG.DISCORD.GUILD_ID;
    data.status = 'SCHEDULED';

    const event = await prisma.event.create({ data });

    let discordMessageId = null;
    let discordEventId = null;

    try {
      const client = await waitForClient(context);
      const message = await postEventMessage(client, event);
      discordMessageId = message ? message.id : null;
    } catch (err) {
      console.error('[API] Failed to post Discord message:', err.message);
    }

    try {
      const client = await waitForClient(context);
      const guild = await client.guilds.fetch(CONFIG.DISCORD.GUILD_ID);
      const scheduledEvent = await createScheduledEvent(guild, event);
      discordEventId = scheduledEvent.id;
    } catch (err) {
      console.error('[API] Failed to create Discord scheduled event:', err.message);
    }

    const saved = await prisma.event.update({
      where: { id: event.id },
      data: { discordMessageId, discordEventId },
    });

    res.status(201).json({ event: saved });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const existing = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    const { errors, data } = validateEventPayload(req.body, { partial: true });
    if (errors.length > 0) return res.status(400).json({ error: errors.join('. ') });

    if (data.startTime || data.endTime) {
      const finalStart = data.startTime || existing.startTime;
      const finalEnd = data.endTime || existing.endTime;
      if (finalEnd && finalEnd <= finalStart) {
        return res.status(400).json({ error: 'endTime must be after startTime' });
      }
    }

    const updated = await prisma.event.update({
      where: { id: existing.id },
      data,
    });

    try {
      const client = await waitForClient(context);
      await syncEventUpdate(client, updated, { previousStartTime: existing.startTime });
    } catch (err) {
      console.error('[API] Failed to sync event update:', err.message);
    }

    res.json({ event: updated });
  }));

  router.patch('/:id/cancel', asyncHandler(async (req, res) => {
    const existing = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Event not found' });
    if (existing.status === 'CANCELLED') {
      return res.json({ event: existing, cancelled: true });
    }

    const updated = await prisma.event.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED' },
    });

    try {
      const client = await waitForClient(context);
      await cancelEventDiscord(client, updated);
    } catch (err) {
      console.error('[API] Failed to cancel Discord side:', err.message);
    }

    res.json({ event: updated, cancelled: true });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const existing = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    try {
      const client = await waitForClient(context);
      await deleteEventDiscord(client, existing);
    } catch (err) {
      console.error('[API] Failed to delete event:', err.message);
    }

    res.json({ deleted: true });
  }));

  return router;
}

module.exports = createEventsRouter;
module.exports.validateEventPayload = validateEventPayload;