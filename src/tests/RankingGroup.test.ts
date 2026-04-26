import { beforeEach, describe, expect, it, mock, jest } from 'bun:test';

const vi = {
  fn: mock,
  mock: mock.module,
  clearAllMocks: () => jest.clearAllMocks(),
};
import { RankingGroup } from '../commands/Beyblade/RankingGroup.js';
import { createMockInteraction, mockPrisma } from './mocks.js';

// Mock canvas utils
vi.mock('../../lib/canvas-utils.js', () => ({
  generateProfileCard: vi.fn().mockResolvedValue(Buffer.from('mock-image')),
  generateLeaderboardCard: vi
    .fn()
    .mockResolvedValue(Buffer.from('mock-leaderboard')),
}));

// Mock logger
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('RankingGroup', () => {
  let rankingGroup: RankingGroup;

  beforeEach(() => {
    vi.clearAllMocks();
    rankingGroup = new RankingGroup(mockPrisma);
  });

  describe('profile', () => {
    it('should show a profile when the user exists', async () => {
      const interaction = createMockInteraction({
        commandName: 'profil',
        user: { id: 'user123', displayName: 'BladerOne' },
      });

      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'db-user-123',
        discordId: 'user123',
        createdAt: new Date(),
        _count: { tournaments: 5 },
        profile: {
          bladerName: 'BladerOne',
          rankingPoints: 1200,
          wins: 10,
          losses: 5,
          tournamentWins: 1,
          bio: 'Test Bio',
        },
      });

      mockPrisma.tournamentMatch.findMany.mockResolvedValue([]);
      mockPrisma.globalRanking.count.mockResolvedValue(10); // Rank #11
      mockPrisma.deck.findFirst.mockResolvedValue(null);

      await rankingGroup.profile(undefined, 'rpb', interaction);

      expect(interaction.deferReply).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          embeds: expect.any(Array),
          files: expect.any(Array),
        }),
      );
    });

    it('should show an error message if the user has no profile', async () => {
      const interaction = createMockInteraction({
        commandName: 'profil',
        user: { id: 'user-no-profile' },
      });

      mockPrisma.user.findFirst.mockResolvedValue(null);

      await rankingGroup.profile(undefined, 'rpb', interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(
            "Tu n'as pas encore de profil Beyblade",
          ),
        }),
      );
    });
  });

  describe('leaderboard', () => {
    it('should generate a leaderboard image', async () => {
      const interaction = createMockInteraction({
        commandName: 'top',
        user: { id: 'admin' },
        options: { format: 'image' },
      });

      mockPrisma.globalRanking.findMany.mockResolvedValue([
        {
          playerName: 'Top1',
          points: 5000,
          wins: 20,
          losses: 2,
          user: { profile: {} },
        },
      ]);

      await rankingGroup.leaderboard('image', interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          files: expect.any(Array),
        }),
      );
    });
  });
});
