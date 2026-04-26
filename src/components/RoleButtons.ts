import { EmbedBuilder, MessageFlags, type ButtonInteraction } from "discord.js";
import { ButtonComponent, Discord } from '@rpbey/discordx';

import { Colors, RPB } from '../lib/constants.js';
import { logger } from '../lib/logger.js';
import { ROLE_PANELS, type RoleButtonConfig } from '../lib/role-panels.js';

const BUTTON_MAP = new Map<string, RoleButtonConfig>();
for (const panel of ROLE_PANELS) {
  for (const btn of panel.buttons) {
    BUTTON_MAP.set(btn.customId, btn);
  }
}

@Discord()
export class RoleButtonHandler {
  @ButtonComponent({ id: /^role-/ })
  async handleRoleButton(interaction: ButtonInteraction) {
    const config = BUTTON_MAP.get(interaction.customId);
    if (!config) {
      return interaction.reply({
        content: '❌ Rôle inconnu.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const roleId = RPB.Roles[config.roleKey];

    if (!roleId || roleId.includes('REPLACE')) {
      return interaction.editReply({
        content: `❌ Le rôle **${config.roleKey}** n'est pas encore configuré (ID manquant). Contactez un administrateur.`,
      });
    }

    const role = interaction.guild?.roles.cache.get(roleId);
    if (!role) {
      return interaction.editReply({
        content: `❌ Le rôle configuré (ID: ${roleId}) est introuvable sur ce serveur.`,
      });
    }

    const member = interaction.guild?.members.cache.get(interaction.user.id);
    if (!member) {
      return interaction.editReply({
        content: '❌ Impossible de vous trouver sur le serveur.',
      });
    }

    try {
      const hasRole = member.roles.cache.has(roleId);
      const embed = new EmbedBuilder().setTimestamp();

      if (hasRole) {
        await member.roles.remove(role);
        embed
          .setColor(Colors.Error)
          .setTitle(`🗑️ Rôle retiré : ${role.name}`)
          .setDescription(
            'Vous ne recevrez plus de notifications pour ce rôle.',
          );
      } else {
        await member.roles.add(role);
        embed
          .setColor(Colors.Success)
          .setTitle(`✅ Rôle ajouté : ${role.name}`)
          .setDescription(
            config.description || 'Vous avez obtenu le rôle avec succès !',
          );
      }

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error(
        `[RoleButton] Failed to toggle role ${role.name} for user ${interaction.user.tag}:`,
        error,
      );
      return interaction.editReply({
        content:
          '❌ Une erreur est survenue lors de la modification du rôle. Vérifiez que le bot a les permissions nécessaires (il doit être au-dessus du rôle à attribuer).',
      });
    }
  }
}
