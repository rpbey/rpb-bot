/**
 * discord-activity.ts
 *
 * Bridge entre la Discord Activity (gacha-client) et le serveur gacha :
 *
 *   1. POST /api/discord/token-exchange
 *      Côté client : appelle après `commands.authorize` du SDK Embedded.
 *      Échange le `code` OAuth contre un `access_token` Discord, puis mint
 *      une session interne (Bearer token) via `ensureGachaSession`.
 *      Le client utilise ensuite ce Bearer pour parler au serveur gacha
 *      (Colyseus + REST sur :5050).
 *
 *   2. POST /api/discord/webhook/entitlement
 *      Webhook Discord IAP : à chaque `ENTITLEMENT_CREATE`, vérifier la
 *      signature Ed25519 (Public Key du Dev Portal), résoudre le SKU vers
 *      un montant de currency, créditer le profil joueur via Prisma.
 */

import { logger } from "./logger.js";
import { ensureGachaSession } from "./gacha-api.js";
import { prisma } from "./prisma.js";

// ─── 1. Token exchange ────────────────────────────────────────────────────────

interface DiscordTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token: string;
	scope: string;
}

interface DiscordUserResponse {
	id: string;
	username: string;
	global_name: string | null;
	discriminator: string;
	avatar: string | null;
}

export interface TokenExchangeResult {
	access_token: string;
	gacha_session_token: string;
	gacha_user_id: string;
	expires_at: number;
	discord_user: { id: string; username: string; avatar: string | null };
}

export class TokenExchangeError extends Error {
	constructor(
		public code:
			| "MISSING_ENV"
			| "OAUTH_FAILED"
			| "USER_FETCH_FAILED"
			| "INVALID_CODE",
		message: string,
	) {
		super(message);
		this.name = "TokenExchangeError";
	}
}

/**
 * Exchange a Discord OAuth authorization `code` for an `access_token`
 * (server-to-server with `client_secret`), fetch the Discord user identity,
 * and mint a gacha session Bearer for that user.
 */
export async function exchangeDiscordCode(
	code: string,
): Promise<TokenExchangeResult> {
	const clientId = process.env.DISCORD_CLIENT_ID;
	const clientSecret = process.env.DISCORD_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new TokenExchangeError(
			"MISSING_ENV",
			"DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not configured",
		);
	}

	// 1. Exchange code → access_token (Discord OAuth2)
	const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: "authorization_code",
			code,
		}),
	});
	if (!tokenRes.ok) {
		const body = await tokenRes.text().catch(() => "<unreadable>");
		logger.warn(
			{ status: tokenRes.status, body: body.slice(0, 200) },
			"Discord OAuth token exchange failed",
		);
		throw new TokenExchangeError(
			tokenRes.status === 400 ? "INVALID_CODE" : "OAUTH_FAILED",
			"Discord rejected the authorization code",
		);
	}
	const token = (await tokenRes.json()) as DiscordTokenResponse;

	// 2. Fetch the Discord user (id + username for displayName)
	const userRes = await fetch("https://discord.com/api/users/@me", {
		headers: { Authorization: `Bearer ${token.access_token}` },
	});
	if (!userRes.ok) {
		throw new TokenExchangeError(
			"USER_FETCH_FAILED",
			`Discord /users/@me returned ${userRes.status}`,
		);
	}
	const user = (await userRes.json()) as DiscordUserResponse;
	const displayName = user.global_name ?? user.username;

	// 3. Mint or reuse a gacha session Bearer
	const session = await ensureGachaSession(user.id, displayName);

	return {
		access_token: token.access_token,
		gacha_session_token: session.token,
		gacha_user_id: session.userId,
		expires_at: session.expiresAt,
		discord_user: { id: user.id, username: displayName, avatar: user.avatar },
	};
}

// ─── 2. IAP webhook (ENTITLEMENT_CREATE Ed25519-signed) ──────────────────────

/**
 * Map SKU IDs (Discord Dev Portal) to currency amounts. Configurable via env :
 *   DISCORD_SKU_<SKU_ID>=<AMOUNT>
 * Example : DISCORD_SKU_1234567890=500 → 500 pièces gacha.
 */
function loadSkuMap(): Map<string, number> {
	const map = new Map<string, number>();
	const prefix = "DISCORD_SKU_";
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith(prefix) || !value) continue;
		const skuId = key.slice(prefix.length);
		const amount = Number(value);
		if (Number.isFinite(amount) && amount > 0) map.set(skuId, amount);
	}
	return map;
}

interface DiscordEntitlementPayload {
	type: number; // 1 = PING, otherwise event payload
	event?: {
		type: string; // e.g. "ENTITLEMENT_CREATE"
		data?: {
			id: string;
			sku_id: string;
			user_id: string;
			application_id: string;
			type: number;
			consumed: boolean;
		};
	};
	t?: string; // event name (when sent as Gateway-style payload)
}

export interface WebhookResult {
	status: "pong" | "credited" | "ignored";
	credited?: { discordUserId: string; amount: number; sku: string };
}

