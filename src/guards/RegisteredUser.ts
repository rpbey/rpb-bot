import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type CommandInteraction } from "discord.js";
import { type GuardFunction } from '@rpbey/discordx';

import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export const RegisteredUser: GuardFunction<CommandInteraction> = async (
  interaction,
  _client,
  next,
) => {
  try {
    const dbUser = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
      include: { profile: true },
    });

    if (!dbUser) {
      const embed = new EmbedBuilder()
        .setColor(0xdc2626)
        .setTitle('🔒 Inscription requise')
        .setDescription(
          'Tu dois créer un compte RPB pour utiliser cette commande.\n\n' +
            'Connecte-toi sur le dashboard pour lier ton compte Discord !',
        )
        .setThumbnail('https://rpbey.fr/logo.webp')
        .addFields({
          name: '💡 Comment faire ?',
          value:
            '1. Clique sur le bouton ci-dessous\n2. Connecte-toi avec Discord\n3. Reviens ici et utilise la commande !',
        })
        .setFooter({ text: 'République Populaire du Beyblade' });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel('Créer mon compte RPB')
          .setURL('https://rpbey.fr/sign-in')
          .setStyle(ButtonStyle.Link)
          .setEmoji('🎯'),
      );

      if (interaction.isRepliable()) {
        await interaction.reply({
          embeds: [embed],
          components: [row],
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    await next();
  } catch (error) {
    logger.error('RegisteredUser guard error:', error);
    if (interaction.isRepliable()) {
      await interaction.reply({
        content:
          'Une erreur est survenue lors de la vérification de ton compte.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
};
