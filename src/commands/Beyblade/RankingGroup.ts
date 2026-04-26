import { RankCardBuilder } from 'canvacord';
import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  type CommandInteraction,
  EmbedBuilder,
  type User,
} from 'discord.js';
import { Discord, Slash, SlashChoice, SlashGroup, SlashOption } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { generateProfileCard } from '../../lib/canvas-utils.js';
import { Colors } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import { PrismaService } from '../../lib/prisma.js';
import {
  defaultSeasonKey,
  renderRankingPanel,
  type RankingVariant,
} from '../../lib/ranking-panel.js';

@Discord()
@SlashGroup({
  description: 'Commandes de classement et profils',
  name: 'classement',
})
@SlashGroup('classement')
@injectable()
export class RankingGroup {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  @Slash({ description: "Voir le profil d'un blader", name: 'profil' })
  @SlashGroup('classement')
  async profile(
    @SlashOption({
      name: 'joueur',
      required: false,
      type: ApplicationCommandOptionType.User,
      description: 'Le joueur à voir',
    })
    targetUser: User | undefined,
    @SlashChoice({ name: 'Style RPB', value: 'rpb' })
    @SlashChoice({ name: 'Style Classique', value: 'classic' })
    @SlashOption({
      name: 'style',
      required: false,
      type: ApplicationCommandOptionType.String,
      description: 'Style de carte',
    })
    style: 'rpb' | 'classic' = 'rpb',
    interaction: CommandInteraction,
  ) {
    const target = targetUser ?? interaction.user;
    await interaction.deferReply();
    try {
      const user = await this.prisma.user.findFirst({
        include: {
          _count: { select: { tournaments: true } },
          profile: true,
          decks: {
            where: { isActive: true },
            take: 1,
            include: {
              items: {
                orderBy: { position: 'asc' },
                include: { blade: true },
              },
            },
          },
        },
        where: { discordId: target.id },
      });
      if (!user?.profile)
        return interaction.editReply({
          content:
            '❌ Profil introuvable. Crée ton compte sur https://rpbey.fr/dashboard',
        });

      const rankingPoints = user.profile.rankingPoints;
      const rank =
        (await this.prisma.globalRanking.count({
          where: { points: { gt: rankingPoints } },
        })) + 1;

      if (style === 'classic') {
        const level = Math.floor(Math.sqrt(rankingPoints / 10));
        const card = new RankCardBuilder()
          .setAvatar(target.displayAvatarURL({ extension: 'png' }))
          .setDisplayName(target.displayName)
          .setLevel(level)
          .setRank(rank)
          .setCurrentXP(rankingPoints % 100)
          .setRequiredXP(100)
          .setUsername(target.username);
        return interaction.editReply({
          files: [
            new AttachmentBuilder(await card.build(), { name: 'rank.png' }),
          ],
        });
      }

      // Compute rank title based on points
      const rankTitle =
        rank === 1
          ? 'Champion'
          : rankingPoints >= 500
            ? 'Expert'
            : rankingPoints >= 200
              ? 'Vétéran'
              : rankingPoints >= 50
                ? 'Combattant'
                : 'Blader';

      // Get active deck if available
      const activeDeck = user.decks[0];
      const deckData = activeDeck?.items.some((i) => i.blade)
        ? {
            name: activeDeck.name,
            blades: activeDeck.items.map((i) => ({
              name: i.blade?.name || '?',
              imageUrl: i.blade?.imageUrl
                ? `https://rpbey.fr${i.blade.imageUrl}`
                : '',
            })),
          }
        : null;

      const cardBuffer = await generateProfileCard({
        activeDeck: deckData,
        avatarUrl: target.displayAvatarURL({ extension: 'png', size: 512 }),
        bestStreak: 0,
        bladerName: user.profile.bladerName || target.displayName,
        currentStreak: 0,
        joinedAt: user.createdAt.toLocaleDateString('fr-FR'),
        losses: user.profile.losses,
        rank,
        rankingPoints,
        rankTitle,
        tournamentWins: user.profile.tournamentWins,
        tournamentsPlayed: user._count.tournaments,
        winRate: this.computeWinRate(user.profile.wins, user.profile.losses),
        wins: user.profile.wins,
      });
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Primary)
            .setImage('attachment://profile.png'),
        ],
        files: [new AttachmentBuilder(cardBuffer, { name: 'profile.png' })],
      });
    } catch (error) {
      logger.error('[Ranking] Profile error:', error);
      return interaction.editReply(
        '❌ Erreur lors du chargement du profil. Vérifie que ton compte existe sur rpbey.fr/dashboard.',
      );
    }
  }

  @Slash({ description: 'Afficher le top des bladers', name: 'top' })
  @SlashGroup('classement')
  async leaderboard(
    @SlashChoice({ name: 'RPB', value: 'rpb' })
    @SlashChoice({ name: 'BBT', value: 'satr' })
    @SlashChoice({ name: 'UB', value: 'wb' })
    @SlashOption({
      name: 'type',
      required: false,
      type: ApplicationCommandOptionType.String,
      description: 'Type de classement',
    })
    type: string = 'rpb',
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    try {
      const variant = (
        type === 'satr' || type === 'wb' || type === 'rpb' ? type : 'rpb'
      ) as RankingVariant;
      const season = await defaultSeasonKey(variant);
      const { embed, file, components } = await renderRankingPanel({
        variant,
        season,
        page: 0,
      });
      return interaction.editReply({
        embeds: [embed],
        files: [file],
        components,
      });
    } catch (error) {
      logger.error('[Ranking] Leaderboard error:', error);
      return interaction.editReply(
        '❌ Erreur lors du chargement du classement.',
      );
    }
  }

  private computeWinRate(wins: number, losses: number): string {
    const total = wins + losses;
    if (total === 0) return '0%';
    return `${Math.round((wins / total) * 100)}%`;
  }
}
