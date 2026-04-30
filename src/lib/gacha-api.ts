/**
 * gacha-api.ts
 *
 * Typed HTTP client for the gacha server (http://127.0.0.1:5050).
 * Each call is authenticated as a specific Discord user via a Bearer
 * token minted on-the-fly by looking up the shared `sessions` table.
 *
 * Session minting flow:
 *   1. SELECT users.id FROM users WHERE discordId = ?
 *      (users table is shared between gacha server and rpb-bot DB)
 *   2. Upsert user row if not present (gacha server always creates it
 *      on first login; bot creates it too via resolve())
 *   3. INSERT INTO sessions (id, userId, token, expiresAt, ...) — raw
 *      unhashed token, same trust model as resolveServiceToken() in
 *      gacha/src/auth/middleware.ts
 *   4. Cache token in memory for 6h
 *
 * The token lookup in gacha middleware:
 *   SELECT sessions JOIN users WHERE sessions.token = ? AND NOT expired AND NOT banned
 *   → this is the "service-token bypass" path already present in middleware.ts.
 */

import pg from "pg";
import crypto from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.GACHA_API_URL ?? "http://127.0.0.1:5050";
const SESSION_TTL_MS = 6 * 3_600_000; // 6 hours

// ─── Session cache ────────────────────────────────────────────────────────────

interface CachedSession {
	token: string;
	userId: string; // gacha internal user.id (uuid)
	expiresAt: number; // Date.now() + TTL
}

const sessionCache = new Map<string, CachedSession>();

// ─── DB pool (direct SQL — same PG instance as gacha) ────────────────────────
// We use the same DATABASE_URL env that the bot already reads.
// Direct pool — not the Prisma adapter — so we can do raw inserts without
// coupling to the Prisma schema (which doesn't know gacha's sessions table).

const { Pool } = pg;
let _pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
	if (!_pool) {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error("DATABASE_URL not set");
		_pool = new Pool({
			connectionString,
			max: 3,
			min: 1,
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 10_000,
		});
	}
	return _pool;
}

// ─── Session minting ──────────────────────────────────────────────────────────

async function mintSession(
	discordUserId: string,
	displayName: string,
): Promise<CachedSession> {
	const pool = getPool();

	// 1. Look up user by discordId
	let userRow = await pool.query<{ id: string }>(
		'SELECT id FROM users WHERE "discordId" = $1 LIMIT 1',
		[discordUserId],
	);

	let userId: string;

	if (userRow.rows.length === 0) {
		// 2. Create user row (mirrors what EconomyGroup.resolve() does via Prisma)
		const newId = crypto.randomUUID();
		const email = `${discordUserId}@discord.rpbey.fr`;
		const now = new Date().toISOString();
		await pool.query(
			`INSERT INTO users (id, name, email, "emailVerified", "discordId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, $4, $5, $5)
       ON CONFLICT ("discordId") DO UPDATE SET "updatedAt" = $5`,
			[newId, displayName, email, discordUserId, now],
		);
		// Re-fetch to handle the ON CONFLICT case
		userRow = await pool.query<{ id: string }>(
			'SELECT id FROM users WHERE "discordId" = $1 LIMIT 1',
			[discordUserId],
		);
		userId = userRow.rows[0]?.id ?? newId;
	} else {
		userId = userRow.rows[0]!.id;
	}

	// 3. Mint a new session token
	const token = crypto.randomBytes(32).toString("hex");
	const sessionId = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
	const now = new Date().toISOString();

	await pool.query(
		`INSERT INTO sessions (id, "userId", token, "expiresAt", "createdAt", "updatedAt", "userAgent")
     VALUES ($1, $2, $3, $4, $5, $5, 'rpb-bot/1.0')`,
		[sessionId, userId, token, expiresAt.toISOString(), now],
	);

	const session: CachedSession = {
		token,
		userId,
		expiresAt: Date.now() + SESSION_TTL_MS,
	};

	sessionCache.set(discordUserId, session);
	return session;
}

async function getSession(
	discordUserId: string,
	displayName: string,
): Promise<CachedSession> {
	const cached = sessionCache.get(discordUserId);
	// Leave 5 min buffer before expiry
	if (cached && cached.expiresAt - Date.now() > 5 * 60_000) {
		return cached;
	}
	return mintSession(discordUserId, displayName);
}

