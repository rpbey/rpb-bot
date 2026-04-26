import { ApplicationCommandOptionType, ChannelType, MessageFlags, PermissionFlagsBits, type Attachment, type CommandInteraction, type NewsChannel, type Role, type TextChannel } from "discord.js";
import {
  Discord,
  Guard,
  Slash,
  SlashChoice,
  SlashGroup,
  SlashOption,
} from '@rpbey/discordx';

import { ModeratorOnly } from '../../guards/ModeratorOnly.js';
import { getChallongeClient } from '../../lib/challonge.js';
import { RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';
import { twitchBot } from '../../lib/twitch-bot.js';

@Discord()
@SlashGroup({
  name: 'annonce',
  description: "Système d'annonces pour les tournois",
  defaultMemberPermissions: PermissionFlagsBits.ManageMessages,
})
@SlashGroup('annonce')
@Guard(ModeratorOnly)
export class AnnounceCommand {
  @Slash({ name: 'tournoi', description: 'Annonce un tournoi Challonge' })
  async tournament(
    @SlashOption({
      name: 'id',
      description: 'ID ou URL du tournoi Challonge (ex: B_TS1)',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    tournamentId: string,
    @SlashOption({
      name: 'salon',
      description: "Salon où envoyer l'annonce",
      required: false,
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    })
    channelOption: TextChannel | NewsChannel | undefined,
    @SlashOption({
      name: 'mention',
      description: 'Rôle à mentionner',
      required: false,
      type: ApplicationCommandOptionType.Role,
    })
    mentionRole: Role | undefined,
    @SlashOption({
      name: 'image',
      description: "Image à ajouter à l'annonce",
      required: false,
      type: ApplicationCommandOptionType.Attachment,
    })
    image: Attachment | undefined,
    interaction: CommandInteraction,
  ) {
    const channel =
      channelOption ?? (interaction.channel as TextChannel | NewsChannel);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const challonge = getChallongeClient();
      const [tournamentRes, participantsRes] = await Promise.all([
        challonge.getTournament(tournamentId),
        challonge.listParticipants(tournamentId),
      ]);

      const t = tournamentRes.data;
      const participantCount =
        participantsRes.data?.length ?? t.attributes.participantsCount;

      const mention = mentionRole
        ? `${mentionRole}`
        : `<@&${RPB.Roles.TournoiNotification}>`;

      const dateLine = t.attributes.startAt
        ? `📅 **Date :** <t:${Math.floor(new Date(t.attributes.startAt).getTime() / 1000)}:F> (<t:${Math.floor(new Date(t.attributes.startAt).getTime() / 1000)}:R>)`
        : '';

      const announcement = [
        mention,
        ``,
        `# 🏆 ${t.attributes.name}`,
        ``,
        t.attributes.description ?? 'Un nouveau tournoi Beyblade vous attend !',
        ``,
        `🎮 **Jeu :** ${t.attributes.gameName ?? 'Beyblade X'}`,
        `🏷️ **Format :** ${this.formatTournamentType(t.attributes.tournamentType)}`,
        `👥 **Inscrits :** ${participantCount} joueur(s)`,
        dateLine,
        ``,
        `🔗 **Inscription :** https://challonge.com/${t.attributes.url}`,
        ``,
        `**🌀 Let it rip !**`,
      ]
        .filter(Boolean)
        .join('\n');

      const sentMessage = await channel.send({
        content: announcement,
        files: image ? [{ attachment: image.url, name: image.name }] : [],
      });

      await Promise.allSettled([
        sentMessage.react('✅'),
        sentMessage.react('❌'),
        sentMessage.react('❓'),
      ]);

      if (twitchBot.chatClient?.isConnected) {
        const twitchMessage = `🏆 Annonce : Le tournoi ${t.attributes.name} est annoncé ! Inscrivez-vous : https://challonge.com/${t.attributes.url} #BeybladeX`;
        await twitchBot.announce(twitchMessage);
      }

      if (channel.type === ChannelType.GuildAnnouncement) {
        try {
          if (sentMessage.crosspostable) {
            await sentMessage.crosspost();
          }
        } catch {
          // Ignore
        }
      }

      return interaction.editReply(`✅ Annonce envoyée dans ${channel} !`);
    } catch (error) {
      logger.error('Announce tournament error:', error);
      return interaction.editReply(
        '❌ Erreur lors de la récupération du tournoi.',
      );
    }
  }

  @Slash({ name: 'rappel', description: 'Envoie un rappel pour un tournoi' })
  async reminder(
    @SlashOption({
      name: 'id',
      description: 'ID ou URL du tournoi Challonge',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    tournamentId: string,
    @SlashOption({
      name: 'message',
      description: 'Message personnalisé pour le rappel',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    customMessage: string | undefined,
    @SlashOption({
      name: 'salon',
      description: 'Salon où envoyer le rappel',
      required: false,
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    })
    channelOption: TextChannel | NewsChannel | undefined,
    @SlashOption({
      name: 'image',
      description: 'Image à ajouter au rappel',
      required: false,
      type: ApplicationCommandOptionType.Attachment,
    })
    image: Attachment | undefined,
    interaction: CommandInteraction,
  ) {
    const channel =
      channelOption ?? (interaction.channel as TextChannel | NewsChannel);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const challonge = getChallongeClient();
      const tournamentRes = await challonge.getTournament(tournamentId);
      const t = tournamentRes.data;

      const body =
        customMessage ??
        `N'oubliez pas de vous inscrire si ce n'est pas déjà fait.\nPréparez vos combos et soyez prêts à donner le meilleur de vous-même !`;

      const dateLine = t.attributes.startAt
        ? `📅 **Début :** <t:${Math.floor(new Date(t.attributes.startAt).getTime() / 1000)}:R>`
        : '';

      const announcement = [
        `# ⏰ Rappel : ${t.attributes.name}`,
        ``,
        `**Le tournoi commence bientôt !**`,
        ``,
        body,
        ``,
        `👥 **Inscrits :** ${t.attributes.participantsCount} joueur(s)`,
        `📊 **État :** ${this.formatState(t.attributes.state)}`,
        dateLine,
        ``,
        `🔗 https://challonge.com/${t.attributes.url}`,
      ]
        .filter(Boolean)
        .join('\n');

      const sentMessage = await channel.send({
        content: announcement,
        files: image ? [{ attachment: image.url, name: image.name }] : [],
      });

      await Promise.allSettled([
        sentMessage.react('✅'),
        sentMessage.react('❌'),
        sentMessage.react('❓'),
      ]);

      return interaction.editReply(`✅ Rappel envoyé dans ${channel} !`);
    } catch (error) {
      logger.error('Send reminder error:', error);
      return interaction.editReply("❌ Erreur lors de l'envoi du rappel.");
    }
  }

  @Slash({
    name: 'résultats',
    description: "Annonce les résultats d'un tournoi terminé",
  })
  async results(
    @SlashOption({
      name: 'id',
      description: 'ID ou URL du tournoi Challonge',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    tournamentId: string,
    @SlashOption({
      name: 'salon',
      description: 'Salon où envoyer les résultats',
      required: false,
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    })
    channelOption: TextChannel | NewsChannel | undefined,
    @SlashOption({
      name: 'image',
      description: 'Image à ajouter aux résultats',
      required: false,
      type: ApplicationCommandOptionType.Attachment,
    })
    image: Attachment | undefined,
    interaction: CommandInteraction,
  ) {
    const channel =
      channelOption ?? (interaction.channel as TextChannel | NewsChannel);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const challonge = getChallongeClient();
      const [tournamentRes, participantsRes] = await Promise.all([
        challonge.getTournament(tournamentId),
        challonge.listParticipants(tournamentId),
      ]);

      const t = tournamentRes.data;
      const participants = participantsRes.data ?? [];

      const ranked = participants
        .filter((p) => p.attributes.active)
        .sort((a, b) => a.attributes.seed - b.attributes.seed);

      const podium = ranked.slice(0, 3);
      const medals = ['🥇', '🥈', '🥉'];

      const podiumText = podium
        .map((p, i) => `${medals[i]} **${p.attributes.name}**`)
        .join('\n');

      const top8Lines =
        ranked.length > 3
          ? `\n**📊 Top 8 :**\n${ranked
              .slice(3, 8)
              .map((p, i) => `${i + 4}. ${p.attributes.name}`)
              .join('\n')}`
          : '';

      const announcement = [
        `# 🏆 Résultats : ${t.attributes.name}`,
        ``,
        `Le tournoi est terminé ! Voici les résultats :`,
        ``,
        podiumText,
        top8Lines,
        ``,
        `👥 **Participants :** ${participants.length}`,
        `🏷️ **Format :** ${this.formatTournamentType(t.attributes.tournamentType)}`,
        ``,
        `🔗 **Bracket complet :** https://challonge.com/${t.attributes.url}`,
        ``,
        `GG à tous ! 🎉`,
      ]
        .filter((line) => line !== undefined)
        .join('\n');

      await channel.send({
        content: announcement,
        files: image ? [{ attachment: image.url, name: image.name }] : [],
      });

      return interaction.editReply(`✅ Résultats envoyés dans ${channel} !`);
    } catch (error) {
      logger.error('Announce results error:', error);
      return interaction.editReply(
        "❌ Erreur lors de l'annonce des résultats.",
      );
    }
  }

  @Slash({ name: 'custom', description: 'Envoie une annonce personnalisée' })
  async custom(
    @SlashOption({
      name: 'titre',
      description: "Titre de l'annonce",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    title: string,
    @SlashOption({
      name: 'message',
      description: "Contenu de l'annonce",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    message: string,
    @SlashOption({
      name: 'salon',
      description: "Salon où envoyer l'annonce",
      required: false,
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    })
    channelOption: TextChannel | NewsChannel | undefined,
    @SlashOption({
      name: 'mention',
      description: 'Rôle à mentionner',
      required: false,
      type: ApplicationCommandOptionType.Role,
    })
    mentionRole: Role | undefined,
    @SlashChoice({ name: '🔴 Rouge RPB', value: 'dc2626' })
    @SlashChoice({ name: '🟡 Or RPB', value: 'fbbf24' })
    @SlashChoice({ name: '🟢 Succès', value: '22c55e' })
    @SlashChoice({ name: '🔵 Info', value: '3b82f6' })
    @SlashChoice({ name: '🟣 Beyblade', value: '8b5cf6' })
    @SlashOption({
      name: 'couleur',
      description: 'Couleur de la barre latérale (thème)',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    _colorHex: string = 'dc2626',
    @SlashOption({
      name: 'image',
      description: "Image à ajouter à l'annonce",
      required: false,
      type: ApplicationCommandOptionType.Attachment,
    })
    image: Attachment | undefined,
    interaction: CommandInteraction,
  ) {
    const channel =
      channelOption ?? (interaction.channel as TextChannel | NewsChannel);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const mention = mentionRole ? `${mentionRole}\n\n` : '';

    const announcement = [
      mention ? mention.trim() : null,
      `# 📢 ${title}`,
      ``,
      message,
    ]
      .filter((line) => line !== null)
      .join('\n');

    const sentMessage = await channel.send({
      content: announcement,
      files: image ? [{ attachment: image.url, name: image.name }] : [],
    });

    await Promise.allSettled([
      sentMessage.react('✅'),
      sentMessage.react('❌'),
      sentMessage.react('❓'),
    ]);

    if (channel.type === ChannelType.GuildAnnouncement) {
      try {
        if (sentMessage.crosspostable) {
          await sentMessage.crosspost();
        }
      } catch {
        // Ignore
      }
    }

    return interaction.editReply(`✅ Annonce envoyée dans ${channel} !`);
  }

  @Slash({
    name: 'générer',
    description: 'Génère une annonce officielle style RPB',
  })
  async generate(
    @SlashOption({
      name: 'nom',
      description: 'Nom du tournoi (ex: Bey-Tamashii Series #2)',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    nom: string,
    @SlashOption({
      name: 'date',
      description: 'Date du tournoi (ex: Dimanche 15 février 2026)',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    date: string,
    @SlashOption({
      name: 'heure',
      description: 'Heure de début (ex: 14h00)',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    heure: string,
    @SlashOption({
      name: 'lieu',
      description: 'Lieu du tournoi',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    lieu: string,
    @SlashOption({
      name: 'challonge',
      description: 'Lien ou ID Challonge',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    challonge: string,
    @SlashChoice({
      name: '3on3 Double Élimination',
      value: '3on3 classique en Double Élimination',
    })
    @SlashChoice({
      name: '3on3 Simple Élimination',
      value: '3on3 en Simple Élimination',
    })
    @SlashChoice({
      name: '1on1 Double Élimination',
      value: '1on1 en Double Élimination',
    })
    @SlashChoice({ name: 'Round Robin', value: 'Round Robin' })
    @SlashOption({
      name: 'format',
      description: 'Format du tournoi',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    format: string = '3on3 classique en Double Élimination',
    @SlashOption({
      name: 'places',
      description: 'Nombre de places max (ex: 64)',
      required: false,
      type: ApplicationCommandOptionType.Integer,
      minValue: 8,
      maxValue: 256,
    })
    places: number = 64,
    @SlashOption({
      name: 'checkin',
      description: "Heure d'ouverture check-in (ex: 13h00)",
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    checkin: string | undefined,
    @SlashOption({
      name: 'intro',
      description: "Texte d'introduction personnalisé",
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    customIntro: string | undefined,
    @SlashOption({
      name: 'salon',
      description: 'Salon où envoyer',
      required: false,
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    })
    channelOption: TextChannel | NewsChannel | undefined,
    @SlashOption({
      name: 'preview',
      description: 'Aperçu sans envoyer (défaut: true)',
      required: false,
      type: ApplicationCommandOptionType.Boolean,
    })
    preview: boolean = true,
    @SlashOption({
      name: 'image',
      description: "Image à ajouter à l'annonce",
      required: false,
      type: ApplicationCommandOptionType.Attachment,
    })
    image: Attachment | undefined,
    interaction: CommandInteraction,
  ) {
    const channel =
      channelOption ?? (interaction.channel as TextChannel | NewsChannel);

    const challongeUrl = challonge.startsWith('http')
      ? challonge
      : `https://challonge.com/${challonge}`;

    const defaultIntro =
      `La **${RPB.FullName}** continue d'écrire son histoire ! ` +
      `Après des mois d'attente et de préparation, nous sommes fiers de vous annoncer ` +
      `le prochain chapitre de notre saga...`;

    const intro = customIntro ?? defaultIntro;

    const announcement = [
      `<@&${RPB.Roles.TournoiNotification}>`,
      ``,
      `# 🚨 ANNONCE OFFICIELLE 🚨`,
      ``,
      intro,
      ``,
      `# 🏆 ${nom}`,
      ``,
      `| 📋 | Détails |`,
      `|-----|---------|`,
      `| 📅 **Date** | ${date} |`,
      `| ⏰ **Heure** | ${heure}${checkin ? ` (Check-in dès ${checkin})` : ''} |`,
      `| 📍 **Lieu** | ${lieu} |`,
      `| 🎮 **Format** | ${format} |`,
      `| 👥 **Places** | ${places} joueurs maximum |`,
      `| 🔗 **Inscription** | [Challonge](${challongeUrl}) |`,
      ``,
      `## 💥 3, 2, 1... Hyper Vitesse !`,
      ``,
      `Préparez vos combos, affûtez vos techniques, et montrez à la communauté de quoi vous êtes capable !`,
      ``,
      `---`,
      ``,
      `📱 **Suivez-nous :**`,
      `> 💬 Discord : https://discord.gg/rpb`,
      `> 🎵 TikTok : @rpb_beyblade`,
      `> 🐦 X/Twitter : @RPB_Beyblade`,
      ``,
      `*La suite ? Vous n'êtes pas prêts... 👀*`,
    ].join('\n');

    if (preview) {
      const previewText = [
        `### Aperçu de l'annonce :`,
        `**Salon :** ${channel}`,
        `**Caractères :** ${announcement.length}/2000`,
        ``,
        announcement,
      ].join('\n');

      await interaction.reply({
        content: previewText,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const sentMessage = await channel.send({
        content: announcement,
        files: image ? [{ attachment: image.url, name: image.name }] : [],
      });

      await Promise.allSettled([
        sentMessage.react('✅'),
        sentMessage.react('❌'),
        sentMessage.react('❓'),
      ]);

      if (
        channel.type === ChannelType.GuildAnnouncement &&
        sentMessage.crosspostable
      ) {
        try {
          await sentMessage.crosspost();
        } catch {
          // Ignore
        }
      }

      return interaction.editReply(
        `✅ Annonce envoyée dans ${channel} !\n[Voir le message](${sentMessage.url})`,
      );
    } catch (error) {
      logger.error('Generate announcement error:', error);
      return interaction.editReply("❌ Erreur lors de l'envoi de l'annonce.");
    }
  }

  private formatTournamentType(type: string): string {
    const types: Record<string, string> = {
      'single elimination': 'Simple Élimination',
      'double elimination': 'Double Élimination',
      'round robin': 'Round Robin',
      swiss: 'Swiss',
    };
    return types[type] ?? type;
  }

  private formatState(state: string): string {
    const states: Record<string, string> = {
      pending: '🟡 En attente',
      underway: '🟢 En cours',
      complete: '✅ Terminé',
      checking_in: '📋 Check-in',
    };
    return states[state] ?? state;
  }
}
