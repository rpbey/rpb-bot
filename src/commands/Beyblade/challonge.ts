import {
  ApplicationCommandOptionType,
  type CommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { Discord, Slash, SlashGroup, SlashOption } from '@rpbey/discordx';

import { Colors, RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';

@Discord()
@SlashGroup({ name: 'challonge', description: 'Gérer ton compte Challonge' })
@SlashGroup('challonge')
export class ChallongeCommand {
  @Slash({
    name: 'lier',
    description: 'Lier ton pseudo Challonge à ton compte Discord',
  })
  async link(
    @SlashOption({
      name: 'pseudo',
      description: 'Ton pseudo exact sur Challonge',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    challongeUsername: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();

    try {
      const _user = await prisma.user.upsert({
        where: { discordId: interaction.user.id },
        create: {
          discordId: interaction.user.id,
          discordTag: interaction.user.tag,
          name: interaction.user.displayName,
          email: `${interaction.user.id}@discord.rpbey.fr`,
          profile: {
            create: {
              challongeUsername,
              bladerName: interaction.user.displayName,
            },
          },
        },
        update: {
          discordTag: interaction.user.tag,
          profile: {
            upsert: {
              create: {
                challongeUsername,
                bladerName: interaction.user.displayName,
              },
              update: {
                challongeUsername,
              },
            },
          },
        },
        include: { profile: true },
      });

      const embed = new EmbedBuilder()
        .setTitle('✅ Compte Challonge lié !')
        .setDescription(
          `Ton compte Discord est maintenant lié au pseudo Challonge : **${challongeUsername}**.\n\n` +
            `Cela permettra de suivre automatiquement tes résultats de tournoi.`,
        )
        .setColor(Colors.Success)
        .setFooter({ text: RPB.FullName })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('Challonge link error:', error);
      return interaction.editReply({
        content: '❌ Une erreur est survenue lors de la liaison du compte.',
      });
    }
  }

  @Slash({
    name: 'info',
    description: 'Voir les informations de ton compte lié',
  })
  async info(interaction: CommandInteraction) {
    await interaction.deferReply();

    try {
      const user = await prisma.user.findUnique({
        where: { discordId: interaction.user.id },
        include: { profile: true },
      });

      if (!user?.profile?.challongeUsername) {
        return interaction.editReply({
          content:
            "❌ Tu n'as pas encore lié de compte Challonge. Utilise `/challonge lier` pour le faire.",
        });
      }

      const embed = new EmbedBuilder()
        .setTitle('👤 Informations Challonge')
        .setColor(Colors.Primary)
        .addFields({
          name: 'Pseudo Lié',
          value: user.profile.challongeUsername,
          inline: true,
        })
        .setDescription(
          `Lien profil : [Voir sur Challonge](https://challonge.com/users/${user.profile.challongeUsername})`,
        )
        .setFooter({ text: RPB.FullName })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('Challonge info error:', error);
      return interaction.editReply(
        '❌ Erreur lors de la récupération des infos.',
      );
    }
  }
}
