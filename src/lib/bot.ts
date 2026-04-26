import { Client } from '@rpbey/discordx';

export const bot = new Client({
  botId: 'rpb-bot',
  intents: [
    'Guilds',
    'GuildMembers',
    'GuildMessages',
    'MessageContent',
    'GuildModeration',
    'GuildPresences',
    'GuildVoiceStates',
  ],
  botGuilds: process.env.GUILD_ID ? [process.env.GUILD_ID] : undefined,
  silent: false,
  simpleCommand: {
    prefix: '!',
  },
});
