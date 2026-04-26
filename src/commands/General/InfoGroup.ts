import { EmbedBuilder, MessageFlags, type CommandInteraction, version as djsVersion } from "discord.js";
import { Discord, Slash, SlashGroup } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { Colors, RPB } from '../../lib/constants.js';
import { PrismaService } from '../../lib/prisma.js';

@Discord()
@SlashGroup({
  name: 'info',
  description: 'Affiche les informations de la communauté et du bot',
})
@SlashGroup('info')
@injectable()
export class InfoGroup {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  @Slash({
    name: 'bot',
    description: 'Statistiques et infos techniques du bot',
  })
  @SlashGroup('info')
  async bot(interaction: CommandInteraction) {
    const client = interaction.client;
    const uptime = client.uptime ?? 0;
    const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
    const hours = Math.floor(
      (uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
    );
    const uptimeStr = `${days}j ${hours}h ${Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60))}m`;

    const embed = new EmbedBuilder()
      .setTitle('🤖 RPB Bot Status')
      .setColor(Colors.Primary)
      .addFields(
        {
          name: '👥 Utilisateurs',
          value: `${client.guilds.cache.reduce((a, g) => a + g.memberCount, 0).toLocaleString()}`,
          inline: true,
        },
        { name: '⏱️ Uptime', value: uptimeStr, inline: true },
        { name: '📡 Latence', value: `${client.ws.ping}ms`, inline: true },
        { name: '📦 Engine', value: `Node ${process.version}`, inline: true },
        {
          name: '⚡ Library',
          value: `Discord.js v${djsVersion}`,
          inline: true,
        },
      )
      .setFooter({ text: RPB.FullName });

    return interaction.reply({ embeds: [embed] });
  }

  @Slash({ name: 'serveur', description: 'Informations sur le serveur RPB' })
  @SlashGroup('info')
  async server(interaction: CommandInteraction) {
    const guild = interaction.guild;
    if (!guild)
      return interaction.reply({
        content: '❌ Uniquement sur serveur.',
        flags: MessageFlags.Ephemeral,
      });
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle(`🌀 ${guild.name}`)
      .setColor(Colors.Primary)
      .setThumbnail(guild.iconURL({ size: 256 }))
      .addFields(
        { name: '👑 Propriétaire', value: `<@${guild.ownerId}>`, inline: true },
        { name: '👥 Membres', value: `${guild.memberCount}`, inline: true },
        {
          name: '🚀 Boosts',
          value: `${guild.premiumSubscriptionCount || 0} (Niv. ${guild.premiumTier})`,
          inline: true,
        },
        {
          name: '📅 Créé le',
          value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`,
          inline: true,
        },
      )
      .setFooter({ text: `ID: ${guild.id}` });

    return interaction.editReply({ embeds: [embed] });
  }

  @Slash({ name: 'staff', description: "Liste de l'équipe RPB" })
  @SlashGroup('info')
  async staff(interaction: CommandInteraction) {
    await interaction.deferReply();
    const members = await this.prisma.staffMember.findMany({
      where: { isActive: true },
      orderBy: { teamId: 'asc' },
    });
    if (members.length === 0)
      return interaction.editReply('❌ Aucun staff enregistré.');

    const embed = new EmbedBuilder()
      .setTitle('🎖️ Équipe RPB')
      .setColor(Colors.Primary)
      .setDescription(
        "Retrouvez l'équipe complète sur [rpbey.fr/notre-equipe](https://rpbey.fr/notre-equipe)",
      );

    const teams = members.reduce(
      (acc, m) => {
        acc[m.teamId] = [...(acc[m.teamId] || []), m];
        return acc;
      },
      {} as Record<string, typeof members>,
    );

    for (const [teamId, teamMembers] of Object.entries(teams)) {
      embed.addFields({
        name: teamId.toUpperCase(),
        value: teamMembers.map((m) => `• **${m.name}** (${m.role})`).join('\n'),
      });
    }

    return interaction.editReply({ embeds: [embed] });
  }

  @Slash({ name: 'partenaire', description: 'Nos partenaires Beyblade' })
  @SlashGroup('info')
  async partner(interaction: CommandInteraction) {
    const partners = await this.prisma.contentBlock.findUnique({
      where: { slug: 'partners' },
    });
    const embed = new EmbedBuilder()
      .setTitle('🤝 Nos Partenaires')
      .setColor(Colors.Secondary)
      .setDescription(
        partners?.content || 'Découvrez nos partenaires sur le site !',
      )
      .setURL('https://rpbey.fr/partenaires');
    return interaction.reply({ embeds: [embed] });
  }

  @Slash({ name: 'promo', description: 'Codes promos actifs' })
  @SlashGroup('info')
  async promo(interaction: CommandInteraction) {
    const promo = await this.prisma.contentBlock.findUnique({
      where: { slug: 'promo-codes' },
    });
    const embed = new EmbedBuilder()
      .setTitle('🏷️ Codes Promos')
      .setColor(0x22c55e)
      .setDescription(promo?.content || 'Aucun code promo actif actuellement.');
    return interaction.reply({ embeds: [embed] });
  }
}

@Discord()
@injectable()
export class PingCommand {
  @Slash({ name: 'ping', description: 'Vérifier la latence du bot' })
  async ping(interaction: CommandInteraction) {
    const before = Date.now();
    await interaction.deferReply();
    const api = Date.now() - before;
    const ws = interaction.client.ws.ping;
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Primary)
          .setTitle('🏓 Pong !')
          .addFields(
            { name: '📡 WebSocket', value: `\`${ws}ms\``, inline: true },
            { name: '⚡ API', value: `\`${api}ms\``, inline: true },
          ),
      ],
    });
  }
}
