/**
 * test/api-server.test.ts
 *
 * Bun:test suite for src/lib/api-server.ts → `servePlayBundle`.
 *
 *  - /play/index.html             → 200 text/html
 *  - /play/chunks/abc.css         → 200 text/css + Cache-Control immutable
 *  - /play/lobby (no extension)   → SPA fallback to index.html
 *  - /play/foo.bar (extension, missing) → 404
 *  - /play/../etc/passwd          → 403 (path traversal blocked)
 *  - /play/foo.wasm               → 200 application/wasm
 *  - /play/foo.ico                → 200 image/x-icon
 *
 * The fixtures live in test/fixtures/play-bundle/. We point
 * GACHA_CLIENT_DIST at that directory BEFORE importing the SUT (the env
 * variable is read at module-evaluation time).
 *
 * Note : importing api-server.ts pulls in bot.ts which triggers a discord
 * Client init. We avoid that by mocking ./bot.js and ./logger.js to
 * lightweight stubs.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { resolve } from "node:path";

// Resolve fixture dir BEFORE importing the SUT (PLAY_BUNDLE_DIR is captured
// at module-eval time).
const FIXTURE_DIR = resolve(import.meta.dir, "fixtures/play-bundle");
process.env.GACHA_CLIENT_DIST = FIXTURE_DIR;

// Stub heavy submodules to keep the import side-effect-free.
mock.module("../src/lib/bot.js", () => ({
	bot: {
		isReady: () => false,
		uptime: 0,
		guilds: { cache: { size: 0 }, fetch: async () => null },
		users: { cache: { size: 0 } },
		ws: { ping: 0 },
		applicationCommands: [],
	},
}));

mock.module("../src/lib/logger.js", () => ({
	logger: {
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
		debug: () => undefined,
	},
}));

// Avoid pulling discord-activity → prisma → pg.
mock.module("../src/lib/discord-activity.js", () => ({
	exchangeDiscordCode: async () => {
		throw new Error("not used in this test");
	},
	handleEntitlementWebhook: async () => ({ status: "ignored" }),
	TokenExchangeError: class extends Error {
		code = "STUB";
	},
	WebhookError: class extends Error {
		code = "STUB";
	},
}));

const { servePlayBundle } = await import("../src/lib/api-server.js");

beforeAll(() => {
	// Sanity check — fixtures present.
	expect(Bun.file(`${FIXTURE_DIR}/index.html`).exists()).resolves.toBe(true);
});

describe("servePlayBundle", () => {
	it("/play/index.html → 200 text/html", async () => {
		const res = await servePlayBundle("/play/index.html");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("play-bundle-fixture");
	});

	it("/play/ → 200 text/html (root → index.html)", async () => {
		const res = await servePlayBundle("/play/");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
	});

	it("/play/chunks/abc.css → 200 text/css + immutable Cache-Control", async () => {
		const res = await servePlayBundle("/play/chunks/abc.css");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/css");
		expect(res.headers.get("Cache-Control")).toContain("immutable");
	});

	it("/play/lobby (no extension) → SPA fallback to index.html", async () => {
		const res = await servePlayBundle("/play/lobby");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("play-bundle-fixture");
	});

	it("/play/foo.bar (extension, missing) → 404", async () => {
		const res = await servePlayBundle("/play/foo.bar");
		expect(res.status).toBe(404);
	});

	it("/play/../etc/passwd → 403 (path traversal blocked)", async () => {
		const res = await servePlayBundle("/play/../etc/passwd");
		expect(res.status).toBe(403);
	});

	it("/play/%2e%2e/etc/passwd → 403 (encoded traversal blocked)", async () => {
		const res = await servePlayBundle("/play/%2e%2e/etc/passwd");
		expect(res.status).toBe(403);
	});

	it("/play/foo.wasm → 200 application/wasm", async () => {
		const res = await servePlayBundle("/play/foo.wasm");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/wasm");
	});

	it("/play/foo.ico → 200 image/x-icon", async () => {
		const res = await servePlayBundle("/play/foo.ico");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/x-icon");
	});
});
