import { RedisClient } from 'bun';

import { logger } from './logger.js';

export const redis = new RedisClient(
  process.env.REDIS_URL || 'redis://127.0.0.1:6379',
);

// Verify connection
redis
  .ping()
  .then(() => logger.info('[Redis] Connected (Bun native client)'))
  .catch((err: Error) =>
    logger.error('[Redis] Connection error:', err.message),
  );

const MENTIONS_KEY = 'rpb:mentions';

/** Get mention count: how many times `fromId` mentioned `toId` */
export async function getMentions(
  fromId: string,
  toId: string,
): Promise<number> {
  const val = await redis.hget(MENTIONS_KEY, `${fromId}:${toId}`);
  return val ? Number.parseInt(val, 10) : 0;
}

/** Increment mention count */
export async function incrMentions(
  fromId: string,
  toId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  await redis.hincrby(MENTIONS_KEY, `${fromId}:${toId}`, count);
}

/** Set mention count (used by full scan) */
export async function setMentions(
  fromId: string,
  toId: string,
  count: number,
): Promise<void> {
  await redis.hset(MENTIONS_KEY, `${fromId}:${toId}`, String(count));
}

/** Get all mention pairs */
export async function getAllMentions(): Promise<Record<string, number>> {
  const data = (await redis.hgetall(MENTIONS_KEY)) as Record<string, string>;
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(data)) {
    result[key] = Number.parseInt(val, 10);
  }
  return result;
}

/** Clear all mention data (before full rescan) */
export async function clearMentions(): Promise<void> {
  await redis.del(MENTIONS_KEY);
}

/** Set last scan metadata */
export async function setScanMeta(
  channelsScanned: number,
  messagesScanned: number,
): Promise<void> {
  await redis.hset(
    'rpb:mentions:meta',
    'channelsScanned',
    String(channelsScanned),
  );
  await redis.hset(
    'rpb:mentions:meta',
    'messagesScanned',
    String(messagesScanned),
  );
  await redis.hset('rpb:mentions:meta', 'lastScan', new Date().toISOString());
}

/** Get last scan metadata */
export async function getScanMeta(): Promise<{
  channelsScanned: number;
  messagesScanned: number;
  lastScan: string | null;
}> {
  const data = (await redis.hgetall('rpb:mentions:meta')) as Record<
    string,
    string
  >;
  return {
    channelsScanned: Number.parseInt(data.channelsScanned || '0', 10),
    messagesScanned: Number.parseInt(data.messagesScanned || '0', 10),
    lastScan: data.lastScan || null,
  };
}
