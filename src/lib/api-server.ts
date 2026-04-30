import { timingSafeEqual } from "node:crypto";
import { type Server, type ServerWebSocket } from "bun";
import { bot } from "./bot.js";
import {
	exchangeDiscordCode,
	handleEntitlementWebhook,
	TokenExchangeError,
	WebhookError,
} from "./discord-activity.js";
import { logger } from "./logger.js";

// In-memory log buffer
const logs: { timestamp: string; level: string; message: string }[] = [];
const MAX_LOGS = 1000;

export function addLog(level: string, message: string) {
	const entry = { timestamp: new Date().toISOString(), level, message };
	logs.push(entry);
	if (logs.length > MAX_LOGS) logs.shift();
	// Fan out to any WebSocket subscriber on the "logs" topic.
	publishEvent("logs", entry);
}

type WsData = { ip: string; topics: Set<string> };

// Module-level handle so other files (bot.ts, log-capture) can publish events.
let serverRef: Server<WsData> | null = null;

export function publishEvent(topic: string, payload: unknown): number {
	if (!serverRef) return 0;
	const msg = JSON.stringify({ topic, data: payload, ts: Date.now() });
	return serverRef.publish(topic, msg);
}

export function wsSubscriberCount(topic: string): number {
	return serverRef?.subscriberCount(topic) ?? 0;
}

export function getLogs(tail = 100) {
	return logs.slice(-tail);
}

// Rate limiting
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const requestCounts = new Map<string, { count: number; startTime: number }>();

setInterval(() => {
	const now = Date.now();
	for (const [ip, record] of requestCounts.entries()) {
		if (now - record.startTime > RATE_LIMIT_WINDOW) {
			requestCounts.delete(ip);
		}
	}
}, RATE_LIMIT_WINDOW);

function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const record = requestCounts.get(ip);
	if (!record || now - record.startTime > RATE_LIMIT_WINDOW) {
		requestCounts.set(ip, { count: 1, startTime: now });
		return true;
	}
	if (record.count >= RATE_LIMIT_MAX) return false;
	record.count++;
	return true;
}

function formatUptime(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	const d = Math.floor(h / 24);
	if (d > 0) return `${d}j ${h % 24}h ${m % 60}m`;
	if (h > 0) return `${h}h ${m % 60}m`;
	return `${m}m ${s % 60}s`;
}

async function getBotStatus() {
	const client = bot;
	const guild = await client.guilds
		.fetch({ guild: process.env.GUILD_ID ?? "", withCounts: true })
		.catch(() => null);

	return {
		status: client.isReady() ? "running" : "starting",
		uptime: client.uptime ?? 0,
		uptimeFormatted: formatUptime(client.uptime ?? 0),
		guilds: client.guilds.cache.size,
		users: client.users.cache.size,
		memberCount: guild?.approximateMemberCount ?? guild?.memberCount ?? 0,
		onlineCount: guild?.approximatePresenceCount ?? 0,
		ping: client.ws.ping,
		memoryUsage: `${(process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(2)} MB`,
		runtime: `Bun ${Bun.version}`,
	};
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS, POST",
	"Access-Control-Allow-Headers": "Content-Type, x-api-key",
};

/** Auth middleware — validates API key on every non-OPTIONS request */
function authenticate(req: Request): Response | null {
	const expectedKey = process.env.BOT_API_KEY;
	if (!expectedKey) {
		logger.error("BOT_API_KEY not set in environment!");
		return Response.json(
			{ error: "Server misconfiguration" },
			{ status: 500, headers: CORS_HEADERS },
		);
	}

	const apiKey = req.headers.get("x-api-key") ?? "";
	const providedBuf = new TextEncoder().encode(apiKey);
	const expectedBuf = new TextEncoder().encode(expectedKey);

	if (
		providedBuf.length !== expectedBuf.length ||
		!timingSafeEqual(providedBuf, expectedBuf)
	) {
		return Response.json(
			{ error: "Unauthorized" },
			{ status: 401, headers: CORS_HEADERS },
		);
	}

	return null; // Auth passed
}

const ALLOWED_TOPICS = new Set(["logs", "bot-events", "discord-events"]);

export function startApiServer(port = 3001) {
	let server: Server<WsData>;
	try {
		server = buildServer(port);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "EADDRINUSE") {
			console.error(
				`[api-server] Port ${port} is already bound — another bot instance is likely running. Aborting.`,
			);
			process.exit(13);
		}
		throw e;
	}
	serverRef = server;
	logger.info(`Bot API server listening on http://127.0.0.1:${port} (ws: /ws)`);
	return server;
}

