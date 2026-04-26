import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  type Guild,
  type GuildTextBasedChannel,
} from 'discord.js';
import { type ArgsOf, Discord, On } from '@rpbey/discordx';
import { injectable } from 'tsyringe';

import { Colors } from '../lib/constants.js';
import { logger } from '../lib/logger.js';

const AUDIT_LOG_DELAY = 1500;

@Discord()
@injectable()
export class AdvancedLogs {
  private getLogChannel(guild: Guild) {
    const logChannelId = process.env.LOG_CHANNEL_ID;
    if (!logChannelId) return null;
    return guild.channels.cache.get(logChannelId) as
      | GuildTextBasedChannel
      | undefined;
  }

  private async sendLog(channel: GuildTextBasedChannel, embed: EmbedBuilder) {
    await channel
      .send({ embeds: [embed] })
      .catch((err) => logger.error('[AdvancedLogs] Failed to send log:', err));
  }

  /** Fetch the most recent audit log entry of the given type targeting the given user. */
  private async fetchAuditEntry(
    guild: Guild,
    type: AuditLogEvent,
    targetId: string,
  ) {
    try {
      await new Promise((r) => setTimeout(r, AUDIT_LOG_DELAY));
      const logs = await guild.fetchAuditLogs({ type, limit: 5 });
      return (
        logs.entries.find(
          (e) => e.target && 'id' in e.target && e.target.id === targetId,
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  // ──────────────── Member Update ────────────────

  @On({ event: 'guildMemberUpdate' })
  async onMemberUpdate([oldMember, newMember]: ArgsOf<'guildMemberUpdate'>) {
    const channel = this.getLogChannel(newMember.guild);
    if (!channel) return;

    // Role additions
    const addedRoles = newMember.roles.cache.filter(
      (r) => !oldMember.roles.cache.has(r.id),
    );
    if (addedRoles.size > 0) {
      const roleList = addedRoles.map((r) => `<@&${r.id}>`).join(', ');
      const entry = await this.fetchAuditEntry(
        newMember.guild,
        AuditLogEvent.MemberRoleUpdate,
        newMember.id,
      );
      const embed = new EmbedBuilder()
        .setTitle('🛡️ Rôle(s) Ajouté(s)')
        .setDescription(`${roleList} ajouté(s) à ${newMember}`)
        .setColor(Colors.Success)
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .setTimestamp();
      if (entry?.executor) {
        embed.setFooter({
          text: `Par ${entry.executor.tag}`,
          iconURL: entry.executor.displayAvatarURL(),
        });
      }
      await this.sendLog(channel, embed);
    }

    // Role removals
    const removedRoles = oldMember.roles.cache.filter(
      (r) => !newMember.roles.cache.has(r.id) && r.id !== newMember.guild.id,
    );
    if (removedRoles.size > 0) {
      const roleList = removedRoles.map((r) => `<@&${r.id}>`).join(', ');
      const entry = await this.fetchAuditEntry(
        newMember.guild,
        AuditLogEvent.MemberRoleUpdate,
        newMember.id,
      );
      const embed = new EmbedBuilder()
        .setTitle('🛡️ Rôle(s) Retiré(s)')
        .setDescription(`${roleList} retiré(s) de ${newMember}`)
        .setColor(Colors.Warning)
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .setTimestamp();
      if (entry?.executor) {
        embed.setFooter({
          text: `Par ${entry.executor.tag}`,
          iconURL: entry.executor.displayAvatarURL(),
        });
      }
      await this.sendLog(channel, embed);
    }

    // Boost
    if (!oldMember.premiumSince && newMember.premiumSince) {
      const embed = new EmbedBuilder()
        .setTitle('🚀 Nouveau Boost !')
        .setDescription(`Merci ${newMember} pour le boost du serveur ! 💎`)
        .setColor(0xff73fa)
        .setThumbnail(newMember.user.displayAvatarURL())
        .setTimestamp();
      await channel
        .send({ content: '🎉🚀🎉', embeds: [embed] })
        .catch(() => null);
    }

    // Boost removed
    if (oldMember.premiumSince && !newMember.premiumSince) {
      const embed = new EmbedBuilder()
        .setTitle('💔 Boost Retiré')
        .setDescription(`${newMember} a retiré son boost du serveur.`)
        .setColor(Colors.Warning)
        .setTimestamp();
      await this.sendLog(channel, embed);
    }

    // Nickname change
    if (oldMember.nickname !== newMember.nickname) {
      const entry = await this.fetchAuditEntry(
        newMember.guild,
        AuditLogEvent.MemberUpdate,
        newMember.id,
      );
      const selfChange = !entry?.executor || entry.executor.id === newMember.id;
      const embed = new EmbedBuilder()
        .setTitle('✏️ Pseudo Modifié')
        .setDescription(
          `**Membre :** ${newMember}\n**Avant :** ${oldMember.nickname || '*aucun*'}\n**Après :** ${newMember.nickname || '*aucun*'}`,
        )
        .setColor(Colors.Info)
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .setTimestamp();
      if (!selfChange && entry?.executor) {
        embed.setFooter({
          text: `Modifié par ${entry.executor.tag}`,
          iconURL: entry.executor.displayAvatarURL(),
        });
      }
      await this.sendLog(channel, embed);
    }

    // Timeout (mute)
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
    const newTimeout = newMember.communicationDisabledUntilTimestamp;
    if (!oldTimeout && newTimeout && newTimeout > Date.now()) {
      const entry = await this.fetchAuditEntry(
        newMember.guild,
        AuditLogEvent.MemberUpdate,
        newMember.id,
      );
      const until = Math.floor(newTimeout / 1000);
      const embed = new EmbedBuilder()
        .setTitle('🔇 Membre Mute (Timeout)')
        .setDescription(
          `**Membre :** ${newMember}\n**Expire :** <t:${until}:R>`,
        )
        .setColor(Colors.Error)
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .setTimestamp();
      if (entry?.reason) {
        embed.addFields({ name: '📋 Raison', value: entry.reason });
      }
      if (entry?.executor) {
        embed.setFooter({
          text: `Par ${entry.executor.tag}`,
          iconURL: entry.executor.displayAvatarURL(),
        });
      }
      await this.sendLog(channel, embed);
    }

    // Timeout removed
    if (oldTimeout && oldTimeout > Date.now() && !newTimeout) {
      const embed = new EmbedBuilder()
        .setTitle('🔊 Timeout Levé')
        .setDescription(`**Membre :** ${newMember} peut à nouveau parler.`)
        .setColor(Colors.Success)
        .setTimestamp();
      await this.sendLog(channel, embed);
    }

    // Avatar change (server avatar)
    if (oldMember.avatar !== newMember.avatar) {
      const embed = new EmbedBuilder()
        .setTitle('🖼️ Avatar Serveur Modifié')
        .setDescription(`**Membre :** ${newMember}`)
        .setColor(Colors.Info)
        .setTimestamp();
      if (newMember.avatar) {
        embed.setThumbnail(newMember.avatarURL({ size: 256 }) ?? '');
      }
      if (oldMember.avatar) {
        embed.setImage(oldMember.avatarURL({ size: 128 }) ?? '');
      }
      await this.sendLog(channel, embed);
    }
  }

  // ──────────────── Member Join ────────────────

  @On({ event: 'guildMemberAdd' })
  async onMemberJoin([member]: ArgsOf<'guildMemberAdd'>) {
    const channel = this.getLogChannel(member.guild);
    if (!channel) return;

    const created = Math.floor(member.user.createdTimestamp / 1000);
    const accountAge = Date.now() - member.user.createdTimestamp;
    const isNewAccount = accountAge < 7 * 24 * 60 * 60 * 1000; // < 7 days

    const embed = new EmbedBuilder()
      .setTitle('📥 Membre Rejoint')
      .setDescription(`${member} (**${member.user.tag}**)`)
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setColor(Colors.Success)
      .addFields(
        {
          name: '📅 Compte créé',
          value: `<t:${created}:R>`,
          inline: true,
        },
        {
          name: '🔢 Membres',
          value: `${member.guild.memberCount}`,
          inline: true,
        },
        {
          name: '🆔 ID',
          value: `\`${member.id}\``,
          inline: true,
        },
      )
      .setTimestamp();

    if (isNewAccount) {
      embed.addFields({
        name: '⚠️ Alerte',
        value: 'Compte créé il y a moins de 7 jours',
      });
    }

    await this.sendLog(channel, embed);
  }

  // ──────────────── Member Leave / Kick ────────────────

  @On({ event: 'guildMemberRemove' })
  async onMemberLeave([member]: ArgsOf<'guildMemberRemove'>) {
    const channel = this.getLogChannel(member.guild);
    if (!channel) return;

    const roles = member.roles.cache
      .filter((r) => r.id !== member.guild.id)
      .map((r) => r.name)
      .join(', ');

    const joined = member.joinedTimestamp
      ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`
      : '*inconnu*';

    // Check if it was a kick via audit logs
    const kickEntry = await this.fetchAuditEntry(
      member.guild,
      AuditLogEvent.MemberKick,
      member.id,
    );

    const wasKicked =
      kickEntry && kickEntry.createdTimestamp > Date.now() - 5000;

    const embed = new EmbedBuilder()
      .setTitle(wasKicked ? '👢 Membre Expulsé' : '📤 Membre Parti')
      .setDescription(
        `**${member.user.tag}** ${wasKicked ? 'a été expulsé du' : 'a quitté le'} serveur.`,
      )
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setColor(wasKicked ? 0xff6b35 : Colors.Error)
      .addFields(
        {
          name: '🎭 Rôles',
          value: roles || '*aucun*',
          inline: false,
        },
        {
          name: '📅 Avait rejoint',
          value: joined,
          inline: true,
        },
        {
          name: '🔢 Membres',
          value: `${member.guild.memberCount}`,
          inline: true,
        },
      )
      .setTimestamp();

    if (wasKicked) {
      if (kickEntry.reason) {
        embed.addFields({ name: '📋 Raison', value: kickEntry.reason });
      }
      if (kickEntry.executor) {
        embed.setFooter({
          text: `Par ${kickEntry.executor.tag}`,
          iconURL: kickEntry.executor.displayAvatarURL(),
        });
      }
    }

    await this.sendLog(channel, embed);
  }

  // ──────────────── Message Delete ────────────────

  @On({ event: 'messageDelete' })
  async onMessageDelete([message]: ArgsOf<'messageDelete'>) {
    if (!message.guild || message.author?.bot) return;

    const channel = this.getLogChannel(message.guild);
    if (!channel) return;
    if (message.channelId === channel.id) return; // Don't log deletions in log channel

    const content = message.content
      ? message.content.slice(0, 1024)
      : '*contenu non disponible*';

    // Check who deleted the message
    const entry = message.author
      ? await this.fetchAuditEntry(
          message.guild,
          AuditLogEvent.MessageDelete,
          message.author.id,
        )
      : null;

    const deletedByMod =
      entry?.executor &&
      entry.executor.id !== message.author?.id &&
      entry.createdTimestamp > Date.now() - 5000;

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Message Supprimé')
      .setDescription(
        `**Auteur :** ${message.author ?? '*inconnu*'}\n**Salon :** <#${message.channelId}>`,
      )
      .setColor(Colors.Error)
      .addFields({ name: '💬 Contenu', value: content })
      .setTimestamp();

    if (message.attachments.size > 0) {
      const attachments = message.attachments
        .map((a) => `[${a.name}](${a.url})`)
        .join('\n');
      embed.addFields({
        name: `📎 Pièces jointes (${message.attachments.size})`,
        value: attachments.slice(0, 1024),
      });
    }

    if (message.stickers.size > 0) {
      embed.addFields({
        name: '🏷️ Stickers',
        value: message.stickers.map((s) => s.name).join(', '),
      });
    }

    if (deletedByMod && entry.executor) {
      embed.setFooter({
        text: `Supprimé par ${entry.executor.tag}`,
        iconURL: entry.executor.displayAvatarURL(),
      });
    }

    await this.sendLog(channel, embed);
  }

  // ──────────────── Bulk Message Delete ────────────────

  @On({ event: 'messageDeleteBulk' })
  async onBulkDelete([messages, bulkChannel]: ArgsOf<'messageDeleteBulk'>) {
    const guild = bulkChannel.guild;
    if (!guild) return;

    const logChannel = this.getLogChannel(guild);
    if (!logChannel) return;

    const authors = new Set(
      messages.filter((m) => m.author).map((m) => m.author?.tag),
    );

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Suppression en Masse')
      .setDescription(
        `**${messages.size}** messages supprimés dans <#${bulkChannel.id}>`,
      )
      .setColor(0x8b0000)
      .addFields({
        name: '👤 Auteurs concernés',
        value: [...authors].slice(0, 20).join(', ') || '*inconnus*',
      })
      .setTimestamp();

    await this.sendLog(logChannel, embed);
  }

  // ──────────────── Message Edit ────────────────

  @On({ event: 'messageUpdate' })
  async onMessageUpdate([oldMessage, newMessage]: ArgsOf<'messageUpdate'>) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (oldMessage.content === newMessage.content) return;

    const channel = this.getLogChannel(newMessage.guild);
    if (!channel) return;

    const before = oldMessage.content
      ? oldMessage.content.slice(0, 1024)
      : '*non disponible*';
    const after = newMessage.content
      ? newMessage.content.slice(0, 1024)
      : '*non disponible*';

    const embed = new EmbedBuilder()
      .setTitle('✏️ Message Modifié')
      .setDescription(
        `**Auteur :** ${newMessage.author}\n**Salon :** <#${newMessage.channelId}> — [Voir le message](${newMessage.url})`,
      )
      .setColor(Colors.Warning)
      .addFields(
        { name: '📝 Avant', value: before },
        { name: '📝 Après', value: after },
      )
      .setTimestamp();

    await this.sendLog(channel, embed);
  }

  // ──────────────── Ban / Unban ────────────────

  @On({ event: 'guildBanAdd' })
  async onBan([ban]: ArgsOf<'guildBanAdd'>) {
    const channel = this.getLogChannel(ban.guild);
    if (!channel) return;

    const entry = await this.fetchAuditEntry(
      ban.guild,
      AuditLogEvent.MemberBanAdd,
      ban.user.id,
    );

    const reason = entry?.reason ?? ban.reason ?? '*non spécifiée*';

    const embed = new EmbedBuilder()
      .setTitle('🔨 Membre Banni')
      .setDescription(`**${ban.user.tag}** a été banni du serveur.`)
      .setThumbnail(ban.user.displayAvatarURL({ size: 256 }))
      .setColor(Colors.Error)
      .addFields(
        { name: '📋 Raison', value: reason },
        { name: '🆔 ID', value: `\`${ban.user.id}\``, inline: true },
      )
      .setTimestamp();

    if (entry?.executor) {
      embed.setFooter({
        text: `Par ${entry.executor.tag}`,
        iconURL: entry.executor.displayAvatarURL(),
      });
    }

    await this.sendLog(channel, embed);
  }

  @On({ event: 'guildBanRemove' })
  async onUnban([ban]: ArgsOf<'guildBanRemove'>) {
    const channel = this.getLogChannel(ban.guild);
    if (!channel) return;

    const entry = await this.fetchAuditEntry(
      ban.guild,
      AuditLogEvent.MemberBanRemove,
      ban.user.id,
    );

    const embed = new EmbedBuilder()
      .setTitle('🔓 Membre Débanni')
      .setDescription(`**${ban.user.tag}** a été débanni du serveur.`)
      .setThumbnail(ban.user.displayAvatarURL({ size: 256 }))
      .setColor(Colors.Success)
      .addFields({
        name: '🆔 ID',
        value: `\`${ban.user.id}\``,
        inline: true,
      })
      .setTimestamp();

    if (entry?.executor) {
      embed.setFooter({
        text: `Par ${entry.executor.tag}`,
        iconURL: entry.executor.displayAvatarURL(),
      });
    }

    await this.sendLog(channel, embed);
  }

  // ──────────────── Voice State ────────────────

  @On({ event: 'voiceStateUpdate' })
  async onVoiceState([oldState, newState]: ArgsOf<'voiceStateUpdate'>) {
    const guild = newState.guild;
    const channel = this.getLogChannel(guild);
    if (!channel) return;
    if (newState.member?.user.bot) return;

    const member = newState.member ?? oldState.member;
    if (!member) return;

    // Joined a voice channel
    if (!oldState.channelId && newState.channelId) {
      const embed = new EmbedBuilder()
        .setTitle('🔊 Connexion Vocale')
        .setDescription(`${member} a rejoint <#${newState.channelId}>`)
        .setColor(Colors.Success)
        .setTimestamp();
      await this.sendLog(channel, embed);
      return;
    }

    // Left a voice channel
    if (oldState.channelId && !newState.channelId) {
      const embed = new EmbedBuilder()
        .setTitle('🔇 Déconnexion Vocale')
        .setDescription(`${member} a quitté <#${oldState.channelId}>`)
        .setColor(Colors.Error)
        .setTimestamp();
      await this.sendLog(channel, embed);
      return;
    }

    // Moved between channels
    if (
      oldState.channelId &&
      newState.channelId &&
      oldState.channelId !== newState.channelId
    ) {
      const embed = new EmbedBuilder()
        .setTitle('🔀 Déplacement Vocal')
        .setDescription(
          `${member} a été déplacé\n<#${oldState.channelId}> → <#${newState.channelId}>`,
        )
        .setColor(Colors.Info)
        .setTimestamp();
      await this.sendLog(channel, embed);
      return;
    }

    // Server mute / deafen by moderator
    if (!oldState.serverMute && newState.serverMute) {
      const embed = new EmbedBuilder()
        .setTitle('🔇 Mute Serveur')
        .setDescription(`${member} a été mute par un modérateur.`)
        .setColor(Colors.Warning)
        .setTimestamp();
      await this.sendLog(channel, embed);
    } else if (oldState.serverMute && !newState.serverMute) {
      const embed = new EmbedBuilder()
        .setTitle('🔊 Unmute Serveur')
        .setDescription(`${member} a été unmute.`)
        .setColor(Colors.Success)
        .setTimestamp();
      await this.sendLog(channel, embed);
    }

    if (!oldState.serverDeaf && newState.serverDeaf) {
      const embed = new EmbedBuilder()
        .setTitle('🔇 Sourdine Serveur')
        .setDescription(`${member} a été mis en sourdine par un modérateur.`)
        .setColor(Colors.Warning)
        .setTimestamp();
      await this.sendLog(channel, embed);
    } else if (oldState.serverDeaf && !newState.serverDeaf) {
      const embed = new EmbedBuilder()
        .setTitle('🔊 Sourdine Levée')
        .setDescription(`La sourdine de ${member} a été levée.`)
        .setColor(Colors.Success)
        .setTimestamp();
      await this.sendLog(channel, embed);
    }
  }

  // ──────────────── Channel Events ────────────────

  @On({ event: 'channelCreate' })
  async onChannelCreate([ch]: ArgsOf<'channelCreate'>) {
    if (!ch.guild) return;
    const logChannel = this.getLogChannel(ch.guild);
    if (!logChannel) return;

    const typeLabel = this.channelTypeLabel(ch.type);
    const entry = await this.fetchAuditEntry(
      ch.guild,
      AuditLogEvent.ChannelCreate,
      ch.id,
    );

    const embed = new EmbedBuilder()
      .setTitle('📁 Salon Créé')
      .setDescription(`**${ch.name}** (${typeLabel})`)
      .setColor(Colors.Success)
      .addFields({ name: '🆔 ID', value: `\`${ch.id}\``, inline: true })
      .setTimestamp();

    if ('parent' in ch && ch.parent) {
      embed.addFields({
        name: '📂 Catégorie',
        value: ch.parent.name,
        inline: true,
      });
    }

    if (entry?.executor) {
      embed.setFooter({
        text: `Par ${entry.executor.tag}`,
        iconURL: entry.executor.displayAvatarURL(),
      });
    }

    await this.sendLog(logChannel, embed);
  }

  @On({ event: 'channelDelete' })
  async onChannelDelete([ch]: ArgsOf<'channelDelete'>) {
    if (!('guild' in ch) || !ch.guild) return;
    const logChannel = this.getLogChannel(ch.guild);
    if (!logChannel) return;

    const typeLabel = this.channelTypeLabel(ch.type);
    const entry = await this.fetchAuditEntry(
      ch.guild,
      AuditLogEvent.ChannelDelete,
      ch.id,
    );

    const embed = new EmbedBuilder()
      .setTitle('📁 Salon Supprimé')
      .setDescription(`**${ch.name}** (${typeLabel})`)
      .setColor(Colors.Error)
      .setTimestamp();

    if (entry?.executor) {
      embed.setFooter({
        text: `Par ${entry.executor.tag}`,
        iconURL: entry.executor.displayAvatarURL(),
      });
    }

    await this.sendLog(logChannel, embed);
  }

  // ──────────────── Role Events ────────────────

  @On({ event: 'roleCreate' })
  async onRoleCreate([role]: ArgsOf<'roleCreate'>) {
    const logChannel = this.getLogChannel(role.guild);
    if (!logChannel) return;

    const entry = await this.fetchAuditEntry(
      role.guild,
      AuditLogEvent.RoleCreate,
      role.id,
    );

    const embed = new EmbedBuilder()
      .setTitle('🏷️ Rôle Créé')
      .setDescription(`**${role.name}**`)
      .setColor(role.color || Colors.Info)
      .addFields(
        { name: '🎨 Couleur', value: role.hexColor, inline: true },
        { name: '🆔 ID', value: `\`${role.id}\``, inline: true },
      )
      .setTimestamp();

    if (entry?.executor) {
      embed.setFooter({
        text: `Par ${entry.executor.tag}`,
        iconURL: entry.executor.displayAvatarURL(),
      });
    }

    await this.sendLog(logChannel, embed);
  }

  @On({ event: 'roleDelete' })
  async onRoleDelete([role]: ArgsOf<'roleDelete'>) {
    const logChannel = this.getLogChannel(role.guild);
    if (!logChannel) return;

    const entry = await this.fetchAuditEntry(
      role.guild,
      AuditLogEvent.RoleDelete,
      role.id,
    );

    const embed = new EmbedBuilder()
      .setTitle('🏷️ Rôle Supprimé')
      .setDescription(`**${role.name}**`)
      .setColor(Colors.Error)
      .setTimestamp();

    if (entry?.executor) {
      embed.setFooter({
        text: `Par ${entry.executor.tag}`,
        iconURL: entry.executor.displayAvatarURL(),
      });
    }

    await this.sendLog(logChannel, embed);
  }

  @On({ event: 'roleUpdate' })
  async onRoleUpdate([oldRole, newRole]: ArgsOf<'roleUpdate'>) {
    const logChannel = this.getLogChannel(newRole.guild);
    if (!logChannel) return;

    const changes: string[] = [];
    if (oldRole.name !== newRole.name) {
      changes.push(`**Nom :** ${oldRole.name} → ${newRole.name}`);
    }
    if (oldRole.hexColor !== newRole.hexColor) {
      changes.push(`**Couleur :** ${oldRole.hexColor} → ${newRole.hexColor}`);
    }
    if (oldRole.hoist !== newRole.hoist) {
      changes.push(
        `**Affiché séparément :** ${oldRole.hoist ? 'Oui' : 'Non'} → ${newRole.hoist ? 'Oui' : 'Non'}`,
      );
    }
    if (oldRole.mentionable !== newRole.mentionable) {
      changes.push(
        `**Mentionnable :** ${oldRole.mentionable ? 'Oui' : 'Non'} → ${newRole.mentionable ? 'Oui' : 'Non'}`,
      );
    }
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
      changes.push('**Permissions modifiées**');
    }

    if (changes.length === 0) return;

    const entry = await this.fetchAuditEntry(
      newRole.guild,
      AuditLogEvent.RoleUpdate,
      newRole.id,
    );

    const embed = new EmbedBuilder()
      .setTitle('🏷️ Rôle Modifié')
      .setDescription(`<@&${newRole.id}>\n\n${changes.join('\n')}`)
      .setColor(newRole.color || Colors.Info)
      .setTimestamp();

    if (entry?.executor) {
      embed.setFooter({
        text: `Par ${entry.executor.tag}`,
        iconURL: entry.executor.displayAvatarURL(),
      });
    }

    await this.sendLog(logChannel, embed);
  }

  // ──────────────── Thread Events ────────────────

  @On({ event: 'threadCreate' })
  async onThreadCreate([thread]: ArgsOf<'threadCreate'>) {
    if (!thread.guild) return;
    const logChannel = this.getLogChannel(thread.guild);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
      .setTitle('🧵 Thread Créé')
      .setDescription(`**${thread.name}** dans <#${thread.parentId}>`)
      .setColor(Colors.Success)
      .setTimestamp();

    if (thread.ownerId) {
      embed.addFields({
        name: '👤 Créé par',
        value: `<@${thread.ownerId}>`,
        inline: true,
      });
    }

    await this.sendLog(logChannel, embed);
  }

  @On({ event: 'threadDelete' })
  async onThreadDelete([thread]: ArgsOf<'threadDelete'>) {
    if (!thread.guild) return;
    const logChannel = this.getLogChannel(thread.guild);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
      .setTitle('🧵 Thread Supprimé')
      .setDescription(`**${thread.name}**`)
      .setColor(Colors.Error)
      .setTimestamp();

    await this.sendLog(logChannel, embed);
  }

  // ──────────────── Emoji / Sticker Events ────────────────

  @On({ event: 'emojiCreate' })
  async onEmojiCreate([emoji]: ArgsOf<'emojiCreate'>) {
    if (!emoji.guild) return;
    const logChannel = this.getLogChannel(emoji.guild);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
      .setTitle('😀 Emoji Ajouté')
      .setDescription(`**${emoji.name}** — ${emoji}`)
      .setThumbnail(emoji.url)
      .setColor(Colors.Success)
      .setTimestamp();

    await this.sendLog(logChannel, embed);
  }

  @On({ event: 'emojiDelete' })
  async onEmojiDelete([emoji]: ArgsOf<'emojiDelete'>) {
    if (!emoji.guild) return;
    const logChannel = this.getLogChannel(emoji.guild);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
      .setTitle('😀 Emoji Supprimé')
      .setDescription(`**${emoji.name}**`)
      .setColor(Colors.Error)
      .setTimestamp();

    await this.sendLog(logChannel, embed);
  }

  // ──────────────── Helpers ────────────────

  private channelTypeLabel(type: ChannelType): string {
    const labels: Partial<Record<ChannelType, string>> = {
      [ChannelType.GuildText]: 'Texte',
      [ChannelType.GuildVoice]: 'Vocal',
      [ChannelType.GuildCategory]: 'Catégorie',
      [ChannelType.GuildAnnouncement]: 'Annonces',
      [ChannelType.GuildStageVoice]: 'Stage',
      [ChannelType.GuildForum]: 'Forum',
      [ChannelType.GuildMedia]: 'Média',
    };
    return labels[type] ?? 'Autre';
  }
}
