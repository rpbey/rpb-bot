import { type Client, type TextChannel } from 'discord.js';
import { type ArgsOf, Discord, On } from '@rpbey/discordx';
import { inject, injectable } from 'tsyringe';

import { logger } from '../lib/logger.js';
import { PrismaService } from '../lib/prisma.js';

const CHECK_INTERVAL = 30_000; // 30 seconds

@Discord()
@injectable()
export class ReminderScheduler {
  constructor(@inject(PrismaService) private prisma: PrismaService) {}

  @On({ event: 'clientReady' })
  async onReady([client]: ArgsOf<'clientReady'>) {
    logger.info('[Reminders] Scheduler started');
    setInterval(() => this.checkReminders(client), CHECK_INTERVAL);
  }

  private async checkReminders(client: Client) {
    try {
      const due = await this.prisma.reminder.findMany({
        where: { fired: false, expiresAt: { lte: new Date() } },
        take: 10,
      });

      for (const reminder of due) {
        try {
          const channel = (await client.channels
            .fetch(reminder.channelId)
            .catch(() => null)) as TextChannel | null;

          if (channel) {
            await channel.send(
              `⏰ <@${reminder.discordId}> — Rappel :\n> ${reminder.message}`,
            );
          }

          await this.prisma.reminder.update({
            where: { id: reminder.id },
            data: { fired: true },
          });
        } catch (err) {
          logger.error(
            `[Reminders] Failed to fire reminder ${reminder.id}:`,
            err,
          );
        }
      }
    } catch (err) {
      logger.error('[Reminders] Check failed:', err);
    }
  }
}
