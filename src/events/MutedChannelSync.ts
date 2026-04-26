import { ChannelType } from 'discord.js';
import { type ArgsOf, Discord, On } from '@rpbey/discordx';

import { logger } from '../lib/logger.js';

const MUTED_CHANNEL_ID = process.env.MUTED_CHANNEL_ID ?? '1456761597245784260';
const MUTED_ROLE_NAME = 'Muted';

@Discord()
export class MutedChannelSyncListener {
  @On({ event: 'channelCreate' })
  async onChannelCreate([channel]: ArgsOf<'channelCreate'>) {
    if (channel.partial) {
      try {
        await channel.fetch();
      } catch {
        return;
      }
    }

    if (!('guild' in channel) || !channel.guild) return;

    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildForum &&
      channel.type !== ChannelType.GuildCategory
    ) {
      return;
    }

    const mutedRole = channel.guild.roles.cache.find(
      (r) => r.name === MUTED_ROLE_NAME,
    );

    if (!mutedRole) return;

    try {
      if (channel.id === MUTED_CHANNEL_ID) {
        await channel.permissionOverwrites.edit(mutedRole, {
          ViewChannel: true,
          SendMessages: true,
          AddReactions: false,
          AttachFiles: false,
          EmbedLinks: false,
        });
      } else {
        await channel.permissionOverwrites.edit(mutedRole, {
          ViewChannel: false,
          SendMessages: false,
        });
      }

      logger.debug(
        `Permissions Muted configurées pour le nouveau salon: ${channel.name}`,
      );
    } catch (error) {
      logger.warn(
        `Impossible de configurer les permissions Muted pour ${channel.name}:`,
        error,
      );
    }
  }
}
