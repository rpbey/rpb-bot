import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type User,
  type UserContextMenuCommandInteraction,
} from 'discord.js';
import { ContextMenu, Discord } from '@rpbey/discordx';

import { Colors, RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';

@Discord()
export class ProfileContextMenuCommand {
  @ContextMenu({ name: 'Profil Beyblade', type: ApplicationCommandType.User })
  async userHandler(interaction: UserContextMenuCommandInteraction) {
    await interaction.deferReply();

    const targetUser: User = interaction.targetUser;

    try {
      const user = await prisma.user.findFirst({
        where: { discordId: targetUser.id },
        include: {
          profile: true,
          tournaments: {
            include: { tournament: true },
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
      });

      if (!user?.profile) {
        const embed = new EmbedBuilder()
          .setTitle(`👤 ${targetUser.displayName}`)
          .setDescription(
            "Cet utilisateur n'a pas encore de profil Beyblade sur RPB.\n" +
              'Crée ton profil sur [rpbey.fr/dashboard](https://rpbey.fr/dashboard) !',
          )
          .setColor(Colors.Warning)
          .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
          .setFooter({ text: RPB.FullName })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      const profile = user.profile;
      const total = profile.wins + profile.losses;
      const winRate = total > 0 ? Math.round((profile.wins / total) * 100) : 0;

      // Ranking position
      const rankingPoints = profile.rankingPoints;
      const rank =
        (await prisma.globalRanking.count({
          where: { points: { gt: rankingPoints } },
        })) + 1;

      const rankTitle =
        rank === 1
          ? '🥇 Champion'
          : rankingPoints >= 500
            ? '💎 Expert'
            : rankingPoints >= 200
              ? '⭐ Vétéran'
              : rankingPoints >= 50
                ? '⚔️ Combattant'
                : '🌀 Blader';

      const bar = (v: number, max: number) => {
        if (max === 0) return '░░░░░░░░░░';
        const filled = Math.round((v / max) * 10);
        return (
          '█'.repeat(Math.min(filled, 10)) +
          '░'.repeat(10 - Math.min(filled, 10))
        );
      };

      const embed = new EmbedBuilder()
        .setTitle(
          `${rankTitle} · ${profile.bladerName ?? targetUser.displayName}`,
        )
        .setDescription(profile.bio ?? '*Pas de bio*')
        .setColor(rank === 1 ? 0xffd700 : rank <= 3 ? 0xc0c0c0 : Colors.Primary)
        .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
        .addFields(
          {
            name: '🏅 Classement',
            value: `**#${rank}** · ${rankingPoints} pts`,
            inline: true,
          },
          {
            name: '🎮 Type favori',
            value: profile.favoriteType ?? 'Non défini',
            inline: true,
          },
          {
            name: '⭐ Niveau',
            value: profile.experience ?? 'Non défini',
            inline: true,
          },
          {
            name: '📊 Combat',
            value:
              `\`${bar(profile.wins, total)}\` **${winRate}%** WR\n` +
              `✅ ${profile.wins}W · ❌ ${profile.losses}L · ${total} total`,
            inline: false,
          },
          {
            name: '🏆 Tournois',
            value: `${profile.tournamentWins} victoires · ${user.tournaments.length} participations`,
            inline: true,
          },
        );

      if (user.tournaments.length > 0) {
        const recentTournaments = user.tournaments
          .slice(0, 3)
          .map((tp) => {
            const placement = tp.finalPlacement
              ? tp.finalPlacement <= 3
                ? ['🥇', '🥈', '🥉'][tp.finalPlacement - 1]
                : `#${tp.finalPlacement}`
              : '⏳';
            return `${placement} ${tp.tournament.name}`;
          })
          .join('\n');

        embed.addFields({
          name: '🎯 Récents',
          value: recentTournaments,
          inline: true,
        });
      }

      const socials: string[] = [];
      if (profile.twitterHandle)
        socials.push(
          `🐦 [@${profile.twitterHandle}](https://x.com/${profile.twitterHandle})`,
        );
      if (profile.tiktokHandle)
        socials.push(
          `🎵 [@${profile.tiktokHandle}](https://tiktok.com/@${profile.tiktokHandle})`,
        );
      if (socials.length > 0) {
        embed.addFields({
          name: '📱 Réseaux',
          value: socials.join(' · '),
          inline: false,
        });
      }

      embed
        .setFooter({
          text: `${RPB.FullName} · Membre depuis ${user.createdAt.toLocaleDateString('fr-FR')}`,
        })
        .setTimestamp();

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`battle-challenge-${targetUser.id}`)
          .setLabel('Défier en combat')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('⚔️'),
        new ButtonBuilder()
          .setLabel('Voir sur le site')
          .setURL(`https://rpbey.fr/profile/${user.id}`)
          .setStyle(ButtonStyle.Link),
      );

      return interaction.editReply({ embeds: [embed], components: [row] });
    } catch (error) {
      logger.error('Profile context menu error:', error);
      return interaction.editReply({
        content:
          '❌ Erreur lors de la récupération du profil. Réessaie dans quelques instants.',
      });
    }
  }
}
