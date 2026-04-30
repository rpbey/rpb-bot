/**
 * test/discord-activity.test.ts
 *
 * Bun:test suite for src/lib/discord-activity.ts
 *
 *  - hexToBytes / verifyDiscordSignature pure helpers
 *  - PING (type=0) handshake → status ping (204 No Content)
 *  - signature/timestamp header missing → INVALID_SIGNATURE
 *  - timestamp drift > 300s → INVALID_SIGNATURE
 *  - non-numeric timestamp → INVALID_SIGNATURE
 *  - bad signature → INVALID_SIGNATURE
 *  - invalid JSON body → INVALID_PAYLOAD
 *  - unknown SKU → ignored
 *  - known SKU + existing user → credited (currency incremented exactly once)
 *  - replay (same entitlement.id) → second call ignored
 *  - known SKU + missing user → USER_NOT_FOUND
 *  - missing DISCORD_PUBLIC_KEY → MISSING_PUBLIC_KEY
 *  - exchangeDiscordCode happy path + error branches
 *
 * Strategy : real Ed25519 keypair via Web Crypto, mock prisma + gacha-api
 * BEFORE importing the SUT (so the mock is wired through the import graph).
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";

// ─── In-memory fake Prisma ──────────────────────────────────────────────────

type FakeUser = { id: string; discordId: string };
type FakeProfile = { userId: string; currency: number };
type FakeTx = {
	id: string;
	userId: string;
	type: string;
	amount: number;
	note: string;
};

const dbState = {
	users: [] as FakeUser[],
	profiles: [] as FakeProfile[],
	transactions: [] as FakeTx[],
};

function resetDb(): void {
	dbState.users.length = 0;
	dbState.profiles.length = 0;
	dbState.transactions.length = 0;
}

function makeTx() {
	return {
		user: {
			findFirst: async (args: { where: { discordId: string } }) =>
				dbState.users.find((u) => u.discordId === args.where.discordId) ?? null,
		},
		profile: {
			upsert: async (args: {
				where: { userId: string };
				update: { currency: { increment: number } };
				create: { userId: string; currency: number };
			}) => {
				const existing = dbState.profiles.find(
					(p) => p.userId === args.where.userId,
				);
				if (existing) {
					existing.currency += args.update.currency.increment;
					return existing;
				}
				const created = { ...args.create };
				dbState.profiles.push(created);
				return created;
			},
		},
		currencyTransaction: {
			findFirst: async (args: { where: { note: string } }) =>
				dbState.transactions.find((t) => t.note === args.where.note) ?? null,
			create: async (args: {
				data: { userId: string; type: string; amount: number; note: string };
			}) => {
				const created = {
					id: `tx-${dbState.transactions.length + 1}`,
					...args.data,
				};
				dbState.transactions.push(created);
				return created;
			},
		},
	};
}

// Mock prisma BEFORE importing the SUT.
mock.module("../src/lib/prisma.js", () => ({
	prisma: {
		$transaction: async (cb: (tx: ReturnType<typeof makeTx>) => unknown) =>
			cb(makeTx()),
	},
	default: {},
}));

// Mock gacha-api for exchangeDiscordCode tests.
const mintedSessions: Array<{ discordId: string; displayName: string }> = [];
mock.module("../src/lib/gacha-api.js", () => ({
	ensureGachaSession: async (discordId: string, displayName: string) => {
		mintedSessions.push({ discordId, displayName });
		return {
			token: `tok-${discordId}`,
			userId: `uid-${discordId}`,
			expiresAt: Date.now() + 3600_000,
		};
	},
}));

// ─── Real Ed25519 keypair (built once, reused everywhere) ───────────────────

let PRIVATE_KEY: CryptoKey;
let PUBLIC_KEY_HEX: string;

function bytesToHex(b: Uint8Array): string {
	return Array.from(b)
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
}

async function signPayload(timestamp: string, body: string): Promise<string> {
	const msg = new TextEncoder().encode(timestamp + body);
	const sig = await crypto.subtle.sign(
		{ name: "Ed25519" } as never,
		PRIVATE_KEY,
		msg,
	);
	return bytesToHex(new Uint8Array(sig));
}

beforeAll(async () => {
	const kp = (await crypto.subtle.generateKey(
		{ name: "Ed25519" } as never,
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	PRIVATE_KEY = kp.privateKey;
	const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
	PUBLIC_KEY_HEX = bytesToHex(new Uint8Array(raw));
});

// Now import the SUT (after the mocks are in place).
const {
	handleEntitlementWebhook,
	exchangeDiscordCode,
	WebhookError,
	TokenExchangeError,
	verifyDiscordSignature,
	hexToBytes,
} = await import("../src/lib/discord-activity.js");

// ─── Test helpers ────────────────────────────────────────────────────────────

const SKU_KNOWN = "test-sku-1";
const SKU_AMOUNT = 500;

function nowSeconds(offsetSec = 0): string {
	return String(Math.floor(Date.now() / 1000) + offsetSec);
}

function jsonBody(payload: Record<string, unknown>): string {
	return JSON.stringify(payload);
}

beforeEach(() => {
	resetDb();
	mintedSessions.length = 0;
	process.env.DISCORD_PUBLIC_KEY = PUBLIC_KEY_HEX;
	process.env[`DISCORD_SKU_${SKU_KNOWN}`] = String(SKU_AMOUNT);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("hexToBytes", () => {
	it("converts even-length hex to a Uint8Array of half the length", () => {
		const out = hexToBytes("deadbeef");
		expect(out).toBeInstanceOf(Uint8Array);
		expect(out.length).toBe(4);
		expect(Array.from(out)).toEqual([0xde, 0xad, 0xbe, 0xef]);
	});

	it("throws on odd-length hex", () => {
		expect(() => hexToBytes("abc")).toThrow();
	});
});

describe("verifyDiscordSignature", () => {
	it("returns true for a valid Ed25519 signature", async () => {
		const ts = nowSeconds();
		const body = "{}";
		const sig = await signPayload(ts, body);
		expect(await verifyDiscordSignature(body, sig, ts, PUBLIC_KEY_HEX)).toBe(
			true,
		);
	});

	it("returns false for an invalid signature", async () => {
		const ts = nowSeconds();
		const fakeSig = "00".repeat(64);
		expect(
			await verifyDiscordSignature("{}", fakeSig, ts, PUBLIC_KEY_HEX),
		).toBe(false);
	});

	it("returns false (does not throw) on malformed inputs", async () => {
		expect(
			await verifyDiscordSignature("body", "not-hex", "0", PUBLIC_KEY_HEX),
		).toBe(false);
	});
});

describe("handleEntitlementWebhook", () => {
	it("PING (type=0) → status ping (204 No Content per Webhook Events v1)", async () => {
		const ts = nowSeconds();
		const body = jsonBody({ type: 0 });
		const sig = await signPayload(ts, body);
		const res = await handleEntitlementWebhook({
			rawBody: body,
			signatureHeader: sig,
			timestampHeader: ts,
		});
		expect(res.status).toBe("ping");
	});

	it("missing signature header → throws INVALID_SIGNATURE", async () => {
		await expect(
			handleEntitlementWebhook({
				rawBody: "{}",
				signatureHeader: null,
				timestampHeader: nowSeconds(),
			}),
		).rejects.toBeInstanceOf(WebhookError);
	});

	it("missing timestamp header → throws INVALID_SIGNATURE", async () => {
		const body = "{}";
		const sig = await signPayload(nowSeconds(), body);
		await expect(
			handleEntitlementWebhook({
				rawBody: body,
				signatureHeader: sig,
				timestampHeader: null,
			}),
		).rejects.toBeInstanceOf(WebhookError);
	});

	it("timestamp drift > 300s → throws INVALID_SIGNATURE", async () => {
		const stale = nowSeconds(-700);
		const body = jsonBody({ type: 1 });
		const sig = await signPayload(stale, body);
		let caught: unknown;
		try {
			await handleEntitlementWebhook({
				rawBody: body,
				signatureHeader: sig,
				timestampHeader: stale,
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(WebhookError);
		expect((caught as InstanceType<typeof WebhookError>).code).toBe(
			"INVALID_SIGNATURE",
		);
		expect((caught as Error).message).toMatch(/drift|timestamp/i);
	});

	it("non-numeric timestamp → throws INVALID_SIGNATURE", async () => {
		await expect(
			handleEntitlementWebhook({
				rawBody: jsonBody({ type: 1 }),
				signatureHeader: "00".repeat(64),
				timestampHeader: "not-a-number",
			}),
		).rejects.toBeInstanceOf(WebhookError);
	});

	it("invalid signature bytes → throws INVALID_SIGNATURE", async () => {
		const ts = nowSeconds();
		await expect(
			handleEntitlementWebhook({
				rawBody: jsonBody({ type: 1 }),
				signatureHeader: "ab".repeat(64),
				timestampHeader: ts,
			}),
		).rejects.toBeInstanceOf(WebhookError);
	});

	it("invalid JSON body → throws INVALID_PAYLOAD", async () => {
		const ts = nowSeconds();
		const body = "{not json";
		const sig = await signPayload(ts, body);
		let caught: unknown;
		try {
			await handleEntitlementWebhook({
				rawBody: body,
				signatureHeader: sig,
				timestampHeader: ts,
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(WebhookError);
		expect((caught as InstanceType<typeof WebhookError>).code).toBe(
			"INVALID_PAYLOAD",
		);
	});

	it("unknown SKU → status ignored", async () => {
		const ts = nowSeconds();
		const body = jsonBody({
			version: 1,
			application_id: "app-1",
			type: 1,
			event: {
				type: "ENTITLEMENT_CREATE",
				data: {
					id: "ent-1",
					sku_id: "unknown-sku",
					user_id: "discord-99",
					application_id: "app-1",
					type: 8,
					consumed: false,
				},
			},
		});
		const sig = await signPayload(ts, body);
		const res = await handleEntitlementWebhook({
			rawBody: body,
			signatureHeader: sig,
			timestampHeader: ts,
		});
		expect(res.status).toBe("ignored");
	});

	it("known SKU + existing user → status credited and currency incremented", async () => {
		dbState.users.push({ id: "user-1", discordId: "discord-1" });
		const ts = nowSeconds();
		const body = jsonBody({
			version: 1,
			application_id: "app-1",
			type: 1,
			event: {
				type: "ENTITLEMENT_CREATE",
				data: {
					id: "ent-credit-1",
					sku_id: SKU_KNOWN,
					user_id: "discord-1",
					application_id: "app-1",
					type: 8,
					consumed: false,
				},
			},
		});
		const sig = await signPayload(ts, body);
		const res = await handleEntitlementWebhook({
			rawBody: body,
			signatureHeader: sig,
			timestampHeader: ts,
		});
		expect(res.status).toBe("credited");
		expect(res.credited).toEqual({
			discordUserId: "discord-1",
			amount: SKU_AMOUNT,
			sku: SKU_KNOWN,
		});
		const profile = dbState.profiles.find((p) => p.userId === "user-1");
		expect(profile?.currency).toBe(SKU_AMOUNT);
		expect(dbState.transactions).toHaveLength(1);
		expect(dbState.transactions[0]?.note).toContain("ent-credit-1");
	});

	it("replay same entitlement.id → second call ignored, currency NOT double-credited", async () => {
		dbState.users.push({ id: "user-2", discordId: "discord-2" });
		const ts = nowSeconds();
		const body = jsonBody({
			version: 1,
			application_id: "app-1",
			type: 1,
			event: {
				type: "ENTITLEMENT_CREATE",
				data: {
					id: "ent-replay-1",
					sku_id: SKU_KNOWN,
					user_id: "discord-2",
					application_id: "app-1",
					type: 8,
					consumed: false,
				},
			},
		});
		const sig = await signPayload(ts, body);
		const args = {
			rawBody: body,
			signatureHeader: sig,
			timestampHeader: ts,
		};
		const r1 = await handleEntitlementWebhook(args);
		const r2 = await handleEntitlementWebhook(args);
		expect(r1.status).toBe("credited");
		expect(r2.status).toBe("ignored");
		const profile = dbState.profiles.find((p) => p.userId === "user-2");
		expect(profile?.currency).toBe(SKU_AMOUNT); // NOT 2× SKU_AMOUNT
		expect(dbState.transactions).toHaveLength(1);
	});

	it("known SKU + missing user → throws USER_NOT_FOUND", async () => {
		const ts = nowSeconds();
		const body = jsonBody({
			version: 1,
			application_id: "app-1",
			type: 1,
			event: {
				type: "ENTITLEMENT_CREATE",
				data: {
					id: "ent-no-user",
					sku_id: SKU_KNOWN,
					user_id: "discord-ghost",
					application_id: "app-1",
					type: 8,
					consumed: false,
				},
			},
		});
		const sig = await signPayload(ts, body);
		let caught: unknown;
		try {
			await handleEntitlementWebhook({
				rawBody: body,
				signatureHeader: sig,
				timestampHeader: ts,
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(WebhookError);
		expect((caught as InstanceType<typeof WebhookError>).code).toBe(
			"USER_NOT_FOUND",
		);
	});

	it("missing DISCORD_PUBLIC_KEY → throws MISSING_PUBLIC_KEY", async () => {
		delete process.env.DISCORD_PUBLIC_KEY;
		const ts = nowSeconds();
		let caught: unknown;
		try {
			await handleEntitlementWebhook({
				rawBody: jsonBody({ type: 1 }),
				signatureHeader: "00".repeat(64),
				timestampHeader: ts,
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(WebhookError);
		expect((caught as InstanceType<typeof WebhookError>).code).toBe(
			"MISSING_PUBLIC_KEY",
		);
		// Restore for subsequent tests.
		process.env.DISCORD_PUBLIC_KEY = PUBLIC_KEY_HEX;
	});
});

describe("exchangeDiscordCode", () => {
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		process.env.DISCORD_CLIENT_ID = "client-id";
		process.env.DISCORD_CLIENT_SECRET = "client-secret";
	});

	afterAll(() => {
		globalThis.fetch = realFetch;
	});

	it("happy path: exchanges code → token → user → mints session", async () => {
		const calls: Array<{ url: string }> = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			calls.push({ url });
			if (url.includes("/oauth2/token")) {
				return new Response(
					JSON.stringify({
						access_token: "discord-access-token",
						token_type: "Bearer",
						expires_in: 604_800,
						refresh_token: "rt",
						scope: "identify",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/users/@me")) {
				return new Response(
					JSON.stringify({
						id: "discord-42",
						username: "userfourtytwo",
						global_name: "Forty Two",
						discriminator: "0",
						avatar: null,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const result = await exchangeDiscordCode("a-valid-oauth-code");
		expect(result.access_token).toBe("discord-access-token");
		expect(result.gacha_session_token).toBe("tok-discord-42");
		expect(result.gacha_user_id).toBe("uid-discord-42");
		expect(result.discord_user.id).toBe("discord-42");
		expect(result.discord_user.username).toBe("Forty Two");
		expect(mintedSessions).toEqual([
			{ discordId: "discord-42", displayName: "Forty Two" },
		]);
		expect(calls.length).toBe(2);
	});

	it("missing env → throws MISSING_ENV", async () => {
		delete process.env.DISCORD_CLIENT_ID;
		let caught: unknown;
		try {
			await exchangeDiscordCode("code");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(TokenExchangeError);
		expect((caught as InstanceType<typeof TokenExchangeError>).code).toBe(
			"MISSING_ENV",
		);
	});

	it("Discord 400 → throws INVALID_CODE", async () => {
		globalThis.fetch = (async () =>
			new Response("invalid_grant", {
				status: 400,
			})) as unknown as typeof fetch;
		let caught: unknown;
		try {
			await exchangeDiscordCode("bad-code");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(TokenExchangeError);
		expect((caught as InstanceType<typeof TokenExchangeError>).code).toBe(
			"INVALID_CODE",
		);
	});

	it("Discord 500 on token exchange → throws OAUTH_FAILED", async () => {
		globalThis.fetch = (async () =>
			new Response("server error", { status: 500 })) as unknown as typeof fetch;
		let caught: unknown;
		try {
			await exchangeDiscordCode("code");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(TokenExchangeError);
		expect((caught as InstanceType<typeof TokenExchangeError>).code).toBe(
			"OAUTH_FAILED",
		);
	});

	it("user fetch fail → throws USER_FETCH_FAILED", async () => {
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/oauth2/token")) {
				return new Response(
					JSON.stringify({
						access_token: "x",
						token_type: "Bearer",
						expires_in: 1,
						refresh_token: "r",
						scope: "identify",
					}),
					{ status: 200 },
				);
			}
			return new Response("nope", { status: 401 });
		}) as typeof fetch;
		let caught: unknown;
		try {
			await exchangeDiscordCode("code");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(TokenExchangeError);
		expect((caught as InstanceType<typeof TokenExchangeError>).code).toBe(
			"USER_FETCH_FAILED",
		);
	});

	it("redirectUri is forwarded to Discord /oauth2/token (PWA flow)", async () => {
		// Capture the body sent to Discord — it must be x-www-form-urlencoded
		// and contain the redirect_uri verbatim (must match the URI used in the
		// initial /authorize redirect, otherwise Discord returns invalid_grant).
		let capturedBody = "";
		globalThis.fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/oauth2/token")) {
				const body = init?.body;
				if (body instanceof URLSearchParams) {
					capturedBody = body.toString();
				} else if (typeof body === "string") {
					capturedBody = body;
				}
				return new Response(
					JSON.stringify({
						access_token: "tok",
						token_type: "Bearer",
						expires_in: 60,
						refresh_token: "rt",
						scope: "identify",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/users/@me")) {
				return new Response(
					JSON.stringify({
						id: "discord-pwa",
						username: "pwauser",
						global_name: null,
						discriminator: "0",
						avatar: null,
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const REDIRECT = "https://play.rpbey.fr/play/";
		await exchangeDiscordCode("pwa-code-12345", REDIRECT);

		// URLSearchParams encode "://" → "%3A%2F%2F"
		const params = new URLSearchParams(capturedBody);
		expect(params.get("redirect_uri")).toBe(REDIRECT);
		expect(params.get("code")).toBe("pwa-code-12345");
		expect(params.get("grant_type")).toBe("authorization_code");
	});
});
