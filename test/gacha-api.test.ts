/**
 * test/gacha-api.test.ts
 *
 * Bun:test suite for src/lib/gacha-api.ts session minting + caching.
 *
 *  - cache hit (2nd call within TTL returns same token, no DB roundtrip)
 *  - 5-min cache buffer expiry triggers a re-mint
 *  - findReusableSession with ≥30 min remaining → no INSERT issued
 *  - concurrent calls × 5 → coalesced into a single mint (in-flight Promise)
 *  - cleanupExpiredSessions failure is swallowed (best-effort)
 *
 * Strategy : mock `pg` so `new Pool()` returns an instrumented stub. We
 * import the SUT with dynamic import after the mock is registered.
 */
import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";

// ─── Pool stub ───────────────────────────────────────────────────────────────

type QueryArgs = { sql: string; params: unknown[] };

interface PoolStub {
	query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
	calls: QueryArgs[];
	// Per-test handler — examined in order, first match wins.
	handlers: Array<{
		match: (sql: string) => boolean;
		respond: (
			sql: string,
			params: unknown[],
		) => Promise<{ rows: unknown[] }> | { rows: unknown[] };
	}>;
	failOnDelete: boolean;
}

const pool: PoolStub = {
	calls: [],
	handlers: [],
	failOnDelete: false,
	async query(sql: string, params: unknown[] = []) {
		this.calls.push({ sql, params });
		if (this.failOnDelete && /^DELETE FROM sessions/i.test(sql.trim())) {
			throw new Error("simulated delete failure");
		}
		for (const h of this.handlers) {
			if (h.match(sql)) return await h.respond(sql, params);
		}
		return { rows: [] };
	},
};

function resetPool(): void {
	pool.calls.length = 0;
	pool.handlers.length = 0;
	pool.failOnDelete = false;
}

// Mock `pg` — `gacha-api` does `import pg from "pg"; const { Pool } = pg`.
mock.module("pg", () => ({
	default: {
		Pool: class {
			constructor() {
				return pool;
			}
		},
	},
	Pool: class {
		constructor() {
			return pool;
		}
	},
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

const { ensureGachaSession, __resetGachaApiCachesForTests } = await import(
	"../src/lib/gacha-api.js"
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function installUpsertHandler(userId: string): void {
	pool.handlers.push({
		match: (sql) => /INSERT INTO users/i.test(sql),
		respond: () => ({ rows: [{ id: userId }] }),
	});
}

function installEmptyReuseHandler(): void {
	pool.handlers.push({
		match: (sql) => /SELECT token, "expiresAt"/i.test(sql),
		respond: () => ({ rows: [] }),
	});
}

function installReuseHandler(token: string, expiresAtMs: number): void {
	pool.handlers.push({
		match: (sql) => /SELECT token, "expiresAt"/i.test(sql),
		respond: () => ({
			rows: [
				{
					token,
					expires_at: new Date(expiresAtMs).toISOString(),
				},
			],
		}),
	});
}

function installInsertSessionHandler(): void {
	pool.handlers.push({
		match: (sql) => /INSERT INTO sessions/i.test(sql),
		respond: () => ({ rows: [] }),
	});
}

function installDeleteHandler(): void {
	pool.handlers.push({
		match: (sql) => /^DELETE FROM sessions/i.test(sql.trim()),
		respond: () => ({ rows: [] }),
	});
}

beforeAll(() => {
	process.env.DATABASE_URL =
		process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

beforeEach(() => {
	resetPool();
	__resetGachaApiCachesForTests();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ensureGachaSession — cache + reuse", () => {
	it("2nd call within TTL hits the in-memory cache (no extra DB roundtrip)", async () => {
		installUpsertHandler("user-uuid-1");
		installEmptyReuseHandler();
		installInsertSessionHandler();
		installDeleteHandler();

		const a = await ensureGachaSession("discord-1", "Alice");
		const callsAfterFirst = pool.calls.length;
		const b = await ensureGachaSession("discord-1", "Alice");

		expect(b.token).toBe(a.token);
		expect(b.userId).toBe(a.userId);
		// Second call should NOT have issued any new DB query.
		expect(pool.calls.length).toBe(callsAfterFirst);
	});

	it("expired cache entry forces a re-mint", async () => {
		installUpsertHandler("user-uuid-2");
		installEmptyReuseHandler();
		installInsertSessionHandler();
		installDeleteHandler();

		const a = await ensureGachaSession("discord-2", "Bob");

		// Simulate elapsed time : push Date.now well past the 5-min cache buffer.
		const realNow = Date.now;
		const fakeNow = realNow() + 6 * 3_600_000 + 1;
		const spy = spyOn(Date, "now").mockImplementation(() => fakeNow);

		// Re-install handlers because resetPool() not called between, but pool
		// still serves the same handlers; just need to ensure mint goes through.
		const b = await ensureGachaSession("discord-2", "Bob");
		spy.mockRestore();

		// New token minted (different from the cached one).
		expect(b.token).not.toBe(a.token);
	});

	it("findReusableSession with ≥30 min remaining → reuses existing token, NO INSERT", async () => {
		installUpsertHandler("user-uuid-3");
		const reusableToken = "reusable-token-deadbeef";
		const expiresAt = Date.now() + 5 * 3_600_000; // 5h remaining
		installReuseHandler(reusableToken, expiresAt);
		installDeleteHandler();

		const s = await ensureGachaSession("discord-3", "Carol");

		expect(s.token).toBe(reusableToken);
		// No INSERT INTO sessions should have been issued.
		const insertSessionCalls = pool.calls.filter((c) =>
			/INSERT INTO sessions/i.test(c.sql),
		);
		expect(insertSessionCalls.length).toBe(0);
	});

	it("5 concurrent calls coalesce into a single mint (in-flight Promise)", async () => {
		installUpsertHandler("user-uuid-4");
		installEmptyReuseHandler();
		installInsertSessionHandler();
		installDeleteHandler();

		const promises = Array.from({ length: 5 }, () =>
			ensureGachaSession("discord-4", "Dave"),
		);
		const results = await Promise.all(promises);

		// All 5 callers got the *same* token (coalesced).
		const tokens = new Set(results.map((r) => r.token));
		expect(tokens.size).toBe(1);

		// And only one INSERT INTO sessions was issued.
		const insertSessionCalls = pool.calls.filter((c) =>
			/INSERT INTO sessions/i.test(c.sql),
		);
		expect(insertSessionCalls.length).toBe(1);
	});

	it("cleanupExpiredSessions failure is swallowed (best-effort)", async () => {
		installUpsertHandler("user-uuid-5");
		installEmptyReuseHandler();
		installInsertSessionHandler();
		// No delete handler — pool.failOnDelete makes DELETE throw.
		pool.failOnDelete = true;

		// The cleanup is fire-and-forget (`void cleanupExpiredSessions(...)`),
		// so the mint should still resolve cleanly.
		const s = await ensureGachaSession("discord-5", "Eve");
		expect(typeof s.token).toBe("string");
		expect(s.token.length).toBeGreaterThan(0);

		// Yield to the microtask queue so the background cleanup can crash safely.
		await new Promise((r) => setTimeout(r, 10));
	});
});
