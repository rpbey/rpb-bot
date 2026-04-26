import { ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, type ButtonInteraction, type CommandInteraction, type TextChannel, type User } from "discord.js";
import { createTranscript } from 'discord-html-transcripts';
import {
  ButtonComponent,
  Discord,
  Slash,
  SlashChoice,
  SlashOption,
} from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { Colors, RPB } from '../../lib/constants.js';
import { PrismaService } from '../../lib/prisma.js';

@Discord()
@injectable()
export class ModerationCommands {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  // ──────────────── Clear ────────────────

  @Slash({
    name: 'clear',
    description: 'Supprimer un nombre de messages',
    defaultMemberPermissions: PermissionFlagsBits.ManageMessages,
  })
  async clear(
    @SlashOption({
      name: 'nombre',
      description: 'Nombre de messages (1-100)',
      required: true,
      type: ApplicationCommandOptionType.Integer,
      minValue: 1,
      maxValue: 100,
    })
    amount: number,
    interaction: CommandInteraction,
  ) {
    const channel = interaction.channel as TextChannel;
    if (!channel)
      return interaction.reply({
        content: '❌ Salon texte uniquement.',
        flags: MessageFlags.Ephemeral,
      });
    await channel.bulkDelete(amount);
    return interaction.reply({
      content: `✅ **${amount}** messages supprimés.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ──────────────── Ban ────────────────

  @Slash({
    name: 'ban',
    description: 'Bannir un membre du serveur',
    defaultMemberPermissions: PermissionFlagsBits.BanMembers,
  })
  async ban(
    @SlashOption({
      name: 'cible',
      description: 'Le membre à bannir',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: User,
    @SlashOption({
      name: 'raison',
      description: 'Raison du ban',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    reason: string = 'Aucune raison spécifiée',
    interaction: CommandInteraction,
  ) {
    if (target.id === interaction.user.id)
      return interaction.reply({
        content: '❌ Tu ne peux pas te bannir toi-même.',
        flags: MessageFlags.Ephemeral,
      });
    if (target.bot)
      return interaction.reply({
        content: '❌ Impossible de bannir un bot via cette commande.',
        flags: MessageFlags.Ephemeral,
      });
    const member = await interaction.guild?.members
      .fetch(target.id)
      .catch(() => null);
    if (member && !member.bannable)
      return interaction.reply({
        content:
          '❌ Impossible de bannir ce membre (rôle trop élevé ou permissions insuffisantes).',
        flags: MessageFlags.Ephemeral,
      });
    await interaction.guild?.members.ban(target, { reason });
    return interaction.reply(
      `🔨 **${target.tag}** a été banni. Raison : ${reason}`,
    );
  }

  // ──────────────── Unban ────────────────

  @Slash({
    name: 'unban',
    description: 'Débannir un utilisateur du serveur',
    defaultMemberPermissions: PermissionFlagsBits.BanMembers,
  })
  async unban(
    @SlashOption({
      name: 'id',
      description: "L'ID Discord de l'utilisateur à débannir",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    userId: string,
    @SlashOption({
      name: 'raison',
      description: 'Raison du débannissement',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    reason: string = 'Aucune raison spécifiée',
    interaction: CommandInteraction,
  ) {
    const guild = interaction.guild;
    if (!guild)
      return interaction.reply({
        content: '❌ Commande serveur uniquement.',
        flags: MessageFlags.Ephemeral,
      });

    const ban = await guild.bans.fetch(userId).catch(() => null);
    if (!ban)
      return interaction.reply({
        content: "❌ Cet utilisateur n'est pas banni.",
        flags: MessageFlags.Ephemeral,
      });

    await guild.members.unban(userId, reason);
    return interaction.reply(
      `✅ **${ban.user.tag}** a été débanni. Raison : ${reason}`,
    );
  }

  // ──────────────── Kick ────────────────

  @Slash({
    name: 'kick',
    description: 'Expulser un membre du serveur',
    defaultMemberPermissions: PermissionFlagsBits.KickMembers,
  })
  async kick(
    @SlashOption({
      name: 'cible',
      description: 'Le membre à expulser',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: User,
    @SlashOption({
      name: 'raison',
      description: "Raison de l'expulsion",
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    reason: string = 'Aucune raison spécifiée',
    interaction: CommandInteraction,
  ) {
    if (target.id === interaction.user.id)
      return interaction.reply({
        content: "❌ Tu ne peux pas t'expulser toi-même.",
        flags: MessageFlags.Ephemeral,
      });
    const member = await interaction.guild?.members
      .fetch(target.id)
      .catch(() => null);
    if (!member?.kickable)
      return interaction.reply({
        content: "❌ Impossible d'expulser ce membre.",
        flags: MessageFlags.Ephemeral,
      });
    await member.kick(reason);
    return interaction.reply(
      `👢 **${target.tag}** a été expulsé. Raison : ${reason}`,
    );
  }

  // ──────────────── Mute ────────────────

  @Slash({
    name: 'mute',
    description: 'Rendre muet un membre temporairement',
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async mute(
    @SlashOption({
      name: 'cible',
      description: 'Le membre à rendre muet',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: User,
    @SlashChoice({ name: '60 secondes', value: 60 * 1000 })
    @SlashChoice({ name: '5 minutes', value: 5 * 60 * 1000 })
    @SlashChoice({ name: '10 minutes', value: 10 * 60 * 1000 })
    @SlashChoice({ name: '1 heure', value: 60 * 60 * 1000 })
    @SlashChoice({ name: '1 jour', value: 24 * 60 * 60 * 1000 })
    @SlashOption({
      name: 'durée',
      description: 'Durée du mute',
      required: true,
      type: ApplicationCommandOptionType.Integer,
    })
    duration: number,
    @SlashOption({
      name: 'raison',
      description: 'Raison',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    reason: string = 'Aucune raison spécifiée',
    interaction: CommandInteraction,
  ) {
    if (target.id === interaction.user.id)
      return interaction.reply({
        content: '❌ Tu ne peux pas te mute toi-même.',
        flags: MessageFlags.Ephemeral,
      });
    const member = await interaction.guild?.members
      .fetch(target.id)
      .catch(() => null);
    if (!member?.moderatable)
      return interaction.reply({
        content:
          "❌ Impossible d'agir sur ce membre (rôle trop élevé ou introuvable).",
        flags: MessageFlags.Ephemeral,
      });
    await member.timeout(duration, reason);
    const durationLabel =
      duration >= 86400000
        ? `${duration / 86400000} jour(s)`
        : duration >= 3600000
          ? `${duration / 3600000} heure(s)`
          : `${duration / 60000} minute(s)`;
    return interaction.reply(
      `🔇 **${target.tag}** muet pendant ${durationLabel}. Raison : ${reason}`,
    );
  }

  // ──────────────── Unmute ────────────────

  @Slash({
    name: 'unmute',
    description: "Retirer le mute d'un membre",
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async unmute(
    @SlashOption({
      name: 'cible',
      description: 'Le membre à démuter',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: User,
    interaction: CommandInteraction,
  ) {
    const member = await interaction.guild?.members
      .fetch(target.id)
      .catch(() => null);
    if (!member)
      return interaction.reply({
        content: '❌ Membre introuvable.',
        flags: MessageFlags.Ephemeral,
      });
    if (!member.isCommunicationDisabled())
      return interaction.reply({
        content: "❌ Ce membre n'est pas muet.",
        flags: MessageFlags.Ephemeral,
      });
    await member.timeout(null);
    return interaction.reply(`🔊 **${target.tag}** n'est plus muet.`);
  }

  // ──────────────── Warn ────────────────

  @Slash({
    name: 'warn',
    description: 'Avertir un membre',
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async warn(
    @SlashOption({
      name: 'cible',
      description: 'Le membre à avertir',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: User,
    @SlashOption({
      name: 'raison',
      description: "Raison de l'avertissement",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    reason: string,
    interaction: CommandInteraction,
  ) {
    if (target.bot)
      return interaction.reply({
        content: "❌ Impossible d'avertir un bot.",
        flags: MessageFlags.Ephemeral,
      });

    const warning = await this.prisma.warning.create({
      data: {
        discordId: target.id,
        moderator: interaction.user.id,
        reason,
      },
    });

    const count = await this.prisma.warning.count({
      where: { discordId: target.id },
    });

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Avertissement')
      .setColor(Colors.Warning)
      .addFields(
        { name: 'Membre', value: `${target.tag} (${target.id})`, inline: true },
        {
          name: 'Modérateur',
          value: interaction.user.tag,
          inline: true,
        },
        { name: 'Raison', value: reason },
        {
          name: 'Total avertissements',
          value: `${count}`,
          inline: true,
        },
        { name: 'ID', value: warning.id, inline: true },
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // ──────────────── Warnings (list) ────────────────

  @Slash({
    name: 'warnings',
    description: "Voir les avertissements d'un membre",
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async warnings(
    @SlashOption({
      name: 'cible',
      description: 'Le membre à inspecter',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: User,
    interaction: CommandInteraction,
  ) {
    const warns = await this.prisma.warning.findMany({
      where: { discordId: target.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (warns.length === 0)
      return interaction.reply({
        content: `✅ **${target.tag}** n'a aucun avertissement.`,
        flags: MessageFlags.Ephemeral,
      });

    const lines = warns.map((w, i) => {
      const date = `<t:${Math.floor(w.createdAt.getTime() / 1000)}:d>`;
      return `**${i + 1}.** ${w.reason} — par <@${w.moderator}> ${date} \`${w.id}\``;
    });

    const embed = new EmbedBuilder()
      .setTitle(`⚠️ Avertissements de ${target.tag}`)
      .setDescription(lines.join('\n'))
      .setColor(Colors.Warning)
      .setFooter({ text: `${warns.length} avertissement(s)` });

    return interaction.reply({ embeds: [embed] });
  }

  // ──────────────── Unwarn ────────────────

  @Slash({
    name: 'unwarn',
    description: 'Retirer un avertissement par son ID',
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async unwarn(
    @SlashOption({
      name: 'id',
      description: "ID de l'avertissement",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    warningId: string,
    interaction: CommandInteraction,
  ) {
    const warning = await this.prisma.warning
      .delete({ where: { id: warningId } })
      .catch(() => null);

    if (!warning)
      return interaction.reply({
        content: '❌ Avertissement introuvable.',
        flags: MessageFlags.Ephemeral,
      });

    return interaction.reply(
      `✅ Avertissement \`${warningId}\` supprimé (était pour <@${warning.discordId}>).`,
    );
  }

  // ──────────────── Slowmode ────────────────

  @Slash({
    name: 'slowmode',
    description: "Définir le mode lent d'un salon",
    defaultMemberPermissions: PermissionFlagsBits.ManageChannels,
  })
  async slowmode(
    @SlashChoice({ name: 'Désactivé', value: 0 })
    @SlashChoice({ name: '5 secondes', value: 5 })
    @SlashChoice({ name: '10 secondes', value: 10 })
    @SlashChoice({ name: '30 secondes', value: 30 })
    @SlashChoice({ name: '1 minute', value: 60 })
    @SlashChoice({ name: '5 minutes', value: 300 })
    @SlashChoice({ name: '10 minutes', value: 600 })
    @SlashChoice({ name: '30 minutes', value: 1800 })
    @SlashChoice({ name: '1 heure', value: 3600 })
    @SlashOption({
      name: 'durée',
      description: 'Intervalle entre les messages',
      required: true,
      type: ApplicationCommandOptionType.Integer,
    })
    seconds: number,
    interaction: CommandInteraction,
  ) {
    const channel = interaction.channel as TextChannel;
    if (!channel?.isTextBased())
      return interaction.reply({
        content: '❌ Salon texte uniquement.',
        flags: MessageFlags.Ephemeral,
      });

    await channel.setRateLimitPerUser(seconds);
    const label =
      seconds === 0
        ? 'désactivé'
        : seconds >= 3600
          ? `${seconds / 3600} heure(s)`
          : seconds >= 60
            ? `${seconds / 60} minute(s)`
            : `${seconds} seconde(s)`;

    return interaction.reply(
      `🐌 Mode lent ${seconds === 0 ? 'désactivé' : `activé : **${label}**`} dans ${channel}.`,
    );
  }

  // ──────────────── Lock ────────────────

  @Slash({
    name: 'lock',
    description: 'Verrouiller un salon (empêcher les messages)',
    defaultMemberPermissions: PermissionFlagsBits.ManageChannels,
  })
  async lock(
    @SlashOption({
      name: 'raison',
      description: 'Raison du verrouillage',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    reason: string = 'Aucune raison spécifiée',
    interaction: CommandInteraction,
  ) {
    const channel = interaction.channel as TextChannel;
    const guild = interaction.guild;
    if (!channel || !guild)
      return interaction.reply({
        content: '❌ Salon texte uniquement.',
        flags: MessageFlags.Ephemeral,
      });

    await channel.permissionOverwrites.edit(guild.id, {
      SendMessages: false,
    });

    const embed = new EmbedBuilder()
      .setTitle('🔒 Salon verrouillé')
      .setDescription(
        `Ce salon a été verrouillé par ${interaction.user}.\n**Raison :** ${reason}`,
      )
      .setColor(Colors.Error)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // ──────────────── Unlock ────────────────

  @Slash({
    name: 'unlock',
    description: 'Déverrouiller un salon',
    defaultMemberPermissions: PermissionFlagsBits.ManageChannels,
  })
  async unlock(interaction: CommandInteraction) {
    const channel = interaction.channel as TextChannel;
    const guild = interaction.guild;
    if (!channel || !guild)
      return interaction.reply({
        content: '❌ Salon texte uniquement.',
        flags: MessageFlags.Ephemeral,
      });

    await channel.permissionOverwrites.edit(guild.id, {
      SendMessages: null,
    });

    const embed = new EmbedBuilder()
      .setTitle('🔓 Salon déverrouillé')
      .setDescription(`Ce salon a été déverrouillé par ${interaction.user}.`)
      .setColor(Colors.Success)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // ──────────────── Nickname ────────────────

  @Slash({
    name: 'nickname',
    description: "Changer le pseudo d'un membre",
    defaultMemberPermissions: PermissionFlagsBits.ManageNicknames,
  })
  async nickname(
    @SlashOption({
      name: 'cible',
      description: 'Le membre',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    target: User,
    @SlashOption({
      name: 'pseudo',
      description: 'Le nouveau pseudo (laisser vide pour réinitialiser)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    newNick: string | undefined,
    interaction: CommandInteraction,
  ) {
    const member = await interaction.guild?.members
      .fetch(target.id)
      .catch(() => null);
    if (!member?.manageable)
      return interaction.reply({
        content:
          '❌ Impossible de modifier ce membre (rôle trop élevé ou introuvable).',
        flags: MessageFlags.Ephemeral,
      });

    const oldNick = member.displayName;
    await member.setNickname(newNick ?? null);

    return interaction.reply(
      newNick
        ? `✅ Pseudo de **${oldNick}** changé en **${newNick}**.`
        : `✅ Pseudo de **${oldNick}** réinitialisé.`,
    );
  }

  // ──────────────── Tickets ────────────────

  @Slash({
    name: 'tickets',
    description: 'Déployer le panneau de support',
    defaultMemberPermissions: PermissionFlagsBits.ManageChannels,
  })
  async setupTickets(interaction: CommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle('🎫 Support RPB')
      .setDescription("Besoin d'aide ? Cliquez sur 📩 pour ouvrir un ticket.")
      .setColor(Colors.Primary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('create-ticket')
        .setLabel('Ouvrir un Ticket')
        .setEmoji('📩')
        .setStyle(ButtonStyle.Primary),
    );
    await (interaction.channel as TextChannel).send({
      embeds: [embed],
      components: [row],
    });
    return interaction.reply({
      content: '✅ Panneau installé.',
      flags: MessageFlags.Ephemeral,
    });
  }

  @ButtonComponent({ id: 'create-ticket' })
  async handleCreate(interaction: ButtonInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild!;
    const name = `ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    if (guild.channels.cache.find((c) => c.name === name))
      return interaction.editReply('❌ Ticket déjà ouvert.');

    const ticketChannel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: (interaction.channel as TextChannel).parentId,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
          ],
        },
        {
          id: RPB.Roles.Modo,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
          ],
        },
      ],
    });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('close-ticket')
        .setLabel('Fermer')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger),
    );
    await ticketChannel.send({
      content: `Bonjour ${interaction.user}, expliquez votre demande ici.`,
      components: [row],
    });
    return interaction.editReply(`✅ Ticket créé : ${ticketChannel}`);
  }

  @ButtonComponent({ id: 'close-ticket' })
  async handleClose(interaction: ButtonInteraction) {
    await interaction.deferReply();
    const channel = interaction.channel as TextChannel;
    const attachment = await createTranscript(channel, {
      filename: `${channel.name}.html`,
    });
    const logChannel = interaction.guild?.channels.cache.get(
      RPB.Channels.Announcements,
    ) as TextChannel;
    if (logChannel)
      await logChannel.send({
        content: `Ticket clos par ${interaction.user.tag}`,
        files: [attachment],
      });
    await channel.delete();
  }
}
