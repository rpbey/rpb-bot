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
 *
 * @param code - Authorization code from Discord OAuth (Activity SDK or PWA redirect).
 * @param redirectUri - The redirect_uri declared in Dev Portal. For Activity flow,
 *        Discord doesn't require this (code obtained via SDK), but providing it
 *        keeps the OAuth2 spec-compliant. For PWA flow, MUST match the URI used
 *        in the authorize redirect (e.g. https://play.rpbey.fr/play/).
 */
export async function exchangeDiscordCode(
	code: string,
	redirectUri?: string,
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
	const params = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: "authorization_code",
		code,
	});
	if (redirectUri) params.set("redirect_uri", redirectUri);

	const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params,
	});
	if (!tokenRes.ok) {
		// Sanitize : Discord retourne `{"error":"invalid_grant","error_description":"..."}`
		// — on garde un extrait court et on filtre tout token_/secret_ qui pourrait apparaître.
		const body = await tokenRes.text().catch(() => "<unreadable>");
		const safe = body
			.slice(0, 200)
			.replace(
				/(access_token|refresh_token|client_secret)["':\s]+[^"',}\s]+/gi,
				"$1=<redacted>",
			);
		logger.warn(
			{ status: tokenRes.status, body: safe },
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

/**
 * Webhook Events v1 envelope (cf. https://docs.discord.com/developers/events/webhook-events).
 *
 * - `type === 0` → PING handshake. Le handler doit répondre HTTP 204 sans body.
 * - `type === 1` → Event dispatch. `event.type` = "ENTITLEMENT_CREATE" / etc.
 *
 * NB : NE PAS confondre avec Interactions Webhook v1 où `type === 1 == PING`.
 * Webhook Events v1 = inverse. Une réponse `{type:1}` à un PING Webhook Events
 * sera rejetée par Discord et le webhook sera désactivé après 3 fails.
 */
interface DiscordWebhookEnvelope {
	version: number;
	application_id: string;
	type: 0 | 1;
	event?: {
		type: string;
		timestamp?: string;
		data?: {
			id: string;
			sku_id: string;
			user_id: string;
			application_id?: string;
			type?: number;
			consumed?: boolean;
		};
	};
}

export interface WebhookResult {
	/**
	 * - `"ping"` → handler must reply HTTP 204 (no body). Webhook Events v1 PING.
	 * - `"credited"` → handler replies 200 with `{ ok: true, credited }`.
	 * - `"ignored"` → handler replies 200 with `{ ok: true, status: "ignored" }`.
	 */
	status: "ping" | "credited" | "ignored";
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
export async function verifyDiscordSignature(
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

export function hexToBytes(hex: string): Uint8Array {
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

	// Replay protection : reject timestamps outside ±300s window.
	const tsNum = Number(args.timestampHeader);
	if (!Number.isFinite(tsNum)) {
		throw new WebhookError(
			"INVALID_SIGNATURE",
			"X-Signature-Timestamp is not a number",
		);
	}
	const drift = Math.abs(Date.now() / 1000 - tsNum);
	if (drift > 300) {
		throw new WebhookError(
			"INVALID_SIGNATURE",
			`Timestamp drift too large (${drift.toFixed(0)}s > 300s)`,
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

	let payload: DiscordWebhookEnvelope;
	try {
		payload = JSON.parse(args.rawBody);
	} catch {
		throw new WebhookError("INVALID_PAYLOAD", "Body is not valid JSON");
	}

	// Webhook Events v1 PING (handshake) : type === 0 → 204 No Content (no body).
	if (payload.type === 0) return { status: "ping" };

	// Otherwise expect type === 1 (event dispatch) per Webhook Events v1 spec.
	if (payload.type !== 1) {
		logger.warn({ type: payload.type }, "Unknown webhook envelope type");
		return { status: "ignored" };
	}

	const evt = payload.event;
	if (!evt || evt.type !== "ENTITLEMENT_CREATE" || !evt.data) {
		return { status: "ignored" };
	}
	if (evt.data.consumed === true) return { status: "ignored" };

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
		const idempotenceKey = `iap:discord:sku=${evt.data.sku_id}:entitlement=${evt.data.id}`;
		const alreadyCredited = await prisma.$transaction(async (tx) => {
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
			// Idempotence : check if this entitlement.id has already been credited.
			const existing = await tx.currencyTransaction.findFirst({
				where: { note: idempotenceKey },
				select: { id: true },
			});
			if (existing) return true;
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
					note: idempotenceKey,
				},
			});
			return false;
		});
		if (alreadyCredited) {
			logger.info(
				{ entitlementId: evt.data.id },
				"IAP entitlement replay — already credited",
			);
			return { status: "ignored" };
		}
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
