import {
  ApplicationCommandOptionType,
  type CommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Discord, Slash, SlashGroup, SlashOption } from '@rpbey/discordx';

import { scrapeAndSyncTournament } from '../../lib/challonge-sync.js';
import { Colors } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';
import {
  type ScrapedStanding,
  type ScrapedStation,
} from '../../lib/scrapers/challonge-scraper.js';

@Discord()
@SlashGroup({
  name: 'tournoi',
  description: 'Commandes de gestion des tournois (admin)',
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
})
@SlashGroup('tournoi')
export class TournamentCommand {
  @Slash({
    name: 'synchroniser',
    description: 'Synchronisation profonde via scraping furtif',
  })
  async sync(
    @SlashOption({
      name: 'url',
      description: 'URL complète ou slug du tournoi (ex: fr/B_TS2)',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply({ ephemeral: false });

    try {
      await interaction.editReply(
        `🕵️ **Démarrage de la synchronisation furtive...**\nURL: \`${url}\`\n(Cette opération peut prendre 15-30 secondes)`,
      );

      const result = await scrapeAndSyncTournament(url);

      if (result.success) {
        return interaction.editReply(
          `✅ **Synchronisation terminée !**\n\n` +
            `🏆 Tournoi mis à jour en base de données.\n` +
            `👥 **${result.participantsCount}** joueurs synchronisés.\n` +
            `⚔️ **${result.matchesCount}** matchs importés.\n` +
            `🏅 **${result.standingsCount}** standings récupérés.\n` +
            `📡 **${result.stationsCount}** stations détectées.\n` +
            `📜 **${result.logEntriesCount}** entrées de log.\n\n` +
            `👉 Voir sur : https://rpbey.fr/admin/tournaments`,
        );
      } else {
        return interaction.editReply(
          `❌ **Échec de la synchronisation.**\nErreur: \`${result.error}\``,
        );
      }
    } catch (error) {
      logger.error('[TournamentSync]', error);
      return interaction.editReply(
        `💥 **Erreur critique lors de l'opération.**\n\`${error instanceof Error ? error.message : String(error)}\``,
      );
    }
  }
}

@Discord()
export class TournamentLiveCommand {
  @Slash({
    name: 'live',
    description: "Affiche le statut live d'un tournoi en cours",
  })
  async live(
    @SlashOption({
      name: 'tournoi',
      description:
        'Nom ou ID Challonge du tournoi (par défaut: premier tournoi en cours)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    search: string | undefined,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();

    try {
      const tournament = search
        ? await prisma.tournament.findFirst({
            where: {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { challongeId: search },
              ],
              status: 'UNDERWAY',
            },
          })
        : await prisma.tournament.findFirst({
            where: { status: 'UNDERWAY' },
            orderBy: { date: 'desc' },
          });

      if (!tournament) {
        return interaction.editReply(
          `❌ Aucun tournoi en cours trouvé${search ? ` pour « ${search} »` : ''}.`,
        );
      }

      const standings =
        (tournament.standings as unknown as ScrapedStanding[] | null) || [];
      const stations =
        (tournament.stations as unknown as ScrapedStation[] | null) || [];
      const participantCount = await prisma.tournamentParticipant.count({
        where: { tournamentId: tournament.id },
      });
      const matchCount = await prisma.tournamentMatch.count({
        where: { tournamentId: tournament.id },
      });
      const completedMatches = await prisma.tournamentMatch.count({
        where: { tournamentId: tournament.id, state: 'complete' },
      });

      const top5 = standings.slice(0, 5);
      const standingsText =
        top5.length > 0
          ? top5
              .map(
                (s) => `**${s.rank}.** ${s.name} (${s.wins}V - ${s.losses}D)`,
              )
              .join('\n')
          : '*Classement non disponible*';

      const activeStations = stations.filter((s) => s.status === 'active');
      const stationsText =
        activeStations.length > 0
          ? activeStations
              .map((s) => {
                const match = s.currentMatch;
                return match
                  ? `**${s.name}** : ${match.player1 || '?'} vs ${match.player2 || '?'} (${match.scores})`
                  : `**${s.name}** : En cours`;
              })
              .join('\n')
          : '*Aucune station active*';

      const embed = new EmbedBuilder()
        .setTitle(`🏆 ${tournament.name}`)
        .setColor(Colors.Primary)
        .addFields(
          {
            name: '📊 Progression',
            value: `${completedMatches}/${matchCount} matchs terminés | ${participantCount} participants`,
            inline: false,
          },
          {
            name: '🏅 Top 5',
            value: standingsText,
            inline: true,
          },
          {
            name: `📡 Stations (${activeStations.length}/${stations.length})`,
            value: stationsText,
            inline: true,
          },
        )
        .setTimestamp()
        .setFooter({ text: 'Dernière sync' });

      if (tournament.challongeUrl) {
        embed.setURL(tournament.challongeUrl);
      }

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('[TournamentLive]', error);
      return interaction.editReply(
        `💥 **Erreur lors de la récupération des données live.**\n\`${error instanceof Error ? error.message : String(error)}\``,
      );
    }
  }
}
