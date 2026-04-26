import { EmbedBuilder, type TextChannel } from 'discord.js';
import { type ArgsOf, Discord, On } from '@rpbey/discordx';
import { Colors, RPB } from '../../lib/constants.js';
import { logger } from '../../lib/logger.js';

@Discord()
export class MemberLeaveListener {
  @On({ event: 'guildMemberRemove' })
  async onMemberLeave([member]: ArgsOf<'guildMemberRemove'>) {
    logger.info(`Membre parti : ${member.user.tag} de ${member.guild.name}`);

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
      logger.warn(
        `No welcome/departure channel found for ${member.guild.name}`,
      );
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("👋 Départ d'un Blader")
      .setDescription(
        `${member.toString()} (**${member.user.tag}**) a quitté la **${RPB.FullName}**.`,
      )
      .setColor(Colors.Error)
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .addFields({
        name: '📅 Présence',
        value: member.joinedAt
          ? `Était parmi nous depuis <t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>`
          : "Date d'arrivée inconnue",
        inline: true,
      })
      .setFooter({ text: `Total Bladers: ${member.guild.memberCount}` })
      .setTimestamp();

    try {
      await welcomeChannel.send({ embeds: [embed] });
      logger.info(
        `Departure message sent to ${welcomeChannel.name} for ${member.user.tag}`,
      );
    } catch (error) {
      logger.error('Échec envoi message départ :', error);
    }
  }
}
