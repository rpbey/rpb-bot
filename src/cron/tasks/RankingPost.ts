import { type TextChannel } from "discord.js";

import { bot } from "../../lib/bot.js";
import { logger } from "../../lib/logger.js";
import {
  defaultSeasonKey,
  type RankingVariant,
  renderRankingPanel,
} from "../../lib/ranking-panel.js";

const CLASSEMENT_CHANNEL_ID = "1489804785430302851";

const VARIANT_ORDER: RankingVariant[] = ["rpb", "satr", "wb"];

/**
 * Post les 3 panneaux de classement (RPB / BBT / UB) dans #classement.
 *
 * Utilise `renderRankingPanel` pour être 100% aligné avec ce que
 * renvoie `/classement top` (même embed, même card, mêmes components
 * interactifs — select variant, select saison, pagination).
 */
export async function rankingPostTask() {
  logger.info("[Cron] Posting rankings to #classement...");

  try {
    const channel = await bot.channels.fetch(CLASSEMENT_CHANNEL_ID);
    if (!channel?.isTextBased()) {
      logger.warn("[Cron] Classement channel not found");
      return;
    }
    const textChannel = channel as TextChannel;

    // Purge messages précédents du bot pour que le salon reste lisible.
    try {
      const messages = await textChannel.messages.fetch({ limit: 20 });
      const botMessages = messages.filter((m) => m.author.id === bot.user?.id);
      if (botMessages.size > 0) {
        await textChannel.bulkDelete(botMessages, true).catch(() => {
          botMessages.forEach((m) => {
            m.delete().catch(() => {});
          });
        });
      }
    } catch {
      /* best effort */
    }

    for (const variant of VARIANT_ORDER) {
      try {
        const season = await defaultSeasonKey(variant);
        const { embed, file, components } = await renderRankingPanel({
          variant,
          season,
          page: 0,
        });

        await textChannel.send({
          embeds: [embed],
          files: [file],
          components,
        });
      } catch (e) {
        logger.error(`[Cron] Failed to post ${variant} panel:`, e);
      }
    }

    logger.info("[Cron] Rankings posted to #classement");
  } catch (error) {
    logger.error("[Cron] Ranking post error:", error);
  }
}
