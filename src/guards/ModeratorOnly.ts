import { MessageFlags, PermissionFlagsBits, type CommandInteraction, type GuildMember } from "discord.js";
import { type GuardFunction } from '@rpbey/discordx';

export const ModeratorOnly: GuardFunction<CommandInteraction> = async (
  interaction,
  _client,
  next,
) => {
  const member = interaction.member as GuildMember;

  if (!member) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'Cette commande ne peut être utilisée que sur un serveur.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  const hasModPermissions = member.permissions.has([
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
  ]);

  if (hasModPermissions) {
    await next();
  } else {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'Seuls les modérateurs peuvent utiliser cette commande.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
};
