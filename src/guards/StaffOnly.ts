import { MessageFlags, type CommandInteraction, type GuildMember } from "discord.js";
import { type GuardFunction } from '@rpbey/discordx';

import { RPB } from '../lib/constants.js';

/**
 * Guard that restricts commands to staff members only.
 * Checks for roles: Admin, RH, Modo, Staff, and Artiste RPB.
 */

const STAFF_ROLE_IDS: string[] = [
  RPB.Roles.Admin,
  RPB.Roles.Rh,
  RPB.Roles.Modo,
  RPB.Roles.Staff,
];

export const StaffOnly: GuardFunction<CommandInteraction> = async (
  interaction,
  _client,
  next,
) => {
  const member = interaction.member as GuildMember | null;

  if (!member) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'Cette commande ne peut être utilisée que sur un serveur.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  const hasStaffRole = member.roles.cache.some(
    (role) =>
      STAFF_ROLE_IDS.includes(role.id) ||
      role.name.toLowerCase().includes('artiste'),
  );

  if (hasStaffRole) {
    await next();
  } else {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content:
          'Cette commande est réservée au staff (Admin, RH, Modo, Staff, Artistes).',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
};
