import {
  type CommandInteraction,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { mock } from 'bun:test';

const vi = {
  fn: mock,
  mock: mock.module,
};

export function createMockInteraction(options: {
  commandName: string;
  user: Record<string, unknown>;
  guild?: Partial<Guild>;
  options?: any;
}) {
  const interaction = {
    commandName: options.commandName,
    user: {
      id: '123456789',
      username: 'testuser',
      displayName: 'Test User',
      displayAvatarURL: vi
        .fn()
        .mockReturnValue('https://example.com/avatar.png'),
      ...options.user,
    },
    guild: (options.guild || {
      id: 'guild123',
      name: 'Test Guild',
    }) as Guild,
    channel: {
      id: 'channel123',
      send: vi.fn().mockResolvedValue({}),
    } as unknown as TextChannel,
    options: {
      get: vi.fn((name) => options.options?.[name]),
      getString: vi.fn((name) => options.options?.[name]),
      getUser: vi.fn((name) => options.options?.[name]),
      getInteger: vi.fn((name) => options.options?.[name]),
      getBoolean: vi.fn((name) => options.options?.[name]),
    },
    deferReply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    reply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    isCommand: vi.fn().mockReturnValue(true),
    isChatInputInteraction: vi.fn().mockReturnValue(true),
  } as unknown as CommandInteraction;

  return interaction;
}

export const mockPrisma = {
  user: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  profile: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  globalRanking: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  tournamentMatch: {
    findMany: vi.fn(),
  },
  deck: {
    findFirst: vi.fn(),
  },
} as any;
