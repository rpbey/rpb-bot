import {
  ChannelType,
  type Collection,
  type Message,
  type Snowflake,
} from 'discord.js';

import { bot } from '../../lib/bot.js';
import { logger } from '../../lib/logger.js';
import { clearMentions, redis, setScanMeta } from '../../lib/redis.js';

interface ChannelResult {
  counts: Map<string, number>;
  messages: number;
}

type FetchMessages = (options: {
  limit: number;
  before?: string;
}) => Promise<Collection<Snowflake, Message>>;

async function scanChannel(
  channel: { messages: { fetch: FetchMessages } },
  maxMessages: number,
): Promise<ChannelResult> {
  const counts = new Map<string, number>();
  let lastId: string | undefined;
  let fetched = 0;
  let messages = 0;

  while (fetched < maxMessages) {
    const options: { limit: number; before?: string } = { limit: 100 };
    if (lastId) options.before = lastId;

    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      if (msg.author.bot) continue;
      messages++;
      for (const mentioned of msg.mentions.users.values()) {
        if (mentioned.id === msg.author.id) continue;
        const key = `${msg.author.id}:${mentioned.id}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }

    lastId = batch.last()?.id;
    fetched += batch.size;
    if (batch.size < 100) break;
  }

  return { counts, messages };
}

/**
 * Full scan of all text channels to index mention pairs.
 * Stores in Redis hash: rpb:mentions { "fromId:toId" => count }
 */
export async function mentionsScanTask() {
  const guildId = process.env.GUILD_ID;
  if (!guildId) return;

  const guild = bot.guilds.cache.get(guildId);
  if (!guild) return;

  logger.info('[MentionsScan] Starting full mentions scan...');
  const start = Date.now();

  const channelArr = [
    ...guild.channels.cache
      .filter(
        (c) =>
          (c.type === ChannelType.GuildText ||
            c.type === ChannelType.GuildAnnouncement) &&
          'messages' in c,
      )
      .values(),
  ];

  const MAX_MESSAGES = 5000;
  const CONCURRENCY = 10;

  // Process all channels with a concurrency pool
  const channelResults: ChannelResult[] = [];
  let channelsScanned = 0;

  for (let i = 0; i < channelArr.length; i += CONCURRENCY) {
    const batch = channelArr.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((ch) => scanChannel(ch as never, MAX_MESSAGES)),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        channelResults.push(r.value);
        channelsScanned++;
      }
    }
  }

  // Merge all channel results into one map
  const merged = new Map<string, number>();
  let totalMessages = 0;

  for (const result of channelResults) {
    totalMessages += result.messages;
    for (const [key, count] of result.counts) {
      merged.set(key, (merged.get(key) || 0) + count);
    }
  }

  // Write to Redis (Bun.redis auto-pipelines commands)
  try {
    await clearMentions();

    // Batch writes in chunks to avoid overwhelming Redis
    const entries = Array.from(merged);
    const BATCH_SIZE = 500;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(([key, count]) =>
          redis.hset('rpb:mentions', key, String(count)),
        ),
      );
    }

    await setScanMeta(channelsScanned, totalMessages);
  } catch (err) {
    logger.error('[MentionsScan] Redis write error:', err);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(
    `[MentionsScan] Done: ${channelsScanned} channels, ${totalMessages} messages, ${merged.size} pairs in ${elapsed}s`,
  );
}
