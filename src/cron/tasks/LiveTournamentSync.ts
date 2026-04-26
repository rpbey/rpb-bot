import {
  getUnderwayTournaments,
  scrapeAndSyncTournament,
} from '../../lib/challonge-sync.js';
import { logger } from '../../lib/logger.js';

export async function liveTournamentSyncTask() {
  logger.info('[Cron] Vérification des tournois en cours...');

  try {
    const tournaments = await getUnderwayTournaments();

    if (tournaments.length === 0) {
      logger.info('[Cron] Aucun tournoi en cours');
      return;
    }

    logger.info(
      `[Cron] ${tournaments.length} tournoi(s) en cours à synchroniser`,
    );

    for (const t of tournaments) {
      const target = t.challongeUrl || t.challongeId;
      if (!target) continue;

      logger.info(`[Cron] Scraping ${target}...`);

      const result = await scrapeAndSyncTournament(target);

      if (result.success) {
        logger.info(
          `[Cron] Sync ${t.challongeId}: ${result.participantsCount} participants, ${result.matchesCount} matchs, ${result.standingsCount} standings, ${result.stationsCount} stations, ${result.logEntriesCount} log`,
        );
      } else {
        logger.warn(`[Cron] Échec sync ${t.challongeId}: ${result.error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    logger.info('[Cron] Sync live terminé.');
  } catch (error) {
    logger.error('[Cron] Erreur sync live:', error);
  }
}
