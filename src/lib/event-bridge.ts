import { publishEvent } from './api-server.js';
import { bot } from './bot.js';

/**
 * Wire Discord client lifecycle + interactions to the WebSocket pub/sub topics
 * exposed by the api-server. Call once, after `bot` is constructed but before login.
 */
export function setupEventBridge() {
  // Bot lifecycle -------------------------------------------------------------
  bot.once('clientReady', () => {
    publishEvent('bot-events', {
      type: 'ready',
      tag: bot.user?.tag,
      guilds: bot.guilds.cache.size,
      ping: bot.ws.ping,
    });
  });

  bot.on('shardReconnecting', (shardId) => {
    publishEvent('bot-events', { type: 'reconnecting', shardId });
  });

  bot.on('shardResume', (shardId, replayedEvents) => {
    publishEvent('bot-events', { type: 'resumed', shardId, replayedEvents });
  });

  bot.on('shardError', (error, shardId) => {
    publishEvent('bot-events', {
      type: 'shard-error',
      shardId,
      message: error.message,
    });
  });

  bot.on('error', (error) => {
    publishEvent('bot-events', { type: 'error', message: error.message });
  });

  // Discord user-facing events -----------------------------------------------
  bot.on('interactionCreate', (interaction) => {
    if (interaction.isChatInputCommand()) {
      publishEvent('discord-events', {
        type: 'slash-command',
        name: interaction.commandName,
        user: interaction.user.tag,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
    } else if (interaction.isButton()) {
      publishEvent('discord-events', {
        type: 'button',
        customId: interaction.customId,
        user: interaction.user.tag,
      });
    } else if (interaction.isStringSelectMenu()) {
      publishEvent('discord-events', {
        type: 'select-menu',
        customId: interaction.customId,
        values: interaction.values,
        user: interaction.user.tag,
      });
    }
  });

  bot.on('guildMemberAdd', (member) => {
    publishEvent('discord-events', {
      type: 'member-join',
      user: member.user.tag,
      guildId: member.guild.id,
    });
  });

  bot.on('guildMemberRemove', (member) => {
    publishEvent('discord-events', {
      type: 'member-leave',
      user: member.user.tag,
      guildId: member.guild.id,
    });
  });
}
