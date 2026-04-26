import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type ButtonInteraction } from "discord.js";
import { ButtonComponent, Discord } from '@rpbey/discordx';

import {
  getDeckStats,
  getRandomStats,
  runBattleSimulation,
} from '../lib/battle-utils.js';
import { Colors, RPB } from '../lib/constants.js';
import { logger } from '../lib/logger.js';
import prisma from '../lib/prisma.js';
import { pendingBattles } from '../lib/state.js';

@Discord()
export class BattleButtonHandler {
  @ButtonComponent({ id: /^battle-/ })
  async handleBattleButton(interaction: ButtonInteraction) {
    const [, action, param] = interaction.customId.split('-');

    // Dispatch based on action
    switch (action) {
      case 'accept':
        return this.handleAccept(interaction, param);
      case 'decline':
        return this.handleDecline(interaction, param);
      case 'rematch':
        return this.handleRematch(interaction, param);
      case 'challenge':
        return this.handleChallenge(interaction, param);
      case 'stats':
        return this.handleStats(interaction);
      case 'random':
        return this.handleRandom(interaction, param);
      default:
        return interaction.reply({
          content: '❌ Action inconnue.',
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  private async handleAccept(
    interaction: ButtonInteraction,
    challengerId: string,
  ) {
    const battle = pendingBattles.get(challengerId);

    if (!battle) {
      return interaction.reply({
        content: "❌ Ce défi a expiré ou n'existe plus.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.user.id !== battle.opponentId) {
      return interaction.reply({
        content: "❌ Ce défi n'est pas pour toi !",
        flags: MessageFlags.Ephemeral,
      });
    }

    pendingBattles.delete(challengerId);

    const challenger = await interaction.client.users
      .fetch(challengerId)
      .catch(() => null);

    if (!challenger) {
      return interaction.reply({
        content: "❌ Le challenger n'a pas pu être trouvé.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const [statsA, statsB] = await Promise.all([
      getDeckStats(challenger.id),
      getDeckStats(interaction.user.id),
    ]);

    if (!statsA || !statsB) {
      const embed = new EmbedBuilder()
        .setTitle('⚠️ Decks manquants')
        .setDescription(
          `L'un des joueurs (ou les deux) n'a pas de deck actif.\nVoulez-vous lancer un **Combat Aléatoire** ?`,
        )
        .setColor(Colors.Warning);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`battle-random-${challenger.id}`)
          .setLabel('🎲 Combat Aléatoire')
          .setStyle(ButtonStyle.Primary),
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    await interaction.update({
      content: null,
      embeds: [
        new EmbedBuilder()
          .setTitle('⚔️ Combat Beyblade !')
          .setDescription(
            `**${challenger.displayName}** VS **${interaction.user.displayName}**\n\n` +
              '🌀 3... 2... 1... **LET IT RIP !**',
          )
          .setColor(Colors.Secondary)
          .setFooter({ text: RPB.FullName }),
      ],
      components: [],
    });

    await this.sleep(2500);

    return runBattleSimulation(
      interaction,
      challenger,
      interaction.user,
      statsA,
      statsB,
    );
  }

  private async handleRandom(interaction: ButtonInteraction, targetId: string) {
    const target = await interaction.client.users
      .fetch(targetId)
      .catch(() => null);
    if (!target)
      return interaction.reply({
        content: '❌ Erreur joueur introuvable.',
        flags: MessageFlags.Ephemeral,
      });

    const statsA = getRandomStats();
    const statsB = getRandomStats();

    await interaction.update({
      content: null,
      embeds: [
        new EmbedBuilder()
          .setTitle('🎲 Combat Aléatoire !')
          .setDescription(
            `**${interaction.user.displayName}** VS **${target.displayName}**\n\n` +
              'Génération de combos aléatoires...\n' +
              '🌀 3... 2... 1... **LET IT RIP !**',
          )
          .setColor(Colors.Secondary),
      ],
      components: [],
    });

    await this.sleep(2000);
    return runBattleSimulation(
      interaction,
      interaction.user,
      target,
      statsA,
      statsB,
    );
  }

  private async handleDecline(
    interaction: ButtonInteraction,
    challengerId: string,
  ) {
    const battle = pendingBattles.get(challengerId);

    if (!battle) {
      return interaction.reply({
        content: "❌ Ce défi a expiré ou n'existe plus.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.user.id !== battle.opponentId) {
      return interaction.reply({
        content: "❌ Ce défi n'est pas pour toi !",
        flags: MessageFlags.Ephemeral,
      });
    }

    pendingBattles.delete(challengerId);

    const embed = new EmbedBuilder()
      .setTitle('😔 Défi refusé')
      .setDescription(`**${interaction.user.displayName}** a refusé le combat.`)
      .setColor(Colors.Error)
      .setTimestamp();

    return interaction.update({ embeds: [embed], components: [] });
  }

  private async handleRematch(
    interaction: ButtonInteraction,
    challengerId: string,
  ) {
    const opponent = await interaction.client.users
      .fetch(challengerId)
      .catch(() => null);

    if (!opponent) {
      return interaction.reply({
        content: "❌ Impossible de trouver l'adversaire.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (opponent.id === interaction.user.id) {
      return interaction.reply({
        content: '❌ Tu ne peux pas te défier toi-même !',
        flags: MessageFlags.Ephemeral,
      });
    }

    pendingBattles.set(interaction.user.id, {
      opponentId: opponent.id,
      channelId: interaction.channelId,
      timestamp: Date.now(),
    });

    setTimeout(
      () => {
        pendingBattles.delete(interaction.user.id);
      },
      5 * 60 * 1000,
    );

    const embed = new EmbedBuilder()
      .setTitle('🔄 Demande de revanche !')
      .setDescription(
        `**${interaction.user.displayName}** veut une revanche contre **${opponent.displayName}** !\n\n` +
          `${opponent}, acceptes-tu le défi ?`,
      )
      .setColor(Colors.Secondary)
      .setFooter({ text: 'Le défi expire dans 5 minutes' })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`battle-accept-${interaction.user.id}`)
        .setLabel('Accepter')
        .setStyle(ButtonStyle.Success)
        .setEmoji('⚔️'),
      new ButtonBuilder()
        .setCustomId(`battle-decline-${interaction.user.id}`)
        .setLabel('Refuser')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌'),
    );

    return interaction.reply({ embeds: [embed], components: [row] });
  }

  private async handleChallenge(
    interaction: ButtonInteraction,
    opponentId: string,
  ) {
    const opponent = await interaction.client.users
      .fetch(opponentId)
      .catch(() => null);

    if (!opponent) {
      return interaction.reply({
        content: '❌ Impossible de trouver cet adversaire.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (opponent.id === interaction.user.id) {
      return interaction.reply({
        content: '❌ Tu ne peux pas te battre contre toi-même !',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (opponent.bot) {
      return interaction.reply({
        content: '❌ Tu ne peux pas défier un bot !',
        flags: MessageFlags.Ephemeral,
      });
    }

    pendingBattles.set(interaction.user.id, {
      opponentId: opponent.id,
      channelId: interaction.channelId,
      timestamp: Date.now(),
    });

    setTimeout(
      () => {
        pendingBattles.delete(interaction.user.id);
      },
      5 * 60 * 1000,
    );

    const embed = new EmbedBuilder()
      .setTitle('⚔️ Défi Beyblade !')
      .setDescription(
        `**${interaction.user.displayName}** défie **${opponent.displayName}** en combat !\n\n` +
          `${opponent}, acceptes-tu le défi ?`,
      )
      .setColor(Colors.Secondary)
      .setThumbnail(interaction.user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: '🎯 Challenger', value: interaction.user.tag, inline: true },
        { name: '🎮 Adversaire', value: opponent.tag, inline: true },
      )
      .setFooter({ text: `${RPB.FullName} | Le défi expire dans 5 minutes` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`battle-accept-${interaction.user.id}`)
        .setLabel('Accepter le défi')
        .setStyle(ButtonStyle.Success)
        .setEmoji('⚔️'),
      new ButtonBuilder()
        .setCustomId(`battle-decline-${interaction.user.id}`)
        .setLabel('Refuser')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌'),
    );

    return interaction.reply({ embeds: [embed], components: [row] });
  }

  private async handleStats(interaction: ButtonInteraction) {
    const targetId = interaction.customId.split('-')[2] || interaction.user.id;

    try {
      const profile = await prisma.profile.findFirst({
        where: { user: { discordId: targetId } },
        include: { user: true },
      });

      if (!profile) {
        return interaction.reply({
          content:
            "❌ Ce blader n'a pas encore de profil enregistré. Utilise `/inscription rejoindre` pour créer ton profil !",
          flags: MessageFlags.Ephemeral,
        });
      }

      const totalBattles = profile.wins + profile.losses;
      const winRate =
        totalBattles > 0
          ? ((profile.wins / totalBattles) * 100).toFixed(1)
          : '0';

      const embed = new EmbedBuilder()
        .setTitle(
          `📊 Stats de Blader : ${profile.bladerName || profile.user.name}`,
        )
        .setColor(Colors.Primary)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          { name: '🏆 Victoires', value: `${profile.wins}`, inline: true },
          { name: '💔 Défaites', value: `${profile.losses}`, inline: true },
          { name: '📈 Winrate', value: `${winRate}%`, inline: true },
          {
            name: '🎖️ Tournois gagnés',
            value: `${profile.tournamentWins}`,
            inline: true,
          },
          {
            name: '✨ Expérience',
            value: profile.experience,
            inline: true,
          },
        )
        .setFooter({ text: RPB.FullName })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (error) {
      logger.error('Failed to fetch blader stats:', error);
      return interaction.reply({
        content: '❌ Erreur lors de la récupération des statistiques.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
