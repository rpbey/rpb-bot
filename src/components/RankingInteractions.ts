import { MessageFlags, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";
import { ButtonComponent, Discord, SelectMenuComponent } from "@rpbey/discordx";

import { logger } from "../lib/logger.js";
import {
  decodeAction,
  defaultSeasonKey,
  renderRankingPanel,
  type RankingVariant,
} from "../lib/ranking-panel.js";

@Discord()
export class RankingInteractions {
  @ButtonComponent({ id: /^rnk:(page|variant|season):/ })
  async onButton(interaction: ButtonInteraction) {
    const decoded = decodeAction(interaction.customId);
    if (!decoded) {
      return interaction.reply({
        content: "❌ Action inconnue.",
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      await interaction.deferUpdate();
      const { embed, file, components } = await renderRankingPanel(decoded.state);
      await interaction.editReply({
        embeds: [embed],
        files: [file],
        components,
      });
    } catch (err) {
      logger.error("[RankingInteractions] button error:", err);
      await interaction
        .followUp({
          content: "❌ Erreur lors de la mise à jour du classement.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }

  @SelectMenuComponent({ id: /^rnk:(variant|season):/ })
  async onSelect(interaction: StringSelectMenuInteraction) {
    const decoded = decodeAction(interaction.customId);
    if (!decoded) {
      return interaction.reply({
        content: "❌ Action inconnue.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const picked = interaction.values[0];
    if (!picked) return interaction.deferUpdate();

    try {
      await interaction.deferUpdate();

      let nextState = { ...decoded.state, page: 0 };
      if (decoded.action === "variant") {
        const variant = picked as RankingVariant;
        nextState = {
          variant,
          season: await defaultSeasonKey(variant),
          page: 0,
        };
      } else {
        nextState = { ...nextState, season: picked };
      }

      const { embed, file, components } = await renderRankingPanel(nextState);
      await interaction.editReply({
        embeds: [embed],
        files: [file],
        components,
      });
    } catch (err) {
      logger.error("[RankingInteractions] select error:", err);
      await interaction
        .followUp({
          content: "❌ Erreur lors du changement de sélection.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
}
