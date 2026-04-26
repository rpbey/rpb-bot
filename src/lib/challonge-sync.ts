import { type Prisma } from '../generated/prisma/client.js';

import { getChallongeClient } from './challonge.js';
import { logger } from './logger.js';
import prisma from './prisma.js';
import { ChallongeScraper } from './scrapers/challonge-scraper.js';

export interface SyncResult {
  success: boolean;
  tournamentId?: string;
  participantsCount?: number;
  matchesCount?: number;
  standingsCount?: number;
  stationsCount?: number;
  logEntriesCount?: number;
  error?: string;
  apiRequestsUsed: number;
}

export async function scrapeAndSyncTournament(
  urlId: string,
): Promise<SyncResult> {
  const scraper = new ChallongeScraper();
  try {
    logger.info(`[Sync] Démarrage du scraping deep-sync pour: ${urlId}`);
    const result = await scraper.scrape(urlId);

    // 1. Upsert Tournament
    const meta = result.metadata;
    const raw = result.raw.tournament;
    const status = mapChallongeState(meta.state);
    const challongeId = String(meta.id);

    const dbTournament = await prisma.tournament.upsert({
      where: { challongeId },
      update: {
        name: meta.name,
        description: raw.description,
        date: raw.start_at ? new Date(raw.start_at) : new Date(),
        status,
        challongeUrl: meta.url,
        challongeState: meta.state,
        standings:
          result.standings.length > 0
            ? (result.standings as unknown as Prisma.InputJsonValue)
            : undefined,
        stations:
          result.stations.length > 0
            ? (result.stations as unknown as Prisma.InputJsonValue)
            : undefined,
        activityLog:
          result.log.length > 0
            ? (result.log as unknown as Prisma.InputJsonValue)
            : undefined,
      },
      create: {
        challongeId,
        name: meta.name,
        description: raw.description,
        date: raw.start_at ? new Date(raw.start_at) : new Date(),
        status,
        challongeUrl: meta.url,
        challongeState: meta.state,
        maxPlayers: raw.signup_cap || 64,
        standings:
          result.standings.length > 0
            ? (result.standings as unknown as Prisma.InputJsonValue)
            : undefined,
        stations:
          result.stations.length > 0
            ? (result.stations as unknown as Prisma.InputJsonValue)
            : undefined,
        activityLog:
          result.log.length > 0
            ? (result.log as unknown as Prisma.InputJsonValue)
            : undefined,
      },
    });

    // 2. Sync Participants & Mapping
    const challongeIdToUserId = new Map<number, string>();
    let importedParticipants = 0;

    for (const p of result.participants) {
      let user = await prisma.user.findFirst({
        where: {
          OR: [
            { name: { equals: p.name, mode: 'insensitive' } },
            { username: { equals: p.name, mode: 'insensitive' } },
            {
              profile: {
                challongeUsername: { equals: p.name, mode: 'insensitive' },
              },
            },
          ],
        },
      });

      if (!user) {
        const cleanName = p.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const stubEmail = `${cleanName}@import.bot`;
        user = await prisma.user.upsert({
          where: { email: stubEmail },
          update: { name: p.name },
          create: {
            name: p.name,
            username: `bot_${cleanName}`.substring(0, 30),
            email: stubEmail,
            role: 'user',
            image: '/logo.webp',
          },
        });
      }

      if (user) {
        challongeIdToUserId.set(p.id, user.id);

        const existingParticipant =
          await prisma.tournamentParticipant.findFirst({
            where: {
              tournamentId: dbTournament.id,
              userId: user.id,
            },
          });

        if (existingParticipant) {
          await prisma.tournamentParticipant.update({
            where: { id: existingParticipant.id },
            data: {
              challongeParticipantId: String(p.id),
              seed: p.seed,
              finalPlacement: p.finalRank || null,
              checkedIn: true,
            },
          });
        } else {
          await prisma.tournamentParticipant.create({
            data: {
              tournamentId: dbTournament.id,
              userId: user.id,
              challongeParticipantId: String(p.id),
              seed: p.seed,
              finalPlacement: p.finalRank || null,
              checkedIn: true,
            },
          });
        }
        importedParticipants++;
      }
    }

    // 3. Sync Matches
    let importedMatches = 0;
    for (const m of result.matches) {
      const p1UserId = m.player1Id
        ? challongeIdToUserId.get(m.player1Id)
        : null;
      const p2UserId = m.player2Id
        ? challongeIdToUserId.get(m.player2Id)
        : null;
      const winnerUserId = m.winnerId
        ? challongeIdToUserId.get(m.winnerId)
        : null;

      await prisma.tournamentMatch.upsert({
        where: {
          tournamentId_challongeMatchId: {
            tournamentId: dbTournament.id,
            challongeMatchId: String(m.id),
          },
        },
        update: {
          round: m.round,
          player1Id: p1UserId || null,
          player2Id: p2UserId || null,
          winnerId: winnerUserId || null,
          score: m.scores,
          state: m.state,
          updatedAt: new Date(),
        },
        create: {
          tournamentId: dbTournament.id,
          challongeMatchId: String(m.id),
          round: m.round,
          player1Id: p1UserId || null,
          player2Id: p2UserId || null,
          winnerId: winnerUserId || null,
          score: m.scores,
          state: m.state,
        },
      });
      importedMatches++;
    }

    logger.info(
      `[Sync] Deep-Sync réussi pour ${dbTournament.name}: ${importedParticipants} joueurs, ${importedMatches} matchs, ${result.standings.length} standings, ${result.stations.length} stations, ${result.log.length} log.`,
    );

    return {
      success: true,
      tournamentId: dbTournament.id,
      participantsCount: importedParticipants,
      matchesCount: importedMatches,
      standingsCount: result.standings.length,
      stationsCount: result.stations.length,
      logEntriesCount: result.log.length,
      apiRequestsUsed: 0,
    };
  } catch (error) {
    logger.error('[Sync] Erreur Deep-Sync Scraping:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      apiRequestsUsed: 0,
    };
  } finally {
    await scraper.close();
  }
}

