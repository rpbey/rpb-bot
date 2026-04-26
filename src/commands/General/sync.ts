import { ChannelType, MessageFlags, PermissionFlagsBits, type CommandInteraction } from "discord.js";
import { Discord, Slash } from '@rpbey/discordx';

import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';

@Discord()
export class SyncCommand {
  @Slash({
    name: 'synchroniser',
    description: 'Synchronise rôles, salons et membres avec la base de données',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
  })
  async sync(interaction: CommandInteraction) {
    const { guild } = interaction;

    if (!guild) {
      return interaction.reply({
        content: '❌ Cette commande ne peut être utilisée que sur un serveur.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply({
      content: '🔄 Démarrage de la synchronisation globale...',
      flags: MessageFlags.Ephemeral,
    });

    try {
      // --- 1. Sync Roles ---
      await interaction.editReply('🔄 Synchronisation des Rôles...');
      const roles = await guild.roles.fetch();
      let rolesSynced = 0;

      for (const role of roles.values()) {
        await prisma.discordRole.upsert({
          where: { id: role.id },
          create: {
            id: role.id,
            name: role.name,
            color: role.hexColor,
            position: role.position,
            icon: role.iconURL(),
            permissions: role.permissions.bitfield.toString(),
            managed: role.managed,
            hoist: role.hoist,
          },
          update: {
            name: role.name,
            color: role.hexColor,
            position: role.position,
            icon: role.iconURL(),
            permissions: role.permissions.bitfield.toString(),
            managed: role.managed,
            hoist: role.hoist,
          },
        });
        rolesSynced++;
      }

      // --- 2. Sync Channels ---
      await interaction.editReply(
        `✅ ${rolesSynced} Rôles synchronisés.\n🔄 Synchronisation des Salons...`,
      );
      const channels = await guild.channels.fetch();
      let channelsSynced = 0;

      for (const channel of channels.values()) {
        if (!channel) continue;

        await prisma.discordChannel.upsert({
          where: { id: channel.id },
          create: {
            id: channel.id,
            name: channel.name,
            type: ChannelType[channel.type] || 'UNKNOWN',
            parentId: channel.parentId,
            position: channel.position,
          },
          update: {
            name: channel.name,
            type: ChannelType[channel.type] || 'UNKNOWN',
            parentId: channel.parentId,
            position: channel.position,
          },
        });
        channelsSynced++;
      }

      // --- 3. Sync Members ---
      await interaction.editReply(
        `✅ ${rolesSynced} Rôles, ${channelsSynced} Salons synchronisés.\n🔄 Synchronisation des Membres...`,
      );

      const members = await guild.members.fetch();
      const totalMembers = members.size;
      let membersUpdated = 0;
      let errors = 0;

      const BATCH_SIZE = 50;
      const memberChunks = Array.from(members.values());

      for (let i = 0; i < memberChunks.length; i += BATCH_SIZE) {
        const chunk = memberChunks.slice(i, i + BATCH_SIZE);

        await Promise.all(
          chunk.map(async (member) => {
            try {
              const existingUser = await prisma.user.findUnique({
                where: { discordId: member.id },
              });

              if (existingUser) {
                await prisma.user.update({
                  where: { id: existingUser.id },
                  data: {
                    nickname: member.nickname,
                    joinedAt: member.joinedAt,
                    premiumSince: member.premiumSince,
                    roles: member.roles.cache.map((r) => ({
                      name: r.name,
                      color: r.hexColor,
                      id: r.id,
                    })),
                    status: member.presence?.status || 'offline',
                    activities: (member.presence?.activities || []).map(
                      (a) => ({
                        name: a.name,
                        type: a.type,
                        state: a.state,
                        details: a.details,
                        url: a.url,
                      }),
                    ),
                    serverAvatar: member.avatarURL({
                      extension: 'png',
                      size: 256,
                    }),
                    globalName: member.user.globalName,
                    discordTag: member.user.tag,
                    image: member.user.displayAvatarURL({
                      extension: 'png',
                      size: 256,
                    }),
                  },
                });
                membersUpdated++;
              }
            } catch (e) {
              logger.error(
                `[Sync] Error syncing member ${member.user.tag}:`,
                e,
              );
              errors++;
            }
          }),
        );

        if ((i + BATCH_SIZE) % 100 === 0) {
          await interaction.editReply({
            content: `🔄 Membres : ${Math.min(i + BATCH_SIZE, totalMembers)}/${totalMembers} traités...`,
          });
        }
      }

      return interaction.editReply({
        content:
          `✅ **Synchronisation Globale Terminée !**\n\n` +
          `🎭 Rôles : ${rolesSynced}\n` +
          `📺 Salons : ${channelsSynced}\n` +
          `👥 Membres (liés) : ${membersUpdated}/${totalMembers}\n` +
          `⚠️ Erreurs : ${errors}\n\n` +
          `*Les données sont maintenant à jour dans la base de données.*`,
      });
    } catch (error) {
      logger.error('[Sync] Command error:', error);
      return interaction.editReply({
        content: `❌ Une erreur majeure est survenue : ${error}`,
      });
    }
  }
}
