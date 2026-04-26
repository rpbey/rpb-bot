import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { ChannelType } from 'discord.js';
import { type ArgsOf, Discord, On } from '@rpbey/discordx';

import { logger } from '../lib/logger.js';
import { resolveRootPath } from '../lib/paths.js';

@Discord()
export class MessageLogger {
  @On({ event: 'messageCreate' })
  async onMessage([message]: ArgsOf<'messageCreate'>) {
    if (message.author.bot || !message.content) return;

    const isDM = message.channel.type === ChannelType.DM;
    const botId = message.client.user?.id;
    const isMention = botId
      ? message.mentions.has(botId) && !message.mentions.everyone
      : false;

    if (isDM || isMention) {
      const logEntry = {
        content: message.content,
        authorId: message.author.id,
        authorTag: message.author.tag,
        channelType: isDM ? 'DM' : 'GUILD',
        isMention: isMention,
        timestamp: new Date().toISOString(),
      };

      const dataPath = resolveRootPath('bot', 'data', 'training_data.jsonl');

      try {
        const dir = path.dirname(dataPath);
        await mkdir(dir, { recursive: true });

        const file = Bun.file(dataPath);
        const existing = (await file.exists()) ? await file.text() : '';
        await Bun.write(dataPath, `${existing}${JSON.stringify(logEntry)}\n`);
      } catch (error) {
        logger.error('Error logging training message:', error);
      }
    }
  }
}