/**
 * Public surface of `getSession` — returns the cached or freshly-minted
 * Bearer token for a Discord user. Used by the Discord Activity OAuth
 * token-exchange endpoint to give the gacha-client a session token after
 * the user authenticates via the Embedded App SDK.
 */
export async function ensureGachaSession(
	discordUserId: string,
	displayName: string,
): Promise<{ token: string; userId: string; expiresAt: number }> {
	const s = await getSession(discordUserId, displayName);
	return { token: s.token, userId: s.userId, expiresAt: s.expiresAt };
}

// ─── Types (minimal subset of gacha service return shapes) ──────────────────

export interface GachaCard {
	id: string;
	name: string;
	nameJp: string | null;
	series: string;
	description: string | null;
	rarity: string;
	element: string;
	att: number;
	def: number;
	end: number;
	equilibre: number;
	beyblade: string | null;
	imageUrl: string | null;
	specialMove: string | null;
	isActive: boolean;
	dropId: string | null;
}

export interface PullResult {
	rarity: string | null;
	card: GachaCard | null;
	isDuplicate: boolean;
	isWished: boolean;
	newBalance: number;
	pityCount: number;
	badgeUnlocked?: { name: string; emoji: string; reward: number } | null;
}

export interface MultiPullResult {
	results: PullResult[];
	newBalance: number;
	hitsCount: number;
	missCount: number;
}

export interface DailyResult {
	amount: number;
	streakBonus: number;
	totalGain: number;
	tier: number;
	streakAfter: number;
	newBalance: number;
	message: string;
	streakBonusLabel?: string;
	interestPaid?: number;
	streakBroken?: boolean;
}

export interface Balance {
	currency: number;
	dailyStreak: number;
	lastDaily: string | null;
	pityCount: number;
}

export interface InventoryItem {
	cardId: string;
	count: number;
	card: GachaCard;
}

export interface InventoryPage {
	items: InventoryItem[];
	nextCursor: string | null;
	total: number;
}

export interface SellResult {
	pricePaid: number;
	newBalance: number;
	cardName: string;
	rarity: string;
}

export interface SellAllResult {
	soldCount: number;
	totalEarned: number;
	newBalance: number;
	sold: Array<{ name: string; rarity: string; count: number; earned: number }>;
}

export interface WishlistItem {
	cardId: string;
	card: GachaCard;
	owned: boolean;
}

export interface HistoryItem {
	id: string;
	amount: number;
	type: string;
	note: string | null;
	createdAt: string;
}

export interface HistoryPage {
	items: HistoryItem[];
	nextCursor: string | null;
}

export interface DropRates {
	MISS: number;
	COMMON: number;
	RARE: number;
	SUPER_RARE: number;
	LEGENDARY: number;
	pityThreshold: number;
}

export interface Banner {
	id: string;
	slug: string;
	name: string;
	theme: string;
	season: number;
	startDate: string;
	endDate: string;
	imageUrl: string | null;
	isActive: boolean;
}

export interface BadgeProgress {
	badges: Array<{
		count: number;
		name: string;
		emoji: string;
		reward: number;
		earned: boolean;
		claimed: boolean;
	}>;
	uniqueCards: number;
	nextBadge: {
		count: number;
		name: string;
		emoji: string;
		reward: number;
	} | null;
}

export interface FusionPreview {
	eligible: boolean;
	candidates: GachaCard[];
	targetRarity: string | null;
	message: string;
}

export interface FusionResult {
	burnedCardId: string;
	burnedRarity: string;
	rewardCard: GachaCard;
	rewardRarity: string;
	newBalance: number;
}

export interface DuelProposal {
	id: string;
	challengerId: string;
	opponentId: string;
	bet: number;
	status: string;
	expiresAt: string;
}

export interface DuelState {
	id: string;
	challengerId: string;
	opponentId: string;
	bet: number;
	status: string;
	currentRound: number;
	challengerHp: number;
	opponentHp: number;
	log: string[];
	winnerId: string | null;
	finished: boolean;
	finishLabel: string | null;
}

export interface TradeProposal {
	id: string;
	fromUserId: string;
	toUserId: string;
	offeredCardId: string;
	requestedCardId: string;
	status: string;
	createdAt: string;
}

