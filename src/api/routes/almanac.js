const express = require('express');
const crypto = require('crypto');
const { CONFIG } = require('../../config');
const { getGuild } = require('../../sheets');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const SNOWFLAKE = /^\d{17,20}$/;

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Channel history is the most sensitive data the bot can serve, so this route
 * is closed by default: without ALMANAC_SECRET it refuses every request rather
 * than falling open.
 */
function requireSecret(req, res, next) {
  const expected = CONFIG.APP.ALMANAC_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'Almanac is not configured' });
  }
  if (!safeEqual(req.get('x-almanac-secret') || '', expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function canRead(channel, guild) {
  const me = guild.members?.me;
  if (!me) return true;
  const perms = me.permissionsIn(channel);
  return perms.has('ViewChannel') && perms.has('ReadMessageHistory');
}

/**
 * `Guild#isReady()` no longer exists in discord.js 14.27, so readiness is
 * inferred from a usable channels manager instead.
 */
function resolveGuild(res) {
  const guild = getGuild();
  if (!guild || !guild.channels) {
    res.status(503).json({ error: 'Bot is not ready' });
    return null;
  }
  return guild;
}

function serializeMessage(message) {
  const author = message.author;
  return {
    id: message.id,
    content: message.content || '',
    createdAt: message.createdAt,
    pinned: Boolean(message.pinned),
    author: {
      id: author?.id || null,
      username: author?.username || 'unknown',
      displayName: author?.displayName || author?.globalName || author?.username || 'unknown',
      avatar: author?.displayAvatarURL?.() || null,
      bot: Boolean(author?.bot),
    },
    attachments: [...message.attachments.values()].map((a) => ({
      name: a.name,
      url: a.url,
      size: a.size,
    })),
    embeds: message.embeds.map((e) => ({
      title: e.title || null,
      description: e.description || null,
      url: e.url || null,
      image: e.image?.url || null,
    })),
  };
}

function almanacRouter() {
  const router = express.Router();

  router.use(requireSecret);

  router.get(
    '/channels',
    asyncHandler(async (req, res) => {
      const guild = resolveGuild(res);
      if (!guild) return;

      const fetched = await guild.channels.fetch();
      const channels = [...fetched.values()]
        .filter((c) => c && c.isTextBased() && !c.isThread() && c.type !== 'GUILD_CATEGORY')
        .filter((c) => canRead(c, guild))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          topic: c.topic || null,
          parentId: c.parentId || null,
          parentName: c.parentId ? fetched.get(c.parentId)?.name || null : null,
          nsfw: Boolean(c.nsfw),
        }));

      res.json({ channels, guildName: guild.name });
    }),
  );

  router.get(
    '/channels/heads',
    asyncHandler(async (req, res) => {
      const guild = resolveGuild(res);
      if (!guild) return;

      const fetched = await guild.channels.fetch();
      const readable = [...fetched.values()].filter(
        (c) => c && c.isTextBased() && !c.isThread() && c.type !== 'GUILD_CATEGORY' && canRead(c, guild),
      );

      // One minimal message per channel: enough to detect change without
      // re-reading history. Failures are reported per channel, not fatal.
      const pairs = await Promise.all(
        readable.map(async (c) => {
          try {
            const msgs = await c.messages.fetch({ limit: 1 });
            const latest = [...msgs.values()][0];
            return [
              c.id,
              latest
                ? {
                    id: latest.id,
                    createdAt: latest.createdAt,
                    author: latest.author?.displayName || latest.author?.username || null,
                  }
                : null,
            ];
          } catch {
            return [c.id, null];
          }
        }),
      );

      res.json({ heads: Object.fromEntries(pairs) });
    }),
  );

  router.get(
    '/channels/:id/messages',
    asyncHandler(async (req, res) => {
      const guild = resolveGuild(res);
      if (!guild) return;

      const { id } = req.params;
      const channel =
        guild.channels.cache.get(id) || (await guild.channels.fetch(id).catch(() => null));
      if (!channel || !channel.isTextBased()) {
        return res.status(404).json({ error: 'Channel not found' });
      }
      if (!canRead(channel, guild)) {
        return res.status(403).json({ error: 'Bot cannot read this channel' });
      }

      const limit = Math.min(
        Math.max(Number.parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1),
        MAX_LIMIT,
      );
      const before = SNOWFLAKE.test(String(req.query.before || '')) ? req.query.before : undefined;
      const after = SNOWFLAKE.test(String(req.query.after || '')) ? req.query.after : undefined;

      const fetched = await channel.messages.fetch({ limit, before, after });
      const messages = [...fetched.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(serializeMessage);

      res.json({ messages, channelName: channel.name });
    }),
  );

  return router;
}

module.exports = almanacRouter;