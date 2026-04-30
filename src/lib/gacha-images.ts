/**
 * gacha-images.ts
 *
 * Fetches rendered PNG images from the gacha server and wraps them as
 * Discord AttachmentBuilder instances. Always requests image/png because
 * Discord does not reliably display AVIF or WebP in embeds/messages.
 *
 * ETag caching: the gacha server returns strong ETags. We cache the last
 * buffer per endpoint key. On 304 the cached buffer is reused — saves
 * ~200–500ms of Skia render latency on hot paths.
 *
 * Attachment size note: Discord file upload limit is 8 MiB for regular
 * bots. PNG images from the gacha server are typically 50–350 KB.
 * If a render exceeds ~7.5 MB (highly unlikely), the upload will fail
 * with a Discord 413 — we log the error and fall back to embed-only reply.
 */

import { AttachmentBuilder } from "discord.js";

const BASE_URL = process.env.GACHA_API_URL ?? "http://127.0.0.1:5050";
const FETCH_TIMEOUT_MS = 20_000;

// ─── ETag cache ───────────────────────────────────────────────────────────────

interface CachedImage {
	etag: string;
	buf: Buffer;
}

const imageCache = new Map<string, CachedImage>();

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function fetchPng(
	path: string,
	bearerToken?: string,
	cacheKey?: string,
): Promise<Buffer | null> {
	const url = `${BASE_URL}${path}`;
	const key = cacheKey ?? path;
	const cached = imageCache.get(key);

	const headers: Record<string, string> = { Accept: "image/png" };
	if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
	if (cached) headers["If-None-Match"] = cached.etag;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(url, { headers, signal: controller.signal });
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}

	if (response.status === 304 && cached) {
		return cached.buf;
	}

	if (!response.ok) {
		return null;
	}

	const etag = response.headers.get("etag") ?? "";
	const arrayBuf = await response.arrayBuffer();
	const buf = Buffer.from(arrayBuf);

	if (etag) {
		imageCache.set(key, { etag, buf });
	}

	return buf;
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Fetch a card image PNG and wrap as an AttachmentBuilder.
 * Returns null if the server is unavailable or the card doesn't exist.
 */
export async function fetchCardPng(
	cardId: string,
): Promise<AttachmentBuilder | null> {
	const buf = await fetchPng(
		`/api/cards/${encodeURIComponent(cardId)}/image.png`,
		undefined,
		`card:${cardId}`,
	);
	if (!buf) return null;
	return new AttachmentBuilder(buf, { name: "gacha-card.png" });
}

/**
 * Fetch a profile card PNG.
 * The gacha server renders wins/losses/currency/mmr/streaks for the user.
 */
export async function fetchProfileCardPng(
	userId: string,
	bearerToken?: string,
): Promise<AttachmentBuilder | null> {
	const buf = await fetchPng(
		`/api/profile/${encodeURIComponent(userId)}/card.png`,
		bearerToken,
		`profile:${userId}`,
	);
	if (!buf) return null;
	return new AttachmentBuilder(buf, { name: "economy-profile.png" });
}

/**
 * Fetch a leaderboard image PNG.
 * category: 'currency' | 'wins' | 'mmr' | 'collection'
 */
export async function fetchLeaderboardPng(
	category: "currency" | "wins" | "mmr" | "collection",
): Promise<AttachmentBuilder | null> {
	const buf = await fetchPng(
		`/api/leaderboard/${category}/image.png`,
		undefined,
		`lb:${category}`,
	);
	if (!buf) return null;
	return new AttachmentBuilder(buf, {
		name: `gacha-leaderboard-${category}.png`,
	});
}

/**
 * Fetch a banner promo PNG.
 */
export async function fetchBannerPromoPng(
	slug: string,
): Promise<AttachmentBuilder | null> {
	const buf = await fetchPng(
		`/api/banners/${encodeURIComponent(slug)}/promo.png`,
		undefined,
		`banner:${slug}`,
	);
	if (!buf) return null;
	return new AttachmentBuilder(buf, { name: "banner-promo.png" });
}

/**
 * Fetch the pity meter PNG for an authenticated user.
 * Requires a Bearer token (private endpoint).
 */
export async function fetchPityPng(
	cardId: string,
	bearerToken: string,
): Promise<AttachmentBuilder | null> {
	// pity.png is per-user + per-card; don't cache across users
	const buf = await fetchPng(
		`/api/cards/${encodeURIComponent(cardId)}/pity.png`,
		bearerToken,
	);
	if (!buf) return null;
	return new AttachmentBuilder(buf, { name: "pity-meter.png" });
}

/**
 * Fetch the inventory mosaic PNG for a user.
 * userId is the internal gacha user.id (uuid), not discordId.
 */
export async function fetchInventoryMosaicPng(
	userId: string,
	bearerToken?: string,
): Promise<AttachmentBuilder | null> {
	const buf = await fetchPng(
		`/api/inventory/${encodeURIComponent(userId)}/mosaic.png`,
		bearerToken,
		`mosaic:${userId}`,
	);
	if (!buf) return null;
	return new AttachmentBuilder(buf, { name: "collection.png" });
}
