import { EmbedBuilder } from 'discord.js';

import { getTemplate } from '../../lib/cms.js';
import { Colors, RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';

export async function tournamentReminderTask() {
  logger.info('[Cron] Running tournament reminder check...');

  try {
    const tomorrow = new Date();
    tomorrow.setHours(tomorrow.getHours() + 24);

    const upcomingTournaments = await prisma.tournament.findMany({
      where: {
        date: {
          gte: new Date(),
          lte: tomorrow,
        },
        status: {
          in: ['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'UPCOMING'],
        },
      },
      include: {
        participants: {
          include: {
            user: true,
          },
        },
      },
    });

    const defaultTemplate =
      `Le tournoi commence dans **{hours} heure(s)** !\n\n` +
      `📅 **Date:** {date}\n` +
      `📍 **Lieu:** {location}\n` +
      `👥 **Participants:** {participants}`;

    const template = await getTemplate(
      'bot-reminder-template',
      defaultTemplate,
    );

    for (const tournament of upcomingTournaments) {
      const hoursUntil = Math.round(
        (tournament.date.getTime() - Date.now()) / (1000 * 60 * 60),
      );

      if (hoursUntil === 24 || hoursUntil === 6 || hoursUntil === 1) {
        const description = template
          .replace('{hours}', String(hoursUntil))
          .replace('{name}', tournament.name)
          .replace('{date}', tournament.date.toLocaleString('fr-FR'))
          .replace('{location}', tournament.location ?? 'En ligne')
          .replace('{participants}', String(tournament.participants.length));

        const _embed = new EmbedBuilder()
          .setTitle(`⏰ Rappel Tournoi - ${tournament.name}`)
          .setDescription(description)
          .setColor(hoursUntil <= 1 ? Colors.Error : Colors.Warning)
          .setFooter({ text: `${RPB.FullName} | N'oublie pas ton check-in !` })
          .setTimestamp();

        logger.info(
          `[Cron] Sent reminder for tournament ${tournament.name} (${hoursUntil}h)`,
        );
      }
    }
  } catch (error) {
    logger.error('[Cron] Tournament reminder error:', error);
  }
}
