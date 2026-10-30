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
 * Proxy an almanac request to the phoenix-translator bot, which has access to
 * channels phoenix-herald cannot read (e.g. leadership channels).
 */
async function proxyToTranslator(path, headers = {}) {
  const base = CONFIG.APP.TRANSLATOR_API_URL;
  if (!base) throw new Error('TRANSLATOR_API_URL is not configured');

  const url = `${base.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    headers: {
      'x-almanac-secret': headers['x-almanac-secret'] || '',
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

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
      const localChannels = [...fetched.values()]
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
          source: 'herald',
        }));

      // Channels phoenix-herald can't read but the translator can.
      let translatorChannels = [];
      try {
        if (CONFIG.APP.TRANSLATOR_API_URL) {
          const { status, body } = await proxyToTranslator(
            '/api/almanac/channels',
            { 'x-almanac-secret': req.get('x-almanac-secret') || '' },
          );
          if (status === 200 && body.channels) {
            translatorChannels = body.channels.map((c) => ({
              ...c,
              source: 'translator',
            }));
          }
        }
      } catch (err) {
        console.warn(`[ALMANAC] Translator proxy failed: ${err.message}`);
      }

      // Merge, preferring local data when both bots can see a channel.
      const byId = new Map();
      for (const c of translatorChannels) byId.set(c.id, c);
      for (const c of localChannels) byId.set(c.id, c);

      res.json({
        channels: [...byId.values()].sort(
          (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name),
        ),
        guildName: guild.name,
      });
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

      const localHeads = await Promise.all(
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
                    source: 'herald',
                  }
                : null,
            ];
          } catch {
            return [c.id, null];
          }
        }),
      );

      let translatorHeads = {};
      try {
        if (CONFIG.APP.TRANSLATOR_API_URL) {
          const { status, body } = await proxyToTranslator(
            '/api/almanac/channels/heads',
            { 'x-almanac-secret': req.get('x-almanac-secret') || '' },
          );
          if (status === 200 && body.heads) {
            translatorHeads = body.heads;
            for (const [id, head] of Object.entries(translatorHeads)) {
              head.source = 'translator';
            }
          }
        }
      } catch (err) {
        console.warn(`[ALMANAC] Translator heads proxy failed: ${err.message}`);
      }

      const heads = { ...translatorHeads, ...Object.fromEntries(localHeads) };

      res.json({ heads });
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

      if (canRead(channel, guild)) {
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

        return res.json({ messages, channelName: channel.name });
      }

      // phoenix-herald can't read this channel - proxy to the translator.
      if (!CONFIG.APP.TRANSLATOR_API_URL) {
        return res
          .status(403)
          .json({ error: 'Bot cannot read this channel' });
      }

      const secret = req.get('x-almanac-secret') || '';
      const qs = new URLSearchParams();
      if (req.query.limit) qs.set('limit', String(req.query.limit));
      if (req.query.before) qs.set('before', String(req.query.before));
      if (req.query.after) qs.set('after', String(req.query.after));
      const path = `/api/almanac/channels/${encodeURIComponent(id)}/messages${qs.toString() ? `?${qs.toString()}` : ''}`;

      try {
        const { status, body } = await proxyToTranslator(path, { 'x-almanac-secret': secret });
        return res.status(status).json(body);
      } catch (err) {
        console.warn(`[ALMANAC] Translator messages proxy failed: ${err.message}`);
        return res.status(502).json({ error: 'Translator unavailable' });
      }
    }),
  );

  return router;
}

module.exports = almanacRouter;