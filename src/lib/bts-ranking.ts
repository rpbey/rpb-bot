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
	challongeUsername?: string | null;
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
	2: [2, 3, 4],
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
	process.env.BTS_EXPORTS_DIR ??
	"/home/ubuntu/vps/apps/rpb-dashboard/data/exports";

const PARTICIPANTS_MAP_PATH = join(
	DASHBOARD_EXPORTS_DIR,
	"participants_map.json",
);

function normalizeKey(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function normForLookup(s: string | null | undefined): string {
	return s
		? s
				.toLowerCase()
				.normalize("NFKD")
				.replace(/[^a-z0-9]/g, "")
		: "";
}

interface MapEntry {
	primaryName?: string;
	challongeUsername?: string | null;
	discordId?: string | null;
	discordUsername?: string | null;
	aliases?: string[];
}

/**
 * Build a name → Discord User.image resolver. Joins three sources:
 *   1. `participants_map.json` (alias → discordId/discordUsername)
 *   2. `Profile.challongeUsername` → User.image
 *   3. `User.username/name/globalName/nickname/discordTag/Profile.bladerName`
 *      cascade (normalised exact match)
 *
 * Used to backfill Discord avatars on the leaderboard canvas — Challonge
 * portrait stays as fallback when the player has no Discord linkage.
 */
async function loadDiscordResolver(): Promise<
	(playerName: string, challongeUsername: string | null) => string | null
> {
	let map: Record<string, MapEntry> = {};
	try {
		map = JSON.parse(await readFile(PARTICIPANTS_MAP_PATH, "utf-8"));
	} catch {}

	const aliasToKey = new Map<string, string>();
	for (const [k, e] of Object.entries(map)) {
		const cs = new Set<string>([e.primaryName ?? "", ...(e.aliases ?? [])]);
		if (e.challongeUsername) cs.add(e.challongeUsername);
		if (e.discordUsername) cs.add(e.discordUsername);
		for (const a of cs) {
			const n = normForLookup(a);
			if (n) aliasToKey.set(n, k);
		}
	}

	const users = await prisma.user.findMany({
		where: { discordId: { not: null } },
		select: {
			id: true,
			discordId: true,
			username: true,
			displayUsername: true,
			name: true,
			globalName: true,
			nickname: true,
			discordTag: true,
			image: true,
			profile: { select: { challongeUsername: true, bladerName: true } },
		},
	});
	const imageByDiscordId = new Map<string, string | null>();
	for (const u of users) {
		if (u.discordId) imageByDiscordId.set(u.discordId, u.image ?? null);
	}
	const imageByKey = new Map<string, string>();
	const setIfFree = (k: string, img: string | null) => {
		if (k && img && !imageByKey.has(k)) imageByKey.set(k, img);
	};
	for (const u of users)
		if (u.profile?.challongeUsername)
			setIfFree(normForLookup(u.profile.challongeUsername), u.image);
	for (const u of users) {
		setIfFree(normForLookup(u.username), u.image);
		setIfFree(normForLookup(u.displayUsername), u.image);
		setIfFree(normForLookup(u.globalName), u.image);
		setIfFree(normForLookup(u.nickname), u.image);
		setIfFree(normForLookup(u.discordTag), u.image);
		setIfFree(normForLookup(u.profile?.bladerName), u.image);
		setIfFree(normForLookup(u.name), u.image);
	}

	return (
		playerName: string,
		challongeUsername: string | null,
	): string | null => {
		// Try map → discordId → User.image
		const cands = new Set<string>();
		cands.add(normForLookup(playerName));
		if (challongeUsername) cands.add(normForLookup(challongeUsername));
		const mapKey = aliasToKey.get(normForLookup(playerName));
		if (mapKey) {
			const e = map[mapKey];
			if (e?.discordId) {
				const img = imageByDiscordId.get(e.discordId);
				if (img) return img;
			}
			if (e?.challongeUsername) cands.add(normForLookup(e.challongeUsername));
			if (e?.discordUsername) cands.add(normForLookup(e.discordUsername));
			for (const a of e?.aliases ?? []) cands.add(normForLookup(a));
		}
		// Try cascade
		for (const c of cands) {
			const img = imageByKey.get(c);
			if (img) return img;
		}
		return null;
	};
}

async function loadBts(
	n: number,
): Promise<{ name: string; data: BtsTournament } | null> {
	try {
		const raw = await readFile(
			join(DASHBOARD_EXPORTS_DIR, `B_TS${n}.json`),
			"utf-8",
		);
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
): Array<BtsRankingEntry & { challongeUsername: string | null }> {
	interface Acc {
		name: string;
		challongeUsername: string | null;
		points: number;
		wins: number;
		losses: number;
		tournamentWins: number;
		participations: number;
		challongePortraitUrl: string | null;
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
				challongeUsername: p.challongeUsername ?? null,
				points: 0,
				wins: 0,
				losses: 0,
				tournamentWins: 0,
				participations: 0,
				challongePortraitUrl: null,
				bestFinish: null,
			};
			// Backfill identifiers across multi-tournament entries
			if (!acc.challongeUsername && p.challongeUsername)
				acc.challongeUsername = p.challongeUsername;
			acc.participations += 1;
			acc.points += pts.participation;
			if (p.portraitUrl && !acc.challongePortraitUrl)
				acc.challongePortraitUrl = p.portraitUrl;

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
			if (b.tournamentWins !== a.tournamentWins)
				return b.tournamentWins - a.tournamentWins;
			return b.wins - a.wins;
		})
		.map((p, i) => ({
			rank: i + 1,
			playerName: p.name,
			challongeUsername: p.challongeUsername,
			points: p.points,
			wins: p.wins,
			losses: p.losses,
			tournamentWins: p.tournamentWins,
			participations: p.participations,
			// Discord avatar resolved post-aggregation; for now the raw
			// Challonge portrait keeps the slot.
			avatarUrl: p.challongePortraitUrl,
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
	const [pts, discordImageOf] = await Promise.all([
		getPointsConfig(),
		loadDiscordResolver().catch(() => () => null as string | null),
	]);
	const aggregated = aggregate(loaded, pts);

	// Backfill Discord avatar — Discord prioritaire, Challonge en fallback
	const entries: BtsRankingEntry[] = aggregated.map((e) => {
		const discord = discordImageOf(e.playerName, e.challongeUsername);
		return { ...e, avatarUrl: discord ?? e.avatarUrl };
	});

	const filtered = search
		? entries.filter((e) =>
				e.playerName.toLowerCase().includes(search.toLowerCase()),
			)
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
