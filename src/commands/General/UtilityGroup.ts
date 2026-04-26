import { ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type ButtonInteraction, type CommandInteraction, type TextChannel, type User } from "discord.js";
import {
  ButtonComponent,
  Discord,
  Slash,
  SlashGroup,
  SlashOption,
} from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { Colors, RPB } from '../../lib/constants.js';
import { PrismaService } from '../../lib/prisma.js';

@Discord()
@SlashGroup({
  name: 'utilitaire',
  description: 'Commandes utilitaires pour la communauté',
})
@SlashGroup('utilitaire')
@injectable()
export class UtilityGroup {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  // ──────────────── Membre ────────────────

  @Slash({
    name: 'membre',
    description: "Afficher les informations d'un membre",
  })
  @SlashGroup('utilitaire')
  async member(
    @SlashOption({
      name: 'utilisateur',
      description: 'Le membre à inspecter',
      required: false,
      type: ApplicationCommandOptionType.User,
    })
    targetUser: User | undefined,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply();
    const target = targetUser ?? interaction.user;
    const guild = interaction.guild;
    if (!guild)
      return interaction.editReply('❌ Uniquement disponible sur un serveur.');

    const member = await guild.members.fetch(target.id).catch(() => null);
    if (!member)
      return interaction.editReply('❌ Membre introuvable sur ce serveur.');

    const dbUser = await this.prisma.user.findFirst({
      where: { discordId: target.id },
      include: { profile: true },
    });

    const createdAt = Math.floor(target.createdTimestamp / 1000);
    const joinedAt = member.joinedTimestamp
      ? Math.floor(member.joinedTimestamp / 1000)
      : null;

    const roles = member.roles.cache
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => `${r}`)
      .slice(0, 15);

    const embed = new EmbedBuilder()
      .setTitle(`👤 ${member.displayName}`)
      .setThumbnail(member.displayAvatarURL({ size: 256 }))
      .setColor(member.displayColor || Colors.Info)
      .addFields(
        {
          name: '🏷️ Tag Discord',
          value: target.tag || target.username,
          inline: true,
        },
        { name: '🆔 ID', value: target.id, inline: true },
        {
          name: '📅 Compte créé',
          value: `<t:${createdAt}:D> (<t:${createdAt}:R>)`,
          inline: false,
        },
      );

    if (joinedAt) {
      embed.addFields({
        name: '📥 A rejoint le serveur',
        value: `<t:${joinedAt}:D> (<t:${joinedAt}:R>)`,
        inline: false,
      });
    }

    if (member.premiumSince) {
      const boostTs = Math.floor(member.premiumSinceTimestamp! / 1000);
      embed.addFields({
        name: '🚀 Boost depuis',
        value: `<t:${boostTs}:D>`,
        inline: true,
      });
    }

    if (roles.length > 0) {
      embed.addFields({
        name: `🎭 Rôles (${member.roles.cache.size - 1})`,
        value: roles.join(', ') + (roles.length === 15 ? '...' : ''),
        inline: false,
      });
    }

    if (dbUser?.profile) {
      const p = dbUser.profile;
      const stats = [];
      if (p.bladerName) stats.push(`**Blader :** ${p.bladerName}`);
      if (p.wins || p.losses) stats.push(`**W/L :** ${p.wins}V / ${p.losses}D`);
      if (p.rankingPoints) stats.push(`**Points :** ${p.rankingPoints}`);
      if (stats.length > 0) {
        embed.addFields({
          name: '🌀 Profil Beyblade',
          value: stats.join('\n'),
          inline: false,
        });
      }

      // Gacha stats
      const [cardCount, totalCards] = await Promise.all([
        this.prisma.cardInventory.count({ where: { userId: dbUser.id } }),
        this.prisma.gachaCard.count({ where: { isActive: true } }),
      ]);
      const gachaLines = [];
      gachaLines.push(`**🪙 Pièces :** ${p.currency.toLocaleString('fr-FR')}`);
      if (p.dailyStreak > 0)
        gachaLines.push(
          `**🔥 Streak :** ${p.dailyStreak} jour${p.dailyStreak > 1 ? 's' : ''}`,
        );
      if (cardCount > 0) {
        const pct =
          totalCards > 0 ? Math.round((cardCount / totalCards) * 100) : 0;
        gachaLines.push(
          `**🃏 Collection :** ${cardCount}/${totalCards} (${pct}%)`,
        );
      }
      embed.addFields({
        name: '🎰 Gacha',
        value: gachaLines.join('\n'),
        inline: false,
      });
    }

    embed.setFooter({ text: RPB.Name }).setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  // ──────────────── Avatar ────────────────

