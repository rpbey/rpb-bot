import { bot } from '../../lib/bot.js';
import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';

const POINT_ROLES = [
  { points: 40000, id: '1332498533504520224' },
  { points: 30000, id: '1332498472817131530' },
  { points: 20000, id: '1332498407457161236' },
  { points: 15000, id: '1332498580665143306' },
  { points: 10000, id: '1332498339744321536' },
  { points: 1000, id: '1332498240712736851' },
];

export async function syncRankingRolesTask() {
  logger.info('[Cron] Starting ranking roles synchronization...');

  const guildId = process.env.GUILD_ID;
  if (!guildId) return;

  try {
    const guild = await bot.guilds.fetch(guildId);
    if (!guild) return;

    // Get all profiles with points
    const profiles = await prisma.profile.findMany({
      where: { rankingPoints: { gte: 1000 } },
      include: { user: { select: { discordId: true } } },
    });

    logger.info(`[Cron] Syncing roles for ${profiles.length} bladers...`);

    for (const profile of profiles) {
      if (!profile.user.discordId) continue;

      try {
        const member = await guild.members
          .fetch(profile.user.discordId)
          .catch(() => null);
        if (!member) continue;

        const currentPoints = profile.rankingPoints;
        const rolesToAdd: string[] = [];
        const rolesToRemove: string[] = [];

        for (const roleDef of POINT_ROLES) {
          const hasRole = member.roles.cache.has(roleDef.id);

          if (currentPoints >= roleDef.points) {
            if (!hasRole) rolesToAdd.push(roleDef.id);
          } else {
            if (hasRole) rolesToRemove.push(roleDef.id);
          }
        }

        if (rolesToAdd.length > 0) {
          await member.roles.add(rolesToAdd);
          logger.info(
            `[Cron] Added roles [${rolesToAdd.join(', ')}] to ${member.user.tag} (${currentPoints} pts)`,
          );
        }

        if (rolesToRemove.length > 0) {
          await member.roles.remove(rolesToRemove);
          logger.info(
            `[Cron] Removed roles [${rolesToRemove.join(', ')}] from ${member.user.tag} (${currentPoints} pts)`,
          );
        }
      } catch (err) {
        logger.error(
          `[Cron] Error syncing roles for user ${profile.user.discordId}:`,
          err,
        );
      }
    }

    logger.info('[Cron] Ranking roles synchronization complete.');
  } catch (error) {
    logger.error('[Cron] Global error in syncRankingRolesTask:', error);
  }
}
