import { EmbedBuilder, MessageFlags, type CommandInteraction } from "discord.js";
import { type GuardFunction } from '@rpbey/discordx';

import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

const BLACKLISTED_IDS = new Set(
  process.env.BLACKLISTED_USERS?.split(',').filter(Boolean) ?? [],
);

export const NotBlacklisted: GuardFunction<CommandInteraction> = async (
  interaction,
  _client,
  next,
) => {
  const user = interaction.user;

  try {
    if (BLACKLISTED_IDS.has(user.id)) {
      await sendError(interaction);
      return;
    }

    const dbUser = await prisma.user.findUnique({
      where: { discordId: user.id },
      select: { role: true },
    });

    if (dbUser?.role === 'banned') {
      await sendError(interaction);
      return;
    }

    await next();
  } catch (error) {
    logger.error('NotBlacklisted guard error:', error);
    // Fail open
    await next();
  }
};

async function sendError(interaction: CommandInteraction) {
  const embed = new EmbedBuilder()
    .setColor(0x1f2937)
    .setTitle('⛔ Accès refusé')
    .setDescription(
      'Tu as été banni de la communauté RPB et ne peux plus utiliser le bot.\n\n' +
        "Si tu penses que c'est une erreur, contacte un administrateur.",
    )
    .setFooter({ text: 'République Populaire du Beyblade' });

  if (interaction.isRepliable()) {
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  }
}