export interface LeaderboardEntry {
	userId: string;
	name: string | null;
	image: string | null;
	value: number;
}

export interface GiftResult {
	newBalance: number;
	recipientName?: string;
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class GachaApiError extends Error {
	constructor(
		public code: string,
		message: string,
		public retryInMs?: number,
	) {
		super(message);
		this.name = "GachaApiError";
	}
}

// ─── Client factory ───────────────────────────────────────────────────────────

export interface GachaApiClient {
	// Gacha
	pull(): Promise<PullResult>;
	pullMulti(): Promise<MultiPullResult>;
	daily(): Promise<DailyResult>;
	balance(): Promise<Balance>;
	inventory(opts?: {
		rarity?: string;
		cursor?: string;
		limit?: number;
	}): Promise<InventoryPage>;
	sell(cardId: string): Promise<SellResult>;
	sellAll(): Promise<SellAllResult>;
	gift(recipientUserId: string, cardId: string): Promise<GiftResult>;
	wishlistToggle(cardId: string): Promise<{ added: boolean; cardName: string }>;
	wishlist(): Promise<WishlistItem[]>;
	history(opts?: {
		cursor?: string;
		limit?: number;
		type?: string;
	}): Promise<HistoryPage>;
	rates(): Promise<DropRates>;
	card(id: string): Promise<GachaCard>;
	searchCards(q: string, limit?: number): Promise<GachaCard[]>;
	banners(): Promise<Banner[]>;
	badges(): Promise<BadgeProgress>;
	claimBadge(): Promise<{
		badge: { name: string; emoji: string; reward: number };
		newBalance: number;
	}>;
	fusionPreview(): Promise<FusionPreview>;
	fuse(cardId: string): Promise<FusionResult>;
	// Leaderboard
	leaderboard(
		category: "currency" | "wins" | "mmr" | "collection",
		limit?: number,
	): Promise<LeaderboardEntry[]>;
	// Duel (async TCG flow)
	duelPropose(opts: {
		opponentUserId: string;
		bet?: number;
		cardIds?: string[];
	}): Promise<DuelProposal>;
	duelAccept(id: string): Promise<DuelState>;
	duelDecline(id: string): Promise<{ ok: boolean }>;
	duelPlay(
		id: string,
	): Promise<
		DuelState & { finished: boolean; winnerId?: string; finishLabel?: string }
	>;
	duelForfeit(id: string): Promise<DuelState>;
	duelActive(): Promise<DuelState | null>;
	duelHistory(limit?: number): Promise<DuelState[]>;
	// Trade
	tradePropose(opts: {
		toUserId: string;
		offeredCardId: string;
		requestedCardId: string;
	}): Promise<TradeProposal>;
	tradeAccept(id: string): Promise<{ ok: boolean }>;
	tradeDecline(id: string): Promise<{ ok: boolean }>;
	tradePending(): Promise<TradeProposal[]>;
	// Admin (requires admin role on caller)
	adminGrant(
		targetUserId: string,
		amount: number,
		note?: string,
	): Promise<{ newBalance: number }>;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function apiFetch<T>(
	token: string,
	method: string,
	path: string,
	body?: unknown,
	queryParams?: Record<string, string | number | undefined>,
): Promise<T> {
	let url = `${BASE_URL}${path}`;
	if (queryParams) {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(queryParams)) {
			if (v !== undefined) q.set(k, String(v));
		}
		if (q.size > 0) url += `?${q.toString()}`;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);

	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			throw new GachaApiError(
				"TIMEOUT",
				"Le serveur gacha ne répond pas (timeout 15s)",
			);
		}
		throw new GachaApiError(
			"NETWORK",
			`Erreur réseau gacha : ${(err as Error).message}`,
		);
	} finally {
		clearTimeout(timeout);
	}

	if (
		response.status === 502 ||
		response.status === 503 ||
		response.status === 504
	) {
		throw new GachaApiError(
			"SERVICE_UNAVAILABLE",
			"Le service gacha est temporairement indisponible",
		);
	}

	const json = (await response.json()) as Record<string, unknown>;

	if (!response.ok || json.ok === false) {
		const err = json.error as
			| { code?: string; message?: string; retryInMs?: number }
			| undefined;
		const flatCode = typeof json.code === "string" ? json.code : undefined;
		const flatMessage =
			typeof json.message === "string" ? json.message : undefined;
		throw new GachaApiError(
			err?.code ?? flatCode ?? String(response.status),
			err?.message ?? flatMessage ?? `Gacha API error ${response.status}`,
			err?.retryInMs,
		);
	}

	// Server-side returns `balanceAfter`; client expects `newBalance`. Mirror it
	// recursively so all economy routes (pull, multi, daily, sell, etc.) work.
	normalizeBalanceFields(json);

	return json as T;
}

