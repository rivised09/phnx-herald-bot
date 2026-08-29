const { ChannelType } = require('discord.js');
const prisma = require('../../db');
const { CONFIG } = require('../../config');

const SYNCED_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

function channelTypeLabel(type) {
  if (type === ChannelType.GuildStageVoice) return 'STAGE';
  if (type === ChannelType.GuildVoice) return 'VOICE';
  return null;
}

function isSyncedChannel(channel) {
  return channelTypeLabel(channel.type) !== null;
}

function toRecord(channel, guildId) {
  return {
    id: channel.id,
    guildId,
    name: channel.name,
    type: channelTypeLabel(channel.type),
    position: typeof channel.rawPosition === 'number' ? channel.rawPosition : 0,
  };
}

async function syncChannels(client) {
  try {
    const guild = await client.guilds.fetch(CONFIG.DISCORD.GUILD_ID);
    const channels = await guild.channels.fetch();
    const records = channels
      .filter(isSyncedChannel)
      .map((ch) => toRecord(ch, guild.id));

    for (const record of records) {
      await prisma.discordChannel.upsert({
        where: { id: record.id },
        update: { name: record.name, type: record.type, position: record.position },
        create: record,
      });
    }

    const knownIds = records.map((r) => r.id);
    await prisma.discordChannel.deleteMany({
      where: { guildId: guild.id, id: { notIn: knownIds } },
    });

    console.log(`[CHANNELS] Synced ${records.length} voice/stage channels`);
    return records;
  } catch (err) {
    console.error('[CHANNELS] Sync failed:', err.message);
    return [];
  }
}

async function upsertChannel(channel) {
  const type = channelTypeLabel(channel);
  if (!type) return;
  try {
    await prisma.discordChannel.upsert({
      where: { id: channel.id },
      update: {
        name: channel.name,
        type,
        position: typeof channel.rawPosition === 'number' ? channel.rawPosition : 0,
      },
      create: {
        id: channel.id,
        guildId: channel.guildId,
        name: channel.name,
        type,
        position: typeof channel.rawPosition === 'number' ? channel.rawPosition : 0,
      },
    });
  } catch (err) {
    console.error('[CHANNELS] Upsert failed for', channel.name, ':', err.message);
  }
}

async function deleteChannel(channel) {
  if (!channelTypeLabel(channel)) return;
  try {
    await prisma.discordChannel.delete({ where: { id: channel.id } });
  } catch (err) {
    if (err.code !== 'P2025') {
      console.error('[CHANNELS] Delete failed for', channel.name, ':', err.message);
    }
  }
}

function enableChannelSync(client) {
  client.on('channelCreate', (channel) => upsertChannel(channel));
  client.on('channelUpdate', (oldChannel, newChannel) => upsertChannel(newChannel));
  client.on('channelDelete', (channel) => deleteChannel(channel));
}

module.exports = { enableChannelSync, syncChannels };