import { type GuildMember } from 'discord.js';
import { type ArgsOf, type Client, Discord, On } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { logger } from '../lib/logger.js';
import { PrismaService } from '../lib/prisma.js';

@Discord()
@injectable()
export class ReadyListener {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  @On({ event: 'clientReady' })
  async onReady([client]: ArgsOf<'clientReady'>) {
    logger.info('Connecté en tant que :', client.user.tag);

    await this.syncAdminRoles(client as unknown as Client);

    if (process.env.CLEAR_GUILD_COMMANDS === 'true' && process.env.GUILD_ID) {
      try {
        logger.info(
          `Nettoyage des commandes de guilde pour : ${process.env.GUILD_ID}`,
        );
        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        await guild.commands.set([]);
        logger.info('Commandes de guilde nettoyées avec succès !');
      } catch (error) {
        logger.error(
          'Erreur lors du nettoyage des commandes de guilde :',
          error,
        );
      }
    }
  }

  private async syncAdminRoles(client: Client) {
    const guildId = process.env.GUILD_ID;
    if (!guildId) {
      logger.warn(
        'GUILD_ID pas configuré, impossible de synchroniser les rôles admin.',
      );
      return;
    }

    try {
      const guild =
        client.guilds.cache.get(guildId) ??
        (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        logger.error(
          `Guilde ${guildId} non trouvée lors de la synchronisation des rôles.`,
        );
        return;
      }

      const members = await guild.members.fetch();
      const admins = members.filter((member: GuildMember) =>
        member.permissions.has('Administrator'),
      );

      logger.info(`Synchronisation de ${admins.size} administrateurs...`);

      for (const [id, member] of admins) {
        try {
          await this.prisma.user.upsert({
            where: { discordId: id },
            update: { role: 'admin' },
            create: {
              discordId: id,
              discordTag: member.user.tag,
              name: member.displayName,
              email: `${id}@discord.rpbey.fr`,
              role: 'admin',
            },
          });
        } catch (error) {
          logger.debug(`Impossible de sync l'admin ${id}: ${error}`);
        }
      }

      const dbAdmins = await this.prisma.user.findMany({
        where: { role: 'admin' },
        select: { discordId: true },
      });

      for (const dbAdmin of dbAdmins) {
        if (!dbAdmin.discordId) continue;
        const member = members.get(dbAdmin.discordId);
        if (!member?.permissions.has('Administrator')) {
          await this.prisma.user.update({
            where: { discordId: dbAdmin.discordId },
            data: { role: 'user' },
          });
        }
      }

      logger.info('Synchronisation des rôles terminée.');
    } catch (error) {
      logger.error('Erreur lors de la synchronisation des rôles :', error);
    }
  }
}