function normalizeBalanceFields(obj: unknown): void {
	if (Array.isArray(obj)) {
		for (const item of obj) normalizeBalanceFields(item);
		return;
	}
	if (obj && typeof obj === "object") {
		const o = obj as Record<string, unknown>;
		if ("balanceAfter" in o && !("newBalance" in o)) {
			o.newBalance = o.balanceAfter;
		}
		for (const v of Object.values(o)) normalizeBalanceFields(v);
	}
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Create a gacha API client bound to a specific Discord user.
 * The Bearer session is minted lazily and cached for 6h.
 */
export async function createGachaClient(
	discordUserId: string,
	displayName: string,
): Promise<GachaApiClient> {
	const session = await getSession(discordUserId, displayName);
	const t = session.token;

	const get = <T>(
		path: string,
		q?: Record<string, string | number | undefined>,
	) => apiFetch<T>(t, "GET", path, undefined, q);
	const post = <T>(path: string, body?: unknown) =>
		apiFetch<T>(t, "POST", path, body);

	return {
		// ── Gacha ──
		async pull() {
			const r = await post<{ ok: boolean; result: PullResult }>(
				"/api/gacha/pull",
			);
			return r.result;
		},
		async pullMulti() {
			const r = await post<{ ok: boolean; result: MultiPullResult }>(
				"/api/gacha/pull10",
			);
			return r.result;
		},
		async daily() {
			const r = await post<{ ok: boolean; result: DailyResult }>(
				"/api/gacha/daily",
			);
			return r.result;
		},
		async balance() {
			const r = await get<Balance & { userId: string }>("/api/gacha/balance");
			return r;
		},
		async inventory(opts) {
			const r = await get<{ ok: boolean; page: InventoryPage }>(
				"/api/gacha/inventory/page",
				{
					rarity: opts?.rarity,
					cursor: opts?.cursor,
					limit: opts?.limit,
				},
			);
			return r.page;
		},
		async sell(cardId) {
			const r = await post<{ ok: boolean; result: SellResult }>(
				"/api/gacha/sell",
				{ cardId },
			);
			return r.result;
		},
		async sellAll() {
			const r = await post<{ ok: boolean; result: SellAllResult }>(
				"/api/gacha/sell-all",
			);
			return r.result;
		},
		async gift(recipientId, cardId) {
			const r = await post<{ ok: boolean; result: GiftResult }>(
				"/api/gacha/gift",
				{
					recipientId,
					cardId,
				},
			);
			return r.result;
		},
		async wishlistToggle(cardId) {
			const r = await post<{ ok: boolean; added: boolean; cardName: string }>(
				"/api/gacha/wishlist/toggle",
				{ cardId },
			);
			return { added: r.added, cardName: r.cardName };
		},
		async wishlist() {
			const r = await get<{ ok: boolean; items: WishlistItem[] }>(
				"/api/gacha/wishlist",
			);
			return r.items;
		},
		async history(opts) {
			const r = await get<{ ok: boolean; page: HistoryPage }>(
				"/api/gacha/history",
				{
					cursor: opts?.cursor,
					limit: opts?.limit,
					type: opts?.type,
				},
			);
			return r.page;
		},
		async rates() {
			const r = await get<{ ok: boolean } & DropRates>("/api/gacha/rates");
			return r;
		},
		async card(id) {
			const r = await get<{ ok: boolean; card: GachaCard }>(
				`/api/gacha/cards/${encodeURIComponent(id)}`,
			);
			return r.card;
		},
		async searchCards(q, limit) {
			const r = await get<{ ok: boolean; items: GachaCard[] }>(
				"/api/gacha/cards/search",
				{ q, limit },
			);
			return r.items;
		},
		async banners() {
			const r = await get<{ banners: Banner[] }>("/api/gacha/banners");
			return r.banners;
		},
		async badges() {
			const r = await get<{ ok: boolean; progress: BadgeProgress }>(
				"/api/gacha/badges",
			);
			return r.progress;
		},
		async claimBadge() {
			const r = await post<{
				ok: boolean;
				result: {
					badge: { name: string; emoji: string; reward: number };
					newBalance: number;
				};
			}>("/api/gacha/badges/claim");
			return r.result;
		},
		async fusionPreview() {
			const r = await get<{ ok: boolean; preview: FusionPreview }>(
				"/api/gacha/fusion/preview",
			);
			return r.preview;
		},
		async fuse(cardId) {
			const r = await post<{ ok: boolean; result: FusionResult }>(
				"/api/gacha/fusion",
				{ cardId },
			);
			return r.result;
		},

		// ── Leaderboard ──
		async leaderboard(category, limit) {
			const r = await get<{ ok: boolean; entries: LeaderboardEntry[] }>(
				`/api/leaderboard/${category}`,
				{ limit },
			);
			return r.entries;
		},

		// ── Duel (async TCG) ──
		async duelPropose({ opponentUserId, bet, cardIds }) {
			const r = await post<{ ok: boolean; result: DuelProposal }>(
				"/api/duel/propose",
				{
					opponentUserId,
					bet,
					cardIds,
				},
			);
			return r.result;
		},
		async duelAccept(id) {
			const r = await post<{ ok: boolean; result: DuelState }>(
				`/api/duel/${id}/accept`,
			);
			return r.result;
		},
		async duelDecline(id) {
			await post(`/api/duel/${id}/decline`);
			return { ok: true };
		},
		async duelPlay(id) {
			const r = await post<{
				ok: boolean;
				result: DuelState & {
					finished: boolean;
					winnerId?: string;
					finishLabel?: string;
				};
			}>(`/api/duel/${id}/play`);
			return r.result;
		},
		async duelForfeit(id) {
			const r = await post<{ ok: boolean; result: DuelState }>(
				`/api/duel/${id}/forfeit`,
			);
			return r.result;
		},
		async duelActive() {
			const r = await get<{ ok: boolean; duel: DuelState | null }>(
				"/api/duel/active",
			);
			return r.duel;
		},
		async duelHistory(limit) {
			const r = await get<{ ok: boolean; items: DuelState[] }>(
				"/api/duel/history",
				{ limit },
			);
			return r.items;
		},

		// ── Trade ──
		async tradePropose({ toUserId, offeredCardId, requestedCardId }) {
			const r = await post<{ ok: boolean; proposal: TradeProposal }>(
				"/api/trade/propose",
				{
					toUserId,
					offeredCardId,
					requestedCardId,
				},
			);
			return r.proposal;
		},
		async tradeAccept(id) {
			await post(`/api/trade/${id}/accept`);
			return { ok: true };
		},
		async tradeDecline(id) {
			await post(`/api/trade/${id}/decline`);
			return { ok: true };
		},
		async tradePending() {
			const r = await get<{ ok: boolean; items: TradeProposal[] }>(
				"/api/trade/pending",
			);
			return r.items;
		},

		// ── Admin ──
		async adminGrant(targetUserId, amount, note) {
			const r = await post<{
				ok: boolean;
				newBalance: number;
				prevBalance: number;
			}>("/api/admin/currency/grant", { targetUserId, amount, note });
			return { newBalance: r.newBalance };
		},
	};
}

/**
 * Graceful degradation helper.
 * Returns null if the gacha server is down, so commands can show a
 * "service indisponible" message instead of throwing.
 */
export async function tryGachaClient(
	discordUserId: string,
	displayName: string,
): Promise<GachaApiClient | null> {
	try {
		return await createGachaClient(discordUserId, displayName);
	} catch {
		return null;
	}
}

/** Reusable "service indisponible" check: returns true if the error is
 *  a network/timeout/service error (not a business error). */
export function isServiceUnavailable(err: unknown): boolean {
	if (err instanceof GachaApiError) {
		return ["TIMEOUT", "NETWORK", "SERVICE_UNAVAILABLE"].includes(err.code);
	}
	return false;
}