export async function pushParticipantToChallonge(
  challongeId: string,
  discordId: string,
  playerName: string,
): Promise<{ success: boolean; participantId?: string; error?: string }> {
  const challonge = getChallongeClient();

  try {
    const result = await challonge.createParticipant(challongeId, {
      name: playerName,
      misc: discordId,
    });

    return {
      success: true,
      participantId: result.data.id,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erreur inconnue',
    };
  }
}

export async function shouldSyncRealtime(
  tournamentId: string,
): Promise<boolean> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
  });

  if (!tournament) return false;

  const now = new Date();
  const tournamentDate = new Date(tournament.date);
  const hoursUntilTournament =
    (tournamentDate.getTime() - now.getTime()) / (1000 * 60 * 60);

  return (
    hoursUntilTournament <= 24 &&
    hoursUntilTournament > -6 &&
    tournament.status !== 'COMPLETE'
  );
}

export async function getTournamentsNeedingSync(): Promise<string[]> {
  const now = new Date();
  const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

  const tournaments = await prisma.tournament.findMany({
    where: {
      challongeId: { not: null },
      status: { not: 'COMPLETE' },
      date: {
        gte: sixHoursAgo,
        lte: in24Hours,
      },
    },
    select: { challongeId: true },
  });

  return tournaments
    .map((t) => t.challongeId)
    .filter((id): id is string => id !== null);
}

export async function getUnderwayTournaments(): Promise<
  Array<{ challongeId: string; challongeUrl: string | null }>
> {
  const tournaments = await prisma.tournament.findMany({
    where: {
      challongeId: { not: null },
      status: 'UNDERWAY',
    },
    select: { challongeId: true, challongeUrl: true },
  });

  return tournaments.filter(
    (t): t is typeof t & { challongeId: string } => t.challongeId !== null,
  );
}

function mapChallongeState(
  state: string,
):
  | 'UPCOMING'
  | 'REGISTRATION_OPEN'
  | 'REGISTRATION_CLOSED'
  | 'CHECKIN'
  | 'UNDERWAY'
  | 'COMPLETE'
  | 'CANCELLED' {
  switch (state) {
    case 'pending':
      return 'REGISTRATION_OPEN';
    case 'checking_in':
      return 'CHECKIN';
    case 'underway':
    case 'in_progress':
      return 'UNDERWAY';
    case 'complete':
    case 'ended':
      return 'COMPLETE';
    default:
      return 'UPCOMING';
  }
}

export function getApiRequestsRemaining(): number {
  return 500;
}
