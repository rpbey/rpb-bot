import { EmbedBuilder, MessageFlags, type ModalSubmitInteraction } from "discord.js";
import { Discord, ModalComponent } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { Colors, RPB } from '../lib/constants.js';
import { logger } from '../lib/logger.js';
import { PrismaService } from '../lib/prisma.js';

@Discord()
@injectable()
export class TournamentModalHandler {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  @ModalComponent({ id: /^tournament-register-modal-/ })
  async handleTournamentModal(interaction: ModalSubmitInteraction) {
    const tournamentId = interaction.customId.replace(
      'tournament-register-modal-',
      '',
    );

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const bladerName = interaction.fields.getTextInputValue('blader-name');
    const beyblade = interaction.fields.getTextInputValue('beyblade');

    try {
      let user = await this.prisma.user.findFirst({
        where: { discordId: interaction.user.id },
      });

      user ??= await this.prisma.user.create({
        data: {
          discordId: interaction.user.id,
          discordTag: interaction.user.tag,
          name: interaction.user.displayName,
          email: `${interaction.user.id}@discord.placeholder`,
        },
      });

      const tournament = await this.prisma.tournament.findUnique({
        where: { id: tournamentId },
        include: {
          _count: { select: { participants: true } },
        },
      });

      if (!tournament) {
        return interaction.editReply({
          content: "❌ Ce tournoi n'existe plus.",
        });
      }

      const existingParticipant =
        await this.prisma.tournamentParticipant.findFirst({
          where: {
            tournamentId,
            userId: user.id,
          },
        });

      if (existingParticipant) {
        return interaction.editReply({
          content: '❌ Tu es déjà inscrit à ce tournoi !',
        });
      }

      if (tournament._count.participants >= tournament.maxPlayers) {
        return interaction.editReply({
          content: '❌ Le tournoi est complet !',
        });
      }

      if (tournament.status !== 'REGISTRATION_OPEN') {
        return interaction.editReply({
          content: '❌ Les inscriptions sont fermées pour ce tournoi.',
        });
      }

      await this.prisma.tournamentParticipant.create({
        data: {
          tournamentId,
          userId: user.id,
        },
      });

      await this.prisma.profile.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          bladerName,
        },
        update: {
          bladerName: bladerName ?? undefined,
        },
      });

      const embed = new EmbedBuilder()
        .setTitle('🎉 Inscription confirmée !')
        .setDescription(`Tu es maintenant inscrit à **${tournament.name}** !`)
        .setColor(Colors.Success)
        .addFields(
          { name: '👤 Nom de Blader', value: bladerName, inline: true },
          {
            name: '🌀 Toupie',
            value: beyblade || 'Non spécifiée',
            inline: true,
          },
          {
            name: '📅 Date',
            value: tournament.date.toLocaleDateString('fr-FR'),
            inline: true,
          },
        )
        .setFooter({
          text: `${RPB.FullName} | Pense à faire ton check-in le jour J !`,
        })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('Tournament registration error:', error);
      return interaction.editReply({
        content: "❌ Erreur lors de l'inscription. Réessaie plus tard.",
      });
    }
  }
}
