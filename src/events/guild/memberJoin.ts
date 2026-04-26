import { AttachmentBuilder, EmbedBuilder, type TextChannel } from 'discord.js';
import { type ArgsOf, Discord, On } from '@rpbey/discordx';

import { generateWelcomeImage } from '../../lib/canvas-utils.js';
import { getTemplate } from '../../lib/cms.js';
import { Colors, RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';

@Discord()
export class MemberJoinListener {
  // Dedup: prevent sending multiple welcome messages for the same member
  private static recentJoins = new Set<string>();

  @On({ event: 'guildMemberAdd' })
  async onMemberJoin([member]: ArgsOf<'guildMemberAdd'>) {
    // Skip if we already processed this member recently (dedup against rapid re-fires)
    if (MemberJoinListener.recentJoins.has(member.id)) {
      logger.warn(
        `[Welcome] Duplicate guildMemberAdd for ${member.user.tag}, skipping`,
      );
      return;
    }
    MemberJoinListener.recentJoins.add(member.id);
    setTimeout(() => MemberJoinListener.recentJoins.delete(member.id), 30_000);

    logger.info(`Nouveau membre: ${member.user.tag} sur ${member.guild.name}`);

    // Auto-assign Blader role
    try {
      await member.roles.add(RPB.Roles.Blader);
      logger.info(`[AutoRole] Blader role assigned to ${member.user.tag}`);
    } catch (err) {
      logger.error(
        `[AutoRole] Failed to assign Blader role to ${member.user.tag}:`,
        err,
      );
    }

    let attachmentItems: AttachmentBuilder[] = [];
    let hasImage = false;

    try {
      const avatarUrl = member.displayAvatarURL({
        extension: 'png',
        size: 256,
        forceStatic: true,
      });
      const imageBuffer = await generateWelcomeImage(
        member.displayName,
        avatarUrl,
        member.guild.memberCount,
      );
      attachmentItems = [
        new AttachmentBuilder(imageBuffer, { name: 'welcome.png' }),
      ];
      hasImage = true;
    } catch (err) {
      logger.error(
        'Failed to generate welcome image, falling back to text:',
        err,
      );
    }

    const findChannel = (search: string) =>
      member.guild.channels.cache.find(
        (c) =>
          c.id === search ||
          (c.name &&
            c.name.toLowerCase().replace(/[^a-z0-9]/g, '') ===
              search.toLowerCase().replace(/[^a-z0-9]/g, '')),
      ) as TextChannel | undefined;

    let welcomeChannel = findChannel(RPB.Channels.Welcome);

    if (!welcomeChannel?.isTextBased()) {
      welcomeChannel = member.guild.systemChannel as TextChannel;
    }

    if (!welcomeChannel?.isTextBased()) {
      logger.warn(`No welcome channel found for ${member.guild.name}`);
      return;
    }

    const rulesChannel = findChannel(RPB.Channels.Rules);
    const rolesChannel = findChannel(RPB.Channels.Roles);
    const generalChannel = findChannel(RPB.Channels.GeneralChat);

    const getMention = (
      channel: { id: string } | undefined,
      fallback: string,
    ) => (channel?.id ? `<#${channel.id}>` : fallback);

    const defaultTemplate =
      `Bienvenue {member} dans la **${RPB.FullName}** !\n\n` +
      `📜 Lis le ${getMention(rulesChannel, '#règlement')} pour connaître les règles\n` +
      `🎭 Récupère tes rôles dans ${getMention(rolesChannel, '#rôles')}\n` +
      `💬 Viens discuter dans ${getMention(generalChannel, '#chat-general')}\n\n` +
      `**Let it rip !** 🌀`;

    const template = await getTemplate('bot-welcome-text', defaultTemplate);
    const description = template
      .replace('{member}', member.toString())
      .replace('{guild}', RPB.FullName)
      .replace('{rules}', getMention(rulesChannel, '#règlement'))
      .replace('{roles}', getMention(rolesChannel, '#rôles'))
      .replace('{general}', getMention(generalChannel, '#chat-general'));

    const embed = new EmbedBuilder()
      .setTitle('🌀 Bienvenue à la RPB !')
      .setDescription(description)
      .setColor(Colors.Primary)
      .addFields(
        { name: '👤 Membre', value: member.user.tag, inline: true },
        {
          name: '🔢 Membre #',
          value: `${member.guild.memberCount}`,
          inline: true,
        },
      )
      .setFooter({
        text: RPB.FullName,
        iconURL: member.guild.iconURL() ?? undefined,
      })
      .setTimestamp();

    if (hasImage) {
      embed.setImage('attachment://welcome.png');
    }

    try {
      await welcomeChannel.send({
        content: `Bienvenue ${member.toString()} !`,
        embeds: [embed],
        files: attachmentItems,
      });
      logger.info(
        `Welcome message sent to ${welcomeChannel.name} for ${member.user.tag}`,
      );
    } catch (error) {
      logger.error('CRITICAL: Failed to send welcome message:', error);
    }
  }
}
