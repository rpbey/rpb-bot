import { ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, type CommandInteraction, type TextChannel } from "discord.js";
import { Discord, Guard, Slash, SlashOption } from '@rpbey/discordx';

import { OwnerOnly } from '../../guards/OwnerOnly.js';
import { RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import { ROLE_PANELS } from '../../lib/role-panels.js';

@Discord()
@Guard(OwnerOnly)
export class RoleReactionCommand {
  @Slash({
    name: 'config-roles',
    description: 'Configure les messages de rôles réaction',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
  })
  async configRoles(
    @SlashOption({
      name: 'salon',
      description: 'Le salon où envoyer les panneaux (défaut: #rôles)',
      required: false,
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText],
    })
    channelOption: TextChannel | undefined,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const defaultChannelId = RPB.Channels.Roles;
    const channel = (channelOption ??
      interaction.guild?.channels.cache.get(defaultChannelId)) as TextChannel;

    if (!channel) {
      return interaction.editReply(
        `❌ Impossible de trouver le salon cible (ID: ${defaultChannelId}).`,
      );
    }

    try {
      let sentCount = 0;

      for (const panel of ROLE_PANELS) {
        const embed = new EmbedBuilder()
          .setTitle(panel.title)
          .setDescription(panel.description)
          .setColor(panel.color);

        if (panel.image) {
          embed.setImage(panel.image);
        }

        const row = new ActionRowBuilder<ButtonBuilder>();

        for (const btn of panel.buttons) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(btn.customId)
              .setLabel(btn.label)
              .setEmoji(btn.emoji)
              .setStyle(btn.style),
          );
        }

        await channel.send({
          embeds: [embed],
          components: [row],
        });
        sentCount++;
      }

      return interaction.editReply(
        `✅ ${sentCount} panneaux de rôles envoyés dans ${channel} !`,
      );
    } catch (error) {
      logger.error('Setup roles error:', error);
      return interaction.editReply(
        "❌ Une erreur est survenue lors de l'envoi des panneaux.",
      );
    }
  }
}
