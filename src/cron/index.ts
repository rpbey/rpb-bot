import { logger } from "../lib/logger.js";
import { bbxWeeklySyncTask } from "./tasks/BbxWeeklySync.js";
import { dailyStatsTask } from "./tasks/DailyStats.js";
import { liveTournamentSyncTask } from "./tasks/LiveTournamentSync.js";
import { mentionsScanTask } from "./tasks/MentionsScan.js";
import { preTournamentSyncTask } from "./tasks/PreTournamentSync.js";
import { rankingPostTask } from "./tasks/RankingPost.js";
import { rankingSyncTask } from "./tasks/RankingSync.js";
import { sessionCleanupTask } from "./tasks/SessionCleanup.js";
import { syncRankingRolesTask } from "./tasks/SyncRankingRoles.js";
import { syncSatrRolesTask } from "./tasks/SyncSatrRoles.js";
import { tournamentReminderTask } from "./tasks/TournamentReminder.js";

/**
 * Ordonnanceur du bot RPB — Bun.cron (évaluation en UTC).
 *
 * Paris  = UTC+1 (CET, fin oct. → fin mars) / UTC+2 (CEST, fin mars → fin oct.)
 *   → on utilise CEST comme référence (majorité de l'année).
 *
 * Chaque tâche est définie une seule fois, pas de double-trigger.
 * Les tâches "sync ranking" depuis les Google Sheets sont déléguées au
 * timer systemd `rpb-ranking-sync.timer` côté VPS (15 min) qui appelle
 * `scripts/rpb/sync-satr-ranking.ts` et `sync-wb-ranking.ts`. Ici, on
 * poke l'API rpb-dashboard pour garantir un refresh immédiat post-démarrage.
 */

interface Job {
	name: string;
	cron: string;
	paris: string;
	run: () => Promise<void> | void;
	runOnBoot?: { delayMs: number };
}

function schedule(job: Job) {
	logger.info(`[Cron] ${job.name} — cron="${job.cron}" (Paris ${job.paris})`);
	Bun.cron(job.cron, () =>
		Promise.resolve(job.run()).catch((err) =>
			logger.error(`[Cron] ${job.name} failed: ${String(err)}`),
		),
	);
	if (job.runOnBoot) {
		setTimeout(() => {
			Promise.resolve(job.run()).catch((err) =>
				logger.error(`[Cron] ${job.name} (boot) failed: ${String(err)}`),
			);
		}, job.runOnBoot.delayMs);
	}
}

export function setupCronJobs() {
	logger.info("[Cron] Initializing scheduled tasks (Bun.cron, UTC).");

	// ─── Tournois ─────────────────────────────────────────────────────────
	schedule({
		name: "Live tournament sync",
		cron: "*/5 * * * *",
		paris: "toutes les 5 min",
		run: liveTournamentSyncTask,
	});

	schedule({
		name: "Pre-tournament sync (J+7 / J+1)",
		cron: "0 * * * *",
		paris: "chaque heure pleine",
		run: preTournamentSyncTask,
	});

	schedule({
		name: "Tournament reminder (24h avant)",
		cron: "30 * * * *",
		paris: "chaque heure à :30",
		run: tournamentReminderTask,
	});

	// ─── Rankings (poke l'API rpb-dashboard) ──────────────────────────────
	schedule({
		name: "Ranking sync (WB + SATR sheets)",
		cron: "*/15 * * * *",
		paris: "toutes les 15 min",
		run: rankingSyncTask,
		runOnBoot: { delayMs: 45_000 },
	});

	schedule({
		name: "Sync Discord roles (points + top 10 SATR)",
		cron: "*/30 * * * *",
		paris: "toutes les 30 min",
		run: async () => {
			await syncRankingRolesTask();
			await syncSatrRolesTask();
		},
	});

	// Disabled — leaderboard publication paused (manual `/ranking` still works).
	// schedule({
	//   name: "Post leaderboard dans #classement",
	//   cron: "0 8 * * *",
	//   paris: "10:00 CEST (= 09:00 CET)",
	//   run: rankingPostTask,
	//   runOnBoot: { delayMs: 60_000 },
	// });

	// ─── Stats / intégrations ─────────────────────────────────────────────
	schedule({
		name: "Daily stats report",
		cron: "0 7 * * *",
		paris: "09:00 CEST",
		run: dailyStatsTask,
	});

	schedule({
		name: "BBX weekly meta",
		cron: "0 16 * * 5",
		paris: "vendredi 18:00 CEST",
		run: bbxWeeklySyncTask,
	});

	schedule({
		name: "Mentions scan (analytics Discord)",
		cron: "0 */6 * * *",
		paris: "toutes les 6h",
		run: mentionsScanTask,
		runOnBoot: { delayMs: 30_000 },
	});

	// ─── Maintenance ──────────────────────────────────────────────────────
	schedule({
		name: "Session cleanup (expired auth sessions)",
		cron: "0 1 * * *",
		paris: "03:00 CEST",
		run: sessionCleanupTask,
	});

	logger.info("[Cron] Scheduled tasks ready.");
}
