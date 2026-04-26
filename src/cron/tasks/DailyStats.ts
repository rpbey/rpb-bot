import { EmbedBuilder, type TextChannel } from 'discord.js';

import { bot } from '../../lib/bot.js';
import { Colors, RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';

export async function dailyStatsTask() {
  logger.info('[Cron] Running daily stats report...');

  try {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const [
      newUsers,
      totalUsers,
      activeTournaments,
      completedTournamentsToday,
      totalParticipations,
    ] = await Promise.all([
      prisma.user.count({
        where: {
          createdAt: { gte: yesterday },
        },
      }),
      prisma.user.count(),
      prisma.tournament.count({
        where: {
          status: { in: ['REGISTRATION_OPEN', 'UNDERWAY', 'CHECKIN'] },
        },
      }),
      prisma.tournament.count({
        where: {
          status: 'COMPLETE',
          updatedAt: { gte: yesterday },
        },
      }),
      prisma.tournamentParticipant.count(),
    ]);

    const embed = new EmbedBuilder()
      .setTitle('📊 Rapport Quotidien RPB')
      .setDescription(`Statistiques du ${now.toLocaleDateString('fr-FR')}`)
      .setColor(Colors.Info)
      .addFields(
        {
          name: '👥 Nouveaux utilisateurs (24h)',
          value: `+${newUsers}`,
          inline: true,
        },
        {
          name: '📈 Total utilisateurs',
          value: totalUsers.toString(),
          inline: true,
        },
        {
          name: '🏆 Tournois actifs',
          value: activeTournaments.toString(),
          inline: true,
        },
        {
          name: '✅ Tournois terminés (24h)',
          value: completedTournamentsToday.toString(),
          inline: true,
        },
        {
          name: '🎮 Participations totales',
          value: totalParticipations.toString(),
          inline: true,
        },
      )
      .setFooter({ text: RPB.FullName })
      .setTimestamp();

    const channelId = process.env.BOT_CHANNEL_ID;
    if (channelId) {
      const channel = await bot.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({ embeds: [embed] });
      }
    }

    logger.info('[Cron] Daily stats report sent');
  } catch (error) {
    logger.error('[Cron] Daily stats error:', error);
  }
}