export class WebhookError extends Error {
	constructor(
		public code:
			| "MISSING_PUBLIC_KEY"
			| "INVALID_SIGNATURE"
			| "INVALID_PAYLOAD"
			| "USER_NOT_FOUND"
			| "DB_ERROR",
		message: string,
	) {
		super(message);
		this.name = "WebhookError";
	}
}

/**
 * Verify a Discord webhook Ed25519 signature using Web Crypto.
 * Discord signs `timestamp + raw_body` with its app's private key ; we verify
 * with the public key from Dev Portal → General Information.
 */
async function verifyDiscordSignature(
	rawBody: string,
	signatureHex: string,
	timestamp: string,
	publicKeyHex: string,
): Promise<boolean> {
	try {
		const sigBytes = hexToBytes(signatureHex);
		const keyBytes = hexToBytes(publicKeyHex);
		const message = new TextEncoder().encode(timestamp + rawBody);
		// Web Crypto Ed25519 — algo récent (Bun 1.2+, Node 22+).
		// `as never` cast pour contourner les définitions DOM strictes qui ne
		// connaissent pas encore "Ed25519".
		const key = await crypto.subtle.importKey(
			"raw",
			keyBytes,
			{ name: "Ed25519" } as never,
			false,
			["verify"],
		);
		return await crypto.subtle.verify(
			{ name: "Ed25519" } as never,
			key,
			sigBytes,
			message,
		);
	} catch (err) {
		logger.warn({ err }, "Failed to verify Discord webhook signature");
		return false;
	}
}

function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/**
 * Process a raw incoming webhook request. Verifies the Ed25519 signature,
 * handles Discord's PING (type=1) handshake, and credits currency on
 * ENTITLEMENT_CREATE for known SKUs.
 *
 * Returns the response shape the route handler should send back to Discord.
 */
export async function handleEntitlementWebhook(args: {
	rawBody: string;
	signatureHeader: string | null;
	timestampHeader: string | null;
}): Promise<WebhookResult> {
	const publicKey = process.env.DISCORD_PUBLIC_KEY;
	if (!publicKey) {
		throw new WebhookError(
			"MISSING_PUBLIC_KEY",
			"DISCORD_PUBLIC_KEY not configured",
		);
	}
	if (!args.signatureHeader || !args.timestampHeader) {
		throw new WebhookError(
			"INVALID_SIGNATURE",
			"Missing X-Signature-Ed25519 or X-Signature-Timestamp",
		);
	}

	const valid = await verifyDiscordSignature(
		args.rawBody,
		args.signatureHeader,
		args.timestampHeader,
		publicKey,
	);
	if (!valid) {
		throw new WebhookError("INVALID_SIGNATURE", "Ed25519 verification failed");
	}

	let payload: DiscordEntitlementPayload;
	try {
		payload = JSON.parse(args.rawBody);
	} catch {
		throw new WebhookError("INVALID_PAYLOAD", "Body is not valid JSON");
	}

	// Discord handshake — respond with PONG (type=1).
	if (payload.type === 1) return { status: "pong" };

	const evt = payload.event;
	if (!evt || evt.type !== "ENTITLEMENT_CREATE" || !evt.data) {
		return { status: "ignored" };
	}
	if (evt.data.consumed) return { status: "ignored" };

	const skuMap = loadSkuMap();
	const amount = skuMap.get(evt.data.sku_id);
	if (!amount) {
		logger.warn(
			{ skuId: evt.data.sku_id },
			"ENTITLEMENT_CREATE for unknown SKU — set DISCORD_SKU_<id>=<amount>",
		);
		return { status: "ignored" };
	}

	const discordUserId = evt.data.user_id;

	try {
		// Credit via Prisma (shared `users` + `profiles` tables with gacha server).
		// Pas d'enum `IAP_PURCHASE` actuellement → on utilise `ADMIN_GIVE` avec une
		// `note` typée pour la traçabilité (entitlement.id Discord = idempotent ref).
		// TODO : ajouter `IAP_PURCHASE` au TransactionType enum quand schema:sync ok.
		await prisma.$transaction(async (tx) => {
			const user = await tx.user.findFirst({
				where: { discordId: discordUserId },
				select: { id: true },
			});
			if (!user) {
				throw new WebhookError(
					"USER_NOT_FOUND",
					`No gacha user for discordId=${discordUserId}. Need first /play login.`,
				);
			}
			await tx.profile.upsert({
				where: { userId: user.id },
				update: { currency: { increment: amount } },
				create: { userId: user.id, currency: amount },
			});
			await tx.currencyTransaction.create({
				data: {
					userId: user.id,
					type: "ADMIN_GIVE",
					amount,
					note: `iap:discord:sku=${evt.data.sku_id}:entitlement=${evt.data.id}`,
				},
			});
		});
	} catch (err) {
		if (err instanceof WebhookError) throw err;
		logger.error({ err, discordUserId }, "Failed to credit IAP entitlement");
		throw new WebhookError("DB_ERROR", "Database transaction failed");
	}

	logger.info(
		{ discordUserId, sku: evt.data.sku_id, amount },
		"IAP entitlement credited",
	);
	return {
		status: "credited",
		credited: { discordUserId, amount, sku: evt.data.sku_id },
	};
}
