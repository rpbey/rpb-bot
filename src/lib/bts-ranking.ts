/**
 * BTS (Beyblade Tournament Series) ranking computation — mirror of
 * `apps/rpb-dashboard/src/server/actions/bts.ts` so the Discord bot and
 * the web dashboard display the exact same numbers.
 *
 * Source of truth: `data/exports/B_TS{1..4}.json` under the dashboard app.
 * We aggregate in-memory on each call — scale is tiny (<500 participants).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import prisma from "./prisma.js";

export type BtsSeason = 1 | 2;

interface BtsParticipant {
  id: number;
  name: string;
  seed?: number;
  portraitUrl?: string;
  finalRank?: number | null;
}

interface BtsMatch {
  id: number;
  winnerId: number | null;
  loserId: number | null;
  state?: string;
}

interface BtsTournament {
  metadata?: { name?: string };
  participants?: BtsParticipant[];
  matches?: BtsMatch[];
}

export interface BtsRankingEntry {
  rank: number;
  playerName: string;
  points: number;
  wins: number;
  losses: number;
  tournamentWins: number;
  participations: number;
  avatarUrl: string | null;
  bestFinish: number | null;
}

export interface BtsChampion {
  tournament: string;
  winner: string;
  participantsCount: number;
}

export interface BtsRankingResult {
  entries: BtsRankingEntry[];
  total: number;
  champions: BtsChampion[];
}

const SEASON_MAP: Record<BtsSeason, number[]> = {
  1: [1],
  // BTS 4 pas encore débuté — à ajouter lorsque les matches seront joués.
  2: [2, 3],
};

const FINISH_BUCKET = new Map<number, keyof BtsPointsConfig>([
  [1, "firstPlace"],
  [2, "secondPlace"],
  [3, "thirdPlace"],
  [4, "top8"],
  [5, "top8"],
  [6, "top8"],
  [7, "top8"],
  [8, "top8"],
]);

interface BtsPointsConfig {
  firstPlace: number;
  secondPlace: number;
  thirdPlace: number;
  top8: number;
  matchWinWinner: number;
  matchWinLoser: number;
  participation: number;
}

/**
 * Dashboard path — BTS JSON live under `apps/rpb-dashboard/data/exports/`.
 * We resolve it relative to the repo root so the bot reads the same
 * files as the Next.js app.
 */
const DASHBOARD_EXPORTS_DIR =
  process.env.BTS_EXPORTS_DIR ?? "/home/ubuntu/vps/apps/rpb-dashboard/data/exports";

function normalizeKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

async function loadBts(n: number): Promise<{ name: string; data: BtsTournament } | null> {
  try {
    const raw = await readFile(join(DASHBOARD_EXPORTS_DIR, `B_TS${n}.json`), "utf-8");
    return { name: `BTS${n}`, data: JSON.parse(raw) as BtsTournament };
  } catch {
    return null;
  }
}

async function getPointsConfig(): Promise<BtsPointsConfig> {
  const config = await prisma.rankingSystem.findFirst();
  if (!config) {
    return {
      firstPlace: 10000,
      secondPlace: 7000,
      thirdPlace: 5000,
      top8: 500,
      matchWinWinner: 1000,
      matchWinLoser: 500,
      participation: 500,
    };
  }
  return {
    firstPlace: config.firstPlace,
    secondPlace: config.secondPlace,
    thirdPlace: config.thirdPlace,
    top8: config.top8,
    matchWinWinner: config.matchWinWinner,
    matchWinLoser: config.matchWinLoser,
    participation: config.participation,
  };
}

function aggregate(
  tournaments: Array<{ data: BtsTournament }>,
  pts: BtsPointsConfig,
): BtsRankingEntry[] {
  interface Acc {
    name: string;
    points: number;
    wins: number;
    losses: number;
    tournamentWins: number;
    participations: number;
    avatarUrl: string | null;
    bestFinish: number | null;
  }
  const players = new Map<string, Acc>();

  for (const { data } of tournaments) {
    const participants = data.participants ?? [];
    const matches = data.matches ?? [];
    const byId = new Map<number, BtsParticipant>();
    for (const p of participants) byId.set(p.id, p);

    for (const p of participants) {
      if (!p.name) continue;
      const key = normalizeKey(p.name);
      const acc: Acc = players.get(key) ?? {
        name: p.name,
        points: 0,
        wins: 0,
        losses: 0,
        tournamentWins: 0,
        participations: 0,
        avatarUrl: null,
        bestFinish: null,
      };
      acc.participations += 1;
      acc.points += pts.participation;
      if (p.portraitUrl && !acc.avatarUrl) acc.avatarUrl = p.portraitUrl;

      const rank = p.finalRank ?? null;
      if (rank) {
        const bucket = FINISH_BUCKET.get(rank);
        if (bucket) acc.points += pts[bucket];
        if (rank === 1) acc.tournamentWins += 1;
        if (acc.bestFinish === null || rank < acc.bestFinish) {
          acc.bestFinish = rank;
        }
      }
      players.set(key, acc);
    }

    for (const m of matches) {
      if (m.state && m.state !== "complete") continue;
      if (m.winnerId == null || m.loserId == null) continue;
      const winner = byId.get(m.winnerId);
      const loser = byId.get(m.loserId);
      if (winner?.name) {
        const acc = players.get(normalizeKey(winner.name));
        if (acc) {
          acc.wins += 1;
          acc.points += pts.matchWinWinner;
        }
      }
      if (loser?.name) {
        const acc = players.get(normalizeKey(loser.name));
        if (acc) {
          acc.losses += 1;
          acc.points += pts.matchWinLoser;
        }
      }
    }
  }

  return [...players.values()]
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.tournamentWins !== a.tournamentWins) return b.tournamentWins - a.tournamentWins;
      return b.wins - a.wins;
    })
    .map((p, i) => ({
      rank: i + 1,
      playerName: p.name,
      points: p.points,
      wins: p.wins,
      losses: p.losses,
      tournamentWins: p.tournamentWins,
      participations: p.participations,
      avatarUrl: p.avatarUrl,
      bestFinish: p.bestFinish,
    }));
}

export async function getBtsRanking(
  season: BtsSeason,
  opts: { search?: string; page?: number; pageSize?: number } = {},
): Promise<BtsRankingResult> {
  const { search = "", page = 1, pageSize = 10 } = opts;
  const slugs = SEASON_MAP[season];
  const loaded = (await Promise.all(slugs.map(loadBts))).filter(
    (t): t is { name: string; data: BtsTournament } => t !== null,
  );
  const pts = await getPointsConfig();
  const entries = aggregate(loaded, pts);

  const filtered = search
    ? entries.filter((e) => e.playerName.toLowerCase().includes(search.toLowerCase()))
    : entries;

  const start = (page - 1) * pageSize;
  const paged = filtered.slice(start, start + pageSize).map((e, i) => ({
    ...e,
    rank: start + i + 1,
  }));

  const champions: BtsChampion[] = loaded.map(({ name, data }) => {
    const champ = (data.participants ?? []).find((p) => p.finalRank === 1);
    return {
      tournament: name,
      winner: champ?.name ?? "—",
      participantsCount: (data.participants ?? []).length,
    };
  });

  return { entries: paged, total: filtered.length, champions };
}
