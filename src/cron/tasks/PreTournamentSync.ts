import {
  getTournamentsNeedingSync,
  scrapeAndSyncTournament,
} from '../../lib/challonge-sync.js';
import { logger } from '../../lib/logger.js';
import prisma from '../../lib/prisma.js';

export async function preTournamentSyncTask() {
  logger.info('[Cron] Vérification des tournois à synchroniser...');

  try {
    const tournamentIds = await getTournamentsNeedingSync();

    if (tournamentIds.length === 0) {
      logger.info('[Cron] Aucun tournoi à synchroniser');
      return;
    }

    logger.info(`[Cron] ${tournamentIds.length} tournoi(s) à synchroniser`);

    for (const challongeId of tournamentIds) {
      const t = await prisma.tournament.findUnique({
        where: { challongeId },
        select: { challongeUrl: true, challongeId: true },
      });

      const target = t?.challongeUrl || t?.challongeId || challongeId;

      logger.info(`[Cron] Scraping ${target}...`);

      const result = await scrapeAndSyncTournament(target);

      if (result.success) {
        logger.info(
          `[Cron] Sync ${challongeId}: ${result.participantsCount} participants, ${result.matchesCount} matchs`,
        );
      } else {
        logger.warn(`[Cron] Échec sync ${challongeId}: ${result.error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    logger.info('[Cron] Sync terminé.');
  } catch (error) {
    logger.error('[Cron] Erreur sync pré-tournoi:', error);
  }
}
