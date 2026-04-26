import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  type AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  type CommandInteraction,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';
import { Discord, Slash, SlashGroup, SlashOption } from '@rpbey/discordx';

import { getChallongeClient } from '../../lib/challonge.js';
import { Colors, RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';

@Discord()
@SlashGroup({
  name: 'inscription',
  description: 'Gestion des inscriptions aux tournois',
})
@SlashGroup('inscription')
export class RegisterCommand {
  static async autocomplete(interaction: AutocompleteInteraction) {
    const focusedOption = interaction.options.getFocused(true);
    const query = focusedOption.value.toLowerCase();

    // Suggérer les tournois à venir ou en cours
    const tournaments = await prisma.tournament.findMany({
      where: {
        status: { in: ['UPCOMING', 'UNDERWAY'] },
        name: { contains: query, mode: 'insensitive' },
      },
      take: 25,
      orderBy: { date: 'asc' },
    });

    return interaction.respond(
      tournaments.map((t) => ({
        name: t.name,
        value: t.challongeId || t.challongeUrl?.split('/').pop() || t.id,
      })),
    );
  }

  @Slash({ name: 'rejoindre', description: "S'inscrire à un tournoi" })
  async join(
    @SlashOption({
      name: 'tournoi',
      description: 'ID ou Nom du tournoi (ex: B_TS1)',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: RegisterCommand.autocomplete,
    })
    tournamentId: string,
    @SlashOption({
      name: 'pseudo',
      description: 'Ton pseudo de joueur (si différent de Discord)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    customName: string | undefined,
    interaction: CommandInteraction,
  ) {
    const playerName = customName ?? interaction.user.displayName;

    await interaction.deferReply();

    try {
      const challonge = getChallongeClient();

      // Ensure we have a valid slug or ID
      const targetId = tournamentId.includes('/')
        ? tournamentId.split('/').pop()!
        : tournamentId;
      const tournamentRes = await challonge.getTournament(targetId);
      const tournament = tournamentRes.data;

      if (tournament.attributes.state !== 'pending') {
        return interaction.editReply({
          content:
            '❌ Les inscriptions sont fermées pour ce tournoi (il est déjà commencé ou terminé).',
        });
      }

      const participantsRes = await challonge.listParticipants(targetId);
      const existingParticipant = participantsRes.data?.find(
        (p) =>
          p.attributes.name.toLowerCase() === playerName.toLowerCase() ||
          p.attributes.misc === interaction.user.id,
      );

      if (existingParticipant) {
        return interaction.editReply({
          content: `⚠️ Tu es déjà inscrit(e) à **${tournament.attributes.name}** sous le nom **${existingParticipant.attributes.name}** !`,
        });
      }

      await challonge.createParticipant(targetId, {
        name: playerName,
        misc: interaction.user.id,
      });

      try {
        const user = await prisma.user.upsert({
          where: { discordId: interaction.user.id },
          update: { discordTag: interaction.user.tag },
          create: {
            discordId: interaction.user.id,
            discordTag: interaction.user.tag,
            email: `${interaction.user.id}@discord.rpbey.fr`,
            name: playerName,
          },
        });

        await prisma.profile.upsert({
          where: { userId: user.id },
          update: { bladerName: playerName },
          create: {
            userId: user.id,
            bladerName: playerName,
            experience: 'BEGINNER',
          },
        });

        const dbTournament = await prisma.tournament.upsert({
          where: { challongeId: targetId },
          update: { name: tournament.attributes.name },
          create: {
            challongeId: targetId,
            name: tournament.attributes.name,
            date: tournament.attributes.startAt
              ? new Date(tournament.attributes.startAt)
              : new Date(),
            status: 'UPCOMING',
          },
        });

        const existingParticipantDb =
          await prisma.tournamentParticipant.findFirst({
            where: {
              tournamentId: dbTournament.id,
              userId: user.id,
            },
          });
        if (!existingParticipantDb) {
          await prisma.tournamentParticipant.create({
            data: {
              tournamentId: dbTournament.id,
              userId: user.id,
              checkedIn: false,
            },
          });
        }
      } catch (dbError) {
        logger.warn('DB sync failed:', dbError);
      }

      const embed = new EmbedBuilder()
        .setTitle('✅ Inscription confirmée !')
        .setDescription(
          `Tu es maintenant inscrit(e) à **${tournament.attributes.name}** !\n\n` +
            `**Pseudo:** ${playerName}\n` +
            `**Discord:** ${interaction.user.tag}`,
        )
        .setColor(Colors.Success)
        .addFields(
          {
            name: '📅 Date',
            value: tournament.attributes.startAt
              ? `<t:${Math.floor(new Date(tournament.attributes.startAt).getTime() / 1000)}:F>`
              : 'À définir',
            inline: true,
          },
          {
            name: '👥 Inscrits',
            value: `${(participantsRes.data?.length ?? 0) + 1} joueur(s)`,
            inline: true,
          },
        )
        .setFooter({ text: `${RPB.FullName} | Let it rip!` })
        .setTimestamp();

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel('Voir le bracket')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://challonge.com/${tournament.attributes.url}`)
          .setEmoji('🔗'),
      );

      return interaction.editReply({ embeds: [embed], components: [row] });
    } catch (error) {
      logger.error('Join tournament error:', error);
      return interaction.editReply(
        "❌ Erreur lors de l'inscription. Le tournoi existe-t-il sur Challonge ?",
      );
    }
  }

  @Slash({ name: 'quitter', description: "Se désinscrire d'un tournoi" })
  async leave(
    @SlashOption({
      name: 'tournoi',
      description: 'ID ou Nom du tournoi',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: RegisterCommand.autocomplete,
    })
    tournamentId: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();

    try {
      const challonge = getChallongeClient();
      const targetId = tournamentId.includes('/')
        ? tournamentId.split('/').pop()!
        : tournamentId;

      const tournamentRes = await challonge.getTournament(targetId);
      const tournament = tournamentRes.data;

      if (tournament.attributes.state !== 'pending') {
        return interaction.editReply({
          content:
            '❌ Le tournoi a déjà commencé, tu ne peux plus te désinscrire.',
        });
      }

      const participantsRes = await challonge.listParticipants(targetId);
      const participant = participantsRes.data?.find(
        (p) => p.attributes.misc === interaction.user.id,
      );

      if (!participant) {
        return interaction.editReply({
          content: "⚠️ Tu n'es pas inscrit(e) à ce tournoi.",
        });
      }

      const confirmEmbed = new EmbedBuilder()
        .setTitle('⚠️ Confirmation')
        .setDescription(
          `Es-tu sûr(e) de vouloir te désinscrire de **${tournament.attributes.name}** ?\n\n` +
            `Pseudo: **${participant.attributes.name}**`,
        )
        .setColor(Colors.Warning);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('confirm-leave')
          .setLabel('Confirmer')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId('cancel-leave')
          .setLabel('Annuler')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('❌'),
      );

      const response = await interaction.editReply({
        embeds: [confirmEmbed],
        components: [row],
      });

      try {
        const confirmation = await response.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: 30_000,
          filter: (i) => i.user.id === interaction.user.id,
        });

        if (confirmation.customId === 'confirm-leave') {
          await challonge.deleteParticipant(targetId, participant.id);

          const successEmbed = new EmbedBuilder()
            .setTitle('✅ Désinscription confirmée')
            .setDescription(
              `Tu as été retiré(e) de **${tournament.attributes.name}**.`,
            )
            .setColor(Colors.Success)
            .setTimestamp();

          await confirmation.update({ embeds: [successEmbed], components: [] });
        } else {
          const cancelEmbed = new EmbedBuilder()
            .setTitle('❌ Annulé')
            .setDescription('Tu restes inscrit(e) au tournoi.')
            .setColor(Colors.Error);

          await confirmation.update({ embeds: [cancelEmbed], components: [] });
        }
      } catch {
        await interaction.editReply({
          content: '⏰ Temps écoulé. Désinscription annulée.',
          embeds: [],
          components: [],
        });
      }
    } catch (error) {
      logger.error('Leave tournament error:', error);
      return interaction.editReply('❌ Erreur lors de la désinscription.');
    }
  }

  @Slash({ name: 'statut', description: "Vérifie ton statut d'inscription" })
  async status(
    @SlashOption({
      name: 'tournoi',
      description: 'ID ou Nom du tournoi',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: RegisterCommand.autocomplete,
    })
    tournamentId: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();

    try {
      const challonge = getChallongeClient();
      const targetId = tournamentId.includes('/')
        ? tournamentId.split('/').pop()!
        : tournamentId;

      const [tournamentRes, participantsRes] = await Promise.all([
        challonge.getTournament(targetId),
        challonge.listParticipants(targetId),
      ]);

      const tournament = tournamentRes.data;
      const participant = participantsRes.data?.find(
        (p) => p.attributes.misc === interaction.user.id,
      );

      if (!participant) {
        const embed = new EmbedBuilder()
          .setTitle("📋 Statut d'inscription")
          .setDescription(
            `Tu n'es **pas inscrit(e)** à **${tournament.attributes.name}**.`,
          )
          .setColor(Colors.Warning)
          .setTimestamp();

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel("S'inscrire")
            .setStyle(ButtonStyle.Link)
            .setURL(`https://challonge.com/${tournament.attributes.url}`)
            .setEmoji('📝'),
        );

        return interaction.editReply({ embeds: [embed], components: [row] });
      }

      const stateEmoji = participant.attributes.checkedIn ? '✅' : '⏳';
      const embed = new EmbedBuilder()
        .setTitle("📋 Statut d'inscription")
        .setDescription(
          `Tu es **inscrit(e)** à **${tournament.attributes.name}** !`,
        )
        .setColor(Colors.Success)
        .addFields(
          {
            name: '🏷️ Pseudo',
            value: participant.attributes.name,
            inline: true,
          },
          {
            name: '🌱 Seed',
            value: `#${participant.attributes.seed || '?'}`,
            inline: true,
          },
          {
            name: `${stateEmoji} Check-in`,
            value: participant.attributes.checkedIn ? 'Fait' : 'En attente',
            inline: true,
          },
        )
        .setFooter({ text: RPB.FullName })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('Check status error:', error);
      return interaction.editReply(
        '❌ Erreur lors de la vérification du statut.',
      );
    }
  }
}
