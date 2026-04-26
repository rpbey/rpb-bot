import { ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits, type ButtonInteraction, type CommandInteraction, type TextChannel } from "discord.js";
import {
  ButtonComponent,
  Discord,
  Slash,
  SlashGroup,
  SlashOption,
} from '@rpbey/discordx';
import { injectable } from 'tsyringe';

import { Colors } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';

interface GiveawayData {
  messageId: string;
  channelId: string;
  prize: string;
  hostId: string;
  endsAt: number;
  winners: number;
  participants: Set<string>;
  timer: NodeJS.Timeout;
}

const activeGiveaways = new Map<string, GiveawayData>();

function pickWinners(participants: Set<string>, count: number): string[] {
  const arr = [...participants];
  const winners: string[] = [];
  const available = [...arr];
  for (let i = 0; i < Math.min(count, available.length); i++) {
    const idx = Math.floor(Math.random() * available.length);
    winners.push(available.splice(idx, 1)[0]!);
  }
  return winners;
}

@Discord()
@SlashGroup({
  name: 'tirage',
  description: 'Système de giveaways pour la communauté',
  defaultMemberPermissions: PermissionFlagsBits.ManageMessages,
})
@SlashGroup('tirage')
@injectable()
export class GiveawayCommand {
  @Slash({ name: 'créer', description: 'Lancer un nouveau giveaway' })
  @SlashGroup('tirage')
  async create(
    @SlashOption({
      name: 'prix',
      description: 'Le prix à gagner',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    prize: string,
    @SlashOption({
      name: 'durée',
      description: 'Durée en minutes (1-10080)',
      required: true,
      type: ApplicationCommandOptionType.Integer,
      minValue: 1,
      maxValue: 10080,
    })
    durationMinutes: number,
    @SlashOption({
      name: 'gagnants',
      description: 'Nombre de gagnants (défaut: 1)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
      minValue: 1,
      maxValue: 10,
    })
    winnersCount: number = 1,
    interaction: CommandInteraction,
  ) {
    const channel = interaction.channel as TextChannel;
    if (!channel)
      return interaction.reply({
        content: '❌ Commande uniquement dans un salon texte.',
        flags: MessageFlags.Ephemeral,
      });

    const endsAt = Date.now() + durationMinutes * 60 * 1000;
    const endsAtTimestamp = Math.floor(endsAt / 1000);

    const embed = new EmbedBuilder()
      .setTitle('🎁 GIVEAWAY')
      .setDescription(
        [
          `**${prize}**`,
          '',
          `🏆 **${winnersCount}** gagnant${winnersCount > 1 ? 's' : ''}`,
          `⏰ Fin : <t:${endsAtTimestamp}:R> (<t:${endsAtTimestamp}:F>)`,
          `🎫 Participants : **0**`,
          '',
          'Cliquez sur 🎉 pour participer !',
        ].join('\n'),
      )
      .setColor(Colors.Secondary)
      .setFooter({
        text: `Organisé par ${interaction.user.displayName}`,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('giveaway-join')
        .setLabel('Participer')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Success),
    );

    await interaction.reply({
      content: '✅ Giveaway lancé !',
      flags: MessageFlags.Ephemeral,
    });

    const message = await channel.send({
      embeds: [embed],
      components: [row],
    });

    const timer = setTimeout(
      () => this.endGiveaway(message.id),
      durationMinutes * 60 * 1000,
    );

    activeGiveaways.set(message.id, {
      messageId: message.id,
      channelId: channel.id,
      prize,
      hostId: interaction.user.id,
      endsAt,
      winners: winnersCount,
      participants: new Set(),
      timer,
    });
  }

  @Slash({
    name: 'fin',
    description: 'Terminer un giveaway immédiatement',
  })
  @SlashGroup('tirage')
  async end(
    @SlashOption({
      name: 'message_id',
      description: 'ID du message du giveaway',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    messageId: string,
    interaction: CommandInteraction,
  ) {
    const giveaway = activeGiveaways.get(messageId);
    if (!giveaway) {
      return interaction.reply({
        content: '❌ Aucun giveaway actif trouvé avec cet ID.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply({
      content: '✅ Giveaway terminé !',
      flags: MessageFlags.Ephemeral,
    });
    await this.endGiveaway(messageId);
  }

  @Slash({ name: 'liste', description: 'Voir les giveaways en cours' })
  @SlashGroup('tirage')
  async list(interaction: CommandInteraction) {
    if (activeGiveaways.size === 0) {
      return interaction.reply({
        content: '📭 Aucun giveaway en cours.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('🎁 Giveaways en cours')
      .setColor(Colors.Secondary);

    for (const [id, g] of activeGiveaways) {
      const endsAt = Math.floor(g.endsAt / 1000);
      embed.addFields({
        name: g.prize,
        value: [
          `🎫 ${g.participants.size} participant${g.participants.size > 1 ? 's' : ''}`,
          `⏰ Fin <t:${endsAt}:R>`,
          `📋 ID: \`${id}\``,
        ].join('\n'),
        inline: true,
      });
    }

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  @ButtonComponent({ id: 'giveaway-join' })
  async handleJoin(interaction: ButtonInteraction) {
    const giveaway = activeGiveaways.get(interaction.message.id);
    if (!giveaway) {
      return interaction.reply({
        content: '❌ Ce giveaway est terminé.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (giveaway.participants.has(interaction.user.id)) {
      giveaway.participants.delete(interaction.user.id);
      await this.updateParticipantCount(interaction, giveaway);
      return interaction.reply({
        content: '🚪 Vous avez quitté le giveaway.',
        flags: MessageFlags.Ephemeral,
      });
    }

    giveaway.participants.add(interaction.user.id);
    await this.updateParticipantCount(interaction, giveaway);

    return interaction.reply({
      content: '🎉 Vous participez au giveaway !',
      flags: MessageFlags.Ephemeral,
    });
  }

  private async updateParticipantCount(
    interaction: ButtonInteraction,
    giveaway: GiveawayData,
  ) {
    const embed = EmbedBuilder.from(interaction.message.embeds[0]!);
    const desc = embed.data.description ?? '';
    const updated = desc.replace(
      /🎫 Participants : \*\*\d+\*\*/,
      `🎫 Participants : **${giveaway.participants.size}**`,
    );
    embed.setDescription(updated);
    await interaction.message.edit({ embeds: [embed] });
  }

  private async endGiveaway(messageId: string) {
    const giveaway = activeGiveaways.get(messageId);
    if (!giveaway) return;

    clearTimeout(giveaway.timer);
    activeGiveaways.delete(messageId);

    try {
      const { bot: botClient } = await import('../../lib/bot.js');
      const channel = (await botClient.channels.fetch(
        giveaway.channelId,
      )) as TextChannel;
      const message = await channel.messages.fetch(giveaway.messageId);

      const winners = pickWinners(giveaway.participants, giveaway.winners);

      const embed = EmbedBuilder.from(message.embeds[0]!);
      embed.setColor(Colors.Error);

      if (winners.length === 0) {
        embed.setDescription(
          [
            `**${giveaway.prize}**`,
            '',
            '😢 Aucun participant... pas de gagnant.',
          ].join('\n'),
        );
      } else {
        const winnerMentions = winners.map((id) => `<@${id}>`).join(', ');
        embed.setDescription(
          [
            `**${giveaway.prize}**`,
            '',
            `🏆 **Gagnant${winners.length > 1 ? 's' : ''} :** ${winnerMentions}`,
            `🎫 ${giveaway.participants.size} participant${giveaway.participants.size > 1 ? 's' : ''}`,
          ].join('\n'),
        );
      }

      embed.setTitle('🎁 GIVEAWAY TERMINÉ');

      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('giveaway-ended')
          .setLabel('Terminé')
          .setEmoji('🔒')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      );

      await message.edit({ embeds: [embed], components: [disabledRow] });

      if (winners.length > 0) {
        const winnerMentions = winners.map((id) => `<@${id}>`).join(', ');
        await channel.send(
          `🎉 Félicitations ${winnerMentions} ! Vous avez gagné **${giveaway.prize}** !`,
        );
      }
    } catch (e) {
      logger.error('[Giveaway] Error ending giveaway:', e);
    }
  }
}