function buildServer(port: number): Server<WsData> {
	return Bun.serve<WsData>({
		port,
		hostname: "127.0.0.1",

		routes: {
			// WebSocket upgrade — auth via `?key=<BOT_API_KEY>` (browser clients can't set headers).
			"/ws": (req: Request, srv: Server<WsData>) => {
				const expectedKey = process.env.BOT_API_KEY ?? "";
				const providedKey = new URL(req.url).searchParams.get("key") ?? "";
				if (!expectedKey) {
					return new Response("BOT_API_KEY not configured", { status: 500 });
				}
				const a = new TextEncoder().encode(providedKey);
				const b = new TextEncoder().encode(expectedKey);
				if (a.length !== b.length || !timingSafeEqual(a, b)) {
					return new Response("Unauthorized", { status: 401 });
				}
				const ip = srv.requestIP(req)?.address ?? "unknown";
				const ok = srv.upgrade(req, {
					data: { ip, topics: new Set<string>() },
				});
				return ok ? undefined : new Response("Upgrade failed", { status: 400 });
			},

			// Public health probes — no auth, no state exposure beyond liveness/readiness.
			// Consumed by systemd watchdog + `next service monitor`.
			"/health": () =>
				Response.json(
					{ status: "ok", uptime: process.uptime() },
					{ headers: CORS_HEADERS },
				),
			"/ready": () => {
				const ready = bot.isReady();
				return Response.json(
					{ ready, ping: ready ? bot.ws.ping : null },
					{ status: ready ? 200 : 503, headers: CORS_HEADERS },
				);
			},
			"/metrics": () => {
				const mem = process.memoryUsage();
				const body = [
					`# HELP rpb_bot_ready 1 if Discord gateway is ready, 0 otherwise`,
					`# TYPE rpb_bot_ready gauge`,
					`rpb_bot_ready ${bot.isReady() ? 1 : 0}`,
					`# HELP rpb_bot_ws_ping Discord websocket ping in ms`,
					`# TYPE rpb_bot_ws_ping gauge`,
					`rpb_bot_ws_ping ${bot.isReady() ? bot.ws.ping : -1}`,
					`# HELP rpb_bot_guilds Number of cached guilds`,
					`# TYPE rpb_bot_guilds gauge`,
					`rpb_bot_guilds ${bot.guilds.cache.size}`,
					`# HELP rpb_bot_heap_bytes Heap used in bytes`,
					`# TYPE rpb_bot_heap_bytes gauge`,
					`rpb_bot_heap_bytes ${mem.heapUsed}`,
					`# HELP rpb_bot_rss_bytes Resident set size in bytes`,
					`# TYPE rpb_bot_rss_bytes gauge`,
					`rpb_bot_rss_bytes ${mem.rss}`,
					`# HELP rpb_bot_uptime_seconds Process uptime in seconds`,
					`# TYPE rpb_bot_uptime_seconds counter`,
					`rpb_bot_uptime_seconds ${process.uptime()}`,
					"",
				].join("\n");
				return new Response(body, {
					headers: {
						...CORS_HEADERS,
						"Content-Type": "text/plain; version=0.0.4",
					},
				});
			},

			"/api/status": {
				GET: async (req: Request) => {
					const authError = authenticate(req);
					if (authError) return authError;
					return Response.json(await getBotStatus(), { headers: CORS_HEADERS });
				},
				OPTIONS: () =>
					new Response(null, { status: 204, headers: CORS_HEADERS }),
			},

			"/api/logs": {
				GET: (req: Request) => {
					const authError = authenticate(req);
					if (authError) return authError;
					const url = new URL(req.url);
					const tail = parseInt(url.searchParams.get("tail") ?? "100", 10);
					const since = url.searchParams.get("since");
					let filtered = getLogs(Math.min(tail, MAX_LOGS));
					if (since) {
						filtered = filtered.filter((l) => l.timestamp > since);
					}
					return Response.json({ logs: filtered }, { headers: CORS_HEADERS });
				},
				OPTIONS: () =>
					new Response(null, { status: 204, headers: CORS_HEADERS }),
			},

			"/api/commands": {
				GET: (req: Request) => {
					const authError = authenticate(req);
					if (authError) return authError;
					const commands = bot.applicationCommands.map((cmd) => ({
						name: cmd.name,
						description: cmd.description,
						category: "group" in cmd ? String(cmd.group) : "Général",
					}));
					return Response.json({ commands }, { headers: CORS_HEADERS });
				},
				OPTIONS: () =>
					new Response(null, { status: 204, headers: CORS_HEADERS }),
			},

			// ─── Discord Activity bridge ─────────────────────────────────────
			// Endpoints publics (pas de BOT_API_KEY) : appelés depuis l'iframe
			// Activity (origin = <APP_ID>.discordsays.com, proxifié via
			// patchUrlMappings du SDK Embedded). L'auth réelle vient du code
			// OAuth Discord (single-use, 10 min) ou de la signature Ed25519.

			"/api/discord/token-exchange": {
				POST: async (req: Request, srv: Server<WsData>) => {
					const ip = srv.requestIP(req)?.address ?? "unknown";
					if (!checkRateLimit(ip)) {
						return Response.json(
							{ error: "Too Many Requests" },
							{ status: 429, headers: CORS_HEADERS },
						);
					}
					let code: string;
					try {
						const body = (await req.json()) as { code?: unknown };
						if (typeof body.code !== "string" || body.code.length < 10) {
							return Response.json(
								{ error: "BAD_REQUEST", message: "code (string) required" },
								{ status: 400, headers: CORS_HEADERS },
							);
						}
						code = body.code;
					} catch {
						return Response.json(
							{ error: "BAD_REQUEST", message: "invalid JSON body" },
							{ status: 400, headers: CORS_HEADERS },
						);
					}

					try {
						const result = await exchangeDiscordCode(code);
						return Response.json(result, { headers: CORS_HEADERS });
					} catch (err) {
						if (err instanceof TokenExchangeError) {
							const status =
								err.code === "MISSING_ENV"
									? 500
									: err.code === "INVALID_CODE"
										? 400
										: 502;
							return Response.json(
								{ error: err.code, message: err.message },
								{ status, headers: CORS_HEADERS },
							);
						}
						logger.error({ err }, "token-exchange unexpected failure");
						return Response.json(
							{ error: "INTERNAL", message: "Internal error" },
							{ status: 500, headers: CORS_HEADERS },
						);
					}
				},
				OPTIONS: () =>
					new Response(null, { status: 204, headers: CORS_HEADERS }),
			},

			"/api/discord/webhook/entitlement": {
				POST: async (req: Request) => {
					// Webhook IAP Discord : signature Ed25519 obligatoire.
					// Pas de rate-limit IP ici (Discord peut burst après une vague d'achats).
					const rawBody = await req.text();
					const signature = req.headers.get("x-signature-ed25519");
					const timestamp = req.headers.get("x-signature-timestamp");
					try {
						const result = await handleEntitlementWebhook({
							rawBody,
							signatureHeader: signature,
							timestampHeader: timestamp,
						});
						// Discord PING handshake : { type: 1 } → respond { type: 1 }
						if (result.status === "pong") {
							return Response.json({ type: 1 }, { headers: CORS_HEADERS });
						}
						return Response.json(
							{ ok: true, ...result },
							{ headers: CORS_HEADERS },
						);
					} catch (err) {
						if (err instanceof WebhookError) {
							const status =
								err.code === "INVALID_SIGNATURE"
									? 401
									: err.code === "USER_NOT_FOUND"
										? 404
										: 500;
							return Response.json(
								{ error: err.code, message: err.message },
								{ status, headers: CORS_HEADERS },
							);
						}
						logger.error({ err }, "entitlement webhook unexpected failure");
						return Response.json(
							{ error: "INTERNAL", message: "Internal error" },
							{ status: 500, headers: CORS_HEADERS },
						);
					}
				},
			},
		},

		// Fallback for unmatched routes
		fetch(req: Request, srv: Server<WsData>) {
			// Rate limiting on fallback
			const ip = srv.requestIP(req)?.address ?? "unknown";
			if (!checkRateLimit(ip)) {
				return Response.json(
					{ error: "Too Many Requests" },
					{ status: 429, headers: CORS_HEADERS },
				);
			}

			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			}

			return Response.json(
				{ error: "Not found" },
				{ status: 404, headers: CORS_HEADERS },
			);
		},

		websocket: {
			maxPayloadLength: 256 * 1024, // 256 KB — no client needs more than that for control msgs
			perMessageDeflate: true,
			idleTimeout: 120,
			backpressureLimit: 1024 * 1024,
			publishToSelf: false,

			open(ws: ServerWebSocket<WsData>) {
				ws.send(
					JSON.stringify({
						topic: "welcome",
						data: { availableTopics: [...ALLOWED_TOPICS] },
						ts: Date.now(),
					}),
				);
			},

			message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
				// Clients send JSON {action: "subscribe"|"unsubscribe", topic: string}
				let payload: { action?: string; topic?: string };
				try {
					payload = JSON.parse(typeof raw === "string" ? raw : raw.toString());
				} catch {
					ws.send(JSON.stringify({ error: "invalid_json" }));
					return;
				}
				const { action, topic } = payload;
				if (!topic || !ALLOWED_TOPICS.has(topic)) {
					ws.send(JSON.stringify({ error: "unknown_topic", topic }));
					return;
				}
				if (action === "subscribe") {
					ws.subscribe(topic);
					ws.data.topics.add(topic);
					ws.send(JSON.stringify({ ack: "subscribed", topic }));
				} else if (action === "unsubscribe") {
					ws.unsubscribe(topic);
					ws.data.topics.delete(topic);
					ws.send(JSON.stringify({ ack: "unsubscribed", topic }));
				} else {
					ws.send(JSON.stringify({ error: "invalid_action", action }));
				}
			},

			close(ws: ServerWebSocket<WsData>) {
				for (const t of ws.data.topics) ws.unsubscribe(t);
			},
		},

		error(error) {
			logger.error("API Server Error:", error);
			return Response.json(
				{ error: "Internal server error" },
				{ status: 500, headers: CORS_HEADERS },
			);
		},
	});
}
