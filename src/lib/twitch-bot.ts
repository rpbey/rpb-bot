import { type ApiClient } from '@twurple/api';
import { type ChatClient } from '@twurple/chat';

import { logger } from './logger.js';
import { resolveDataPath } from './paths.js';

const _TOKEN_PATH = resolveDataPath('twitch-tokens.json');

const log = (
  level: 'info' | 'warn' | 'error',
  message: string,
  error?: any,
) => {
  if (error) logger[level](message, error);
  else logger[level](message);
};

export class TwitchBot {
  public chatClient: ChatClient | null = null;
  public apiClient: ApiClient | null = null;
  public channel: string;

  constructor() {
    this.channel =
      process.env.TWITCH_CHANNEL ||
      process.env.NEXT_PUBLIC_TWITCH_CHANNEL ||
      'tv_rpb';
  }

  public async init() {
    log('info', 'Twitch bot integration is currently DISABLED.');
    return;
  }

  public async announce(message: string) {
    log('info', `Announce skipped (Bot Disabled): ${message}`);
  }
}

export const twitchBot = new TwitchBot();
