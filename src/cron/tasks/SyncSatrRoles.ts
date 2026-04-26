import { bot } from "../../lib/bot.js";
import { logger } from "../../lib/logger.js";
import prisma from "../../lib/prisma.js";

// ID du rôle "Top 10 SATR" sur le Discord
const SATR_TOP_10_ROLE_ID = "1472023878858440847";

export async function syncSatrRolesTask() {
  logger.info("[Cron] Synchronisation des rôles SATR...");

  const guildId = process.env.GUILD_ID;
  if (!guildId) return;

  try {
    const guild = await bot.guilds.fetch(guildId);
    if (!guild) return;

    // 1. Récupérer le Top 10 actuel de la Saison 2
    // ⚠️ Filtrer par season sinon rank=1 collisionne entre S1 et S2.
    const top10 = await prisma.satrRanking.findMany({
      where: { season: 2 },
      orderBy: { rank: "asc" },
      take: 10,
    });

    const members = await guild.members.fetch();
    const top10PlayerNames = top10.map((r) => r.playerName.toLowerCase());

    logger.info(`[Cron] Mise à jour du rôle Top 10 pour ${top10PlayerNames.length} joueurs.`);

    for (const [_id, member] of members) {
      const isTop10 = top10PlayerNames.some(
        (name) =>
          member.user.username.toLowerCase() === name ||
          member.displayName.toLowerCase() === name ||
          (member.nickname && member.nickname.toLowerCase() === name),
      );

      const hasRole = member.roles.cache.has(SATR_TOP_10_ROLE_ID);

      try {
        if (isTop10 && !hasRole) {
          await member.roles.add(SATR_TOP_10_ROLE_ID);
          logger.info(`[Cron] Rôle SATR Top 10 ajouté à ${member.user.tag}`);
        } else if (!isTop10 && hasRole) {
          await member.roles.remove(SATR_TOP_10_ROLE_ID);
          logger.info(`[Cron] Rôle SATR Top 10 retiré de ${member.user.tag}`);
        }
      } catch (_err) {
        // Ignorer si pas les permissions
      }
    }

    logger.info("[Cron] Synchronisation des rôles SATR terminée.");
  } catch (error) {
    logger.error("[Cron] Erreur syncSatrRolesTask:", error);
  }
}