  @Slash({
    name: 'avatar',
    description: "Afficher l'avatar d'un membre en grand",
  })
  @SlashGroup('utilitaire')
  async avatar(
    @SlashOption({
      name: 'utilisateur',
      description: "L'utilisateur dont voir l'avatar",
      required: false,
      type: ApplicationCommandOptionType.User,
    })
    targetUser: User | undefined,
    interaction: CommandInteraction,
  ) {
    const target = targetUser ?? interaction.user;
    const guild = interaction.guild;

    const globalAvatar = target.displayAvatarURL({ size: 4096 });

    let serverAvatar: string | null = null;
    if (guild) {
      const member = await guild.members.fetch(target.id).catch(() => null);
      if (member?.avatar) {
        serverAvatar = member.displayAvatarURL({ size: 4096 });
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`🖼️ Avatar de ${target.displayName}`)
      .setImage(serverAvatar ?? globalAvatar)
      .setColor(Colors.Info);

    if (serverAvatar && serverAvatar !== globalAvatar) {
      embed.setDescription(
        `[Avatar global](${globalAvatar}) | [Avatar serveur](${serverAvatar})`,
      );
    } else {
      embed.setDescription(`[Ouvrir en pleine taille](${globalAvatar})`);
    }

    return interaction.reply({ embeds: [embed] });
  }

  // ──────────────── Bannière ────────────────

  @Slash({
    name: 'banniere',
    description: "Afficher la bannière d'un membre",
  })
  @SlashGroup('utilitaire')
  async banner(
    @SlashOption({
      name: 'utilisateur',
      description: "L'utilisateur dont voir la bannière",
      required: false,
      type: ApplicationCommandOptionType.User,
    })
    targetUser: User | undefined,
    interaction: CommandInteraction,
  ) {
    const target = targetUser ?? interaction.user;
    // Force-fetch to get banner data
    const fetched = await target.fetch(true);
    const bannerUrl = fetched.bannerURL({ size: 4096 });

    if (!bannerUrl)
      return interaction.reply({
        content: `❌ **${target.displayName}** n'a pas de bannière.`,
        flags: MessageFlags.Ephemeral,
      });

    const embed = new EmbedBuilder()
      .setTitle(`🎨 Bannière de ${target.displayName}`)
      .setImage(bannerUrl)
      .setDescription(`[Ouvrir en pleine taille](${bannerUrl})`)
      .setColor(fetched.accentColor ?? Colors.Info);

    return interaction.reply({ embeds: [embed] });
  }

  // ──────────────── Sondage ────────────────

  @Slash({
    name: 'sondage',
    description: 'Créer un sondage pour la communauté',
  })
  @SlashGroup('utilitaire')
  async poll(
    @SlashOption({
      name: 'question',
      description: 'La question du sondage',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    question: string,
    @SlashOption({
      name: 'option1',
      description: 'Première option',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    option1: string,
    @SlashOption({
      name: 'option2',
      description: 'Deuxième option',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    option2: string,
    @SlashOption({
      name: 'option3',
      description: 'Troisième option (optionnel)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    option3: string | undefined,
    @SlashOption({
      name: 'option4',
      description: 'Quatrième option (optionnel)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    option4: string | undefined,
    @SlashOption({
      name: 'option5',
      description: 'Cinquième option (optionnel)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    option5: string | undefined,
    interaction: CommandInteraction,
  ) {
    const options = [option1, option2, option3, option4, option5].filter(
      Boolean,
    ) as string[];
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

    const description = options
      .map((opt, i) => `${emojis[i]} ${opt}`)
      .join('\n\n');

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${question}`)
      .setDescription(description)
      .setColor(Colors.Info)
      .setFooter({
        text: `Sondage par ${interaction.user.displayName} | Réagissez pour voter`,
      })
      .setTimestamp();

    await interaction.reply({ content: '✅ Sondage créé !', flags: MessageFlags.Ephemeral });
    const message = await (interaction.channel as TextChannel).send({
      embeds: [embed],
    });

    for (let i = 0; i < options.length; i++) {
      await message.react(emojis[i]!);
    }
  }

  // ──────────────── Suggestion ────────────────

  @Slash({
    name: 'suggestion',
    description: 'Soumettre une suggestion pour la communauté',
  })
  @SlashGroup('utilitaire')
  async suggestion(
    @SlashOption({
      name: 'contenu',
      description: 'Votre suggestion',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    content: string,
    interaction: CommandInteraction,
  ) {
    const guild = interaction.guild;
    if (!guild)
      return interaction.reply({
        content: '❌ Uniquement disponible sur un serveur.',
        flags: MessageFlags.Ephemeral,
      });

    const suggestionsChannel = guild.channels.cache.get(
      RPB.Channels.Suggestions,
    ) as TextChannel | undefined;

    if (!suggestionsChannel) {
      return interaction.reply({
        content: '❌ Le salon de suggestions est introuvable.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('💡 Nouvelle suggestion')
      .setDescription(content)
      .setColor(Colors.Secondary)
      .setAuthor({
        name: interaction.user.displayName,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`suggestion-up-${interaction.user.id}`)
        .setLabel('0')
        .setEmoji('👍')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`suggestion-down-${interaction.user.id}`)
        .setLabel('0')
        .setEmoji('👎')
        .setStyle(ButtonStyle.Danger),
    );

    const msg = await suggestionsChannel.send({
      embeds: [embed],
      components: [row],
    });
    await msg.startThread({
      name: `Discussion : ${content.slice(0, 80)}`,
    });

    return interaction.reply({
      content: `✅ Suggestion envoyée dans ${suggestionsChannel} !`,
      flags: MessageFlags.Ephemeral,
    });
  }

  @ButtonComponent({ id: /^suggestion-(up|down)-/ })
  async handleSuggestionVote(interaction: ButtonInteraction) {
    const [, direction] = interaction.customId.split('-') as [
      string,
      'up' | 'down',
    ];
    const message = interaction.message;

    const actionRow = message.components[0];
    if (
      !actionRow ||
      !('components' in actionRow) ||
      actionRow.components.length < 2
    )
      return;

    const upButton = actionRow.components[0]!;
    const downButton = actionRow.components[1]!;

    let upCount = Number.parseInt(
      'label' in upButton ? (upButton.label ?? '0') : '0',
      10,
    );
    let downCount = Number.parseInt(
      'label' in downButton ? (downButton.label ?? '0') : '0',
      10,
    );

    if (direction === 'up') upCount++;
    else downCount++;

    const upCustomId =
      'customId' in upButton ? upButton.customId : 'suggestion-up-unknown';
    const downCustomId =
      'customId' in downButton
        ? downButton.customId
        : 'suggestion-down-unknown';

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(upCustomId ?? 'suggestion-up')
        .setLabel(String(upCount))
        .setEmoji('👍')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(downCustomId ?? 'suggestion-down')
        .setLabel(String(downCount))
        .setEmoji('👎')
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.update({ components: [row] });
  }

  // ──────────────── Rappel ────────────────

  @Slash({
    name: 'rappel',
    description: 'Programmer un rappel personnel',
  })
  @SlashGroup('utilitaire')
  async reminder(
    @SlashOption({
      name: 'message',
      description: 'Le contenu du rappel',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    message: string,
    @SlashOption({
      name: 'minutes',
      description: 'Dans combien de minutes (défaut: 0)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
      minValue: 0,
    })
    minutes: number = 0,
    @SlashOption({
      name: 'heures',
      description: "Dans combien d'heures (défaut: 0)",
      required: false,
      type: ApplicationCommandOptionType.Integer,
      minValue: 0,
    })
    hours: number = 0,
    @SlashOption({
      name: 'jours',
      description: 'Dans combien de jours (défaut: 0)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
      minValue: 0,
      maxValue: 30,
    })
    days: number = 0,
    interaction: CommandInteraction,
  ) {
    const totalMs = (minutes * 60 + hours * 3600 + days * 86400) * 1000;

    if (totalMs === 0)
      return interaction.reply({
        content: '❌ Spécifie au moins une durée (minutes, heures ou jours).',
        flags: MessageFlags.Ephemeral,
      });

    if (totalMs > 30 * 24 * 3600 * 1000)
      return interaction.reply({
        content: '❌ Maximum 30 jours.',
        flags: MessageFlags.Ephemeral,
      });

    const expiresAt = new Date(Date.now() + totalMs);

    await this.prisma.reminder.create({
      data: {
        discordId: interaction.user.id,
        channelId: interaction.channelId,
        message,
        expiresAt,
      },
    });

    const ts = Math.floor(expiresAt.getTime() / 1000);
    return interaction.reply({
      content: `⏰ Rappel programmé pour <t:${ts}:F> (<t:${ts}:R>) :\n> ${message}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ──────────────── Embed ────────────────

  @Slash({
    name: 'embed',
    description: 'Créer un embed personnalisé',
  })
  @SlashGroup('utilitaire')
  async embed(
    @SlashOption({
      name: 'titre',
      description: "Titre de l'embed",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    title: string,
    @SlashOption({
      name: 'description',
      description: "Description de l'embed",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    description: string,
    @SlashOption({
      name: 'couleur',
      description: 'Couleur hex (ex: #FF0000) — défaut: rouge RPB',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    color: string | undefined,
    @SlashOption({
      name: 'image',
      description: "URL d'une image",
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    image: string | undefined,
    @SlashOption({
      name: 'miniature',
      description: "URL d'une miniature",
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    thumbnail: string | undefined,
    @SlashOption({
      name: 'pied',
      description: 'Texte en pied de page',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    footer: string | undefined,
    interaction: CommandInteraction,
  ) {
    const colorInt = color
      ? Number.parseInt(color.replace('#', ''), 16)
      : Colors.Primary;

    if (color && Number.isNaN(colorInt))
      return interaction.reply({
        content: '❌ Couleur invalide. Utilise le format hex (ex: #FF0000).',
        flags: MessageFlags.Ephemeral,
      });

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(colorInt)
      .setTimestamp();

    if (image) embed.setImage(image);
    if (thumbnail) embed.setThumbnail(thumbnail);
    if (footer) embed.setFooter({ text: footer });

    embed.setAuthor({
      name: interaction.user.displayName,
      iconURL: interaction.user.displayAvatarURL(),
    });

    await (interaction.channel as TextChannel).send({ embeds: [embed] });
    return interaction.reply({
      content: '✅ Embed envoyé !',
      flags: MessageFlags.Ephemeral,
    });
  }
}
