/**
 * Ranking panel renderer — produces the Discord payload (embed + canvas
 * attachment + interactive buttons / select menu) for a given variant,
 * season and page. Consumed by:
 *   - `/classement top` slash command (first render)
 *   - `RankingInteractions` component (button/select updates)
 */
import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	StringSelectMenuBuilder,
} from "discord.js";

import { type BtsSeason, getBtsRanking } from "./bts-ranking.js";
import {
	generateLeaderboardCard,
	type LeaderboardEntry,
} from "./canvas-utils.js";
import { Colors } from "./constants.js";
import prisma from "./prisma.js";

// ─── Types ────────────────────────────────────────────────────────

export type RankingVariant = "rpb" | "wb" | "satr";

export interface SeasonRef {
	/** Opaque identifier used in the select menu customId payload. */
	key: string;
	/** Human label shown in the select menu. */
	label: string;
	/** Optional secondary label / subtitle. */
	sublabel?: string;
}

export interface PanelState {
	variant: RankingVariant;
	/** Variant-specific season key; "current" = default/active season. */
	season: string;
	/** 0-indexed page number (page 0 = ranks 1..pageSize). */
	page: number;
}

export interface PanelRenderResult {
	embed: EmbedBuilder;
	file: AttachmentBuilder;
	components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>>;
	/** Total pages for the current variant+season. */
	totalPages: number;
}

const PAGE_SIZE = 10;
const CUSTOM_ID_PREFIX = "rnk";

// ─── Helpers ──────────────────────────────────────────────────────

function computeWinRate(wins: number, losses: number): string {
	const total = wins + losses;
	if (total === 0) return "0";
	return `${Math.round((wins / total) * 100)}`;
}

/** Encode panel state into a customId payload. */
export function encodeAction(
	action: "page" | "season" | "variant",
	state: PanelState,
): string {
	return `${CUSTOM_ID_PREFIX}:${action}:${state.variant}:${state.season}:${state.page}`;
}

/** Parse a customId payload back into action + state. */
export function decodeAction(
	customId: string,
): { action: "page" | "season" | "variant"; state: PanelState } | null {
	const parts = customId.split(":");
	if (parts.length !== 5 || parts[0] !== CUSTOM_ID_PREFIX) return null;
	const [, action, variant, season, pageStr] = parts;
	if (!variant || !season || pageStr === undefined) return null;
	if (variant !== "rpb" && variant !== "wb" && variant !== "satr") return null;
	if (action !== "page" && action !== "season" && action !== "variant") {
		return null;
	}
	return {
		action,
		state: {
			variant,
			season,
			page: Math.max(0, Number.parseInt(pageStr, 10) || 0),
		},
	};
}

// ─── Season resolution ────────────────────────────────────────────

/**
 * List seasons available for a given variant, most recent first.
 * Always includes at least one entry (fallback: "current").
 */
export async function listSeasons(
	variant: RankingVariant,
): Promise<SeasonRef[]> {
	if (variant === "rpb") {
		// BTS seasons, aligned with /rankings UI (apps/rpb-dashboard SEASON_MAP).
		// S1 = BTS 1, S2 = BTS 2 → 4.
		return [
			{ key: "2", label: "Saison 2", sublabel: "BTS 2 → 4" },
			{ key: "1", label: "Saison 1", sublabel: "BTS 1" },
		];
	}
	if (variant === "wb") {
		const rows = await prisma.wbRanking.findMany({
			select: { season: true },
			distinct: ["season"],
			orderBy: { season: "desc" },
		});
		if (rows.length === 0) return [{ key: "2", label: "Saison 2" }];
		return rows.map((r) => ({
			key: String(r.season),
			label: `Saison ${r.season}`,
			sublabel:
				r.season === 1
					? "UB 1 → 11"
					: r.season === 2
						? "UB 12 → 22"
						: undefined,
		}));
	}
	// satr — aligned with dashboard: satrRanking.season is an int (1 or 2).
	const rows = await prisma.satrRanking.findMany({
		select: { season: true },
		distinct: ["season"],
		orderBy: { season: "desc" },
	});
	if (rows.length === 0) return [{ key: "2", label: "Saison 2" }];
	return rows.map((r) => ({
		key: String(r.season),
		label: `Saison ${r.season}`,
		sublabel:
			r.season === 1
				? "BBT 1 → 11"
				: r.season === 2
					? "BBT 12 → 22"
					: undefined,
	}));
}

/** Return the default season key for a variant (used on first render). */
export async function defaultSeasonKey(
	variant: RankingVariant,
): Promise<string> {
	const seasons = await listSeasons(variant);
	return seasons[0]?.key ?? "current";
}

// ─── Data loading ─────────────────────────────────────────────────

async function loadEntries(
	state: PanelState,
): Promise<{ entries: LeaderboardEntry[]; total: number }> {
	const { variant, season, page } = state;
	const skip = page * PAGE_SIZE;
	const take = PAGE_SIZE;

	if (variant === "rpb") {
		// Mirror the dashboard /rankings page — BTS aggregate from JSON exports.
		const seasonNum = Number.parseInt(season, 10);
		const btsSeason: BtsSeason = seasonNum === 1 ? 1 : 2;
		const result = await getBtsRanking(btsSeason, {
			page: page + 1,
			pageSize: PAGE_SIZE,
		});
		return {
			total: result.total,
			entries: result.entries.map((e) => ({
				avatarUrl: e.avatarUrl ?? "",
				name: e.playerName,
				points: e.points,
				rank: e.rank,
				winRate: computeWinRate(e.wins, e.losses),
				wins: e.wins,
				losses: e.losses,
				participations: e.participations,
			})),
		};
	}

	if (variant === "wb") {
		const seasonNum = Number.parseInt(season, 10);
		const where = Number.isFinite(seasonNum) ? { season: seasonNum } : {};
		const [rows, total] = await Promise.all([
			prisma.wbRanking.findMany({
				where,
				take,
				skip,
				orderBy: { rank: "asc" },
			}),
			prisma.wbRanking.count({ where }),
		]);
		return {
			total,
			entries: rows.map((r) => ({
				avatarUrl: "",
				name: r.playerName,
				points: r.score,
				rank: r.rank,
				winRate: r.winRate,
				wins: r.wins,
				losses: r.losses,
				participations: r.participation,
			})),
		};
	}

	// satr — same shape as wb on the dashboard (satrRanking table, season int).
	const seasonNum = Number.parseInt(season, 10);
	const where = Number.isFinite(seasonNum) ? { season: seasonNum } : {};
	const [rows, total] = await Promise.all([
		prisma.satrRanking.findMany({
			where,
			take,
			skip,
			orderBy: { rank: "asc" },
		}),
		prisma.satrRanking.count({ where }),
	]);
	return {
		total,
		entries: rows.map((r) => ({
			avatarUrl: "",
			name: r.playerName,
			points: r.score,
			rank: r.rank,
			winRate: r.winRate,
			wins: r.wins,
			losses: r.losses,
			participations: r.participation,
		})),
	};
}

// ─── Render ───────────────────────────────────────────────────────

const VARIANT_META: Record<
	RankingVariant,
	{ title: string; emoji: string; color: number; url: string }
> = {
	rpb: {
		title: "Classement RPB",
		emoji: "🏆",
		color: Colors.Primary,
		url: "https://rpbey.fr/rankings",
	},
	wb: {
		title: "Ultime Bataille",
		emoji: "⚡",
		color: 0x8b5cf6,
		url: "https://rpbey.fr/tournaments/wb",
	},
	satr: {
		title: "BBT · Sun After the Reign",
		emoji: "🔥",
		color: 0xef4444,
		url: "https://rpbey.fr/tournaments/satr",
	},
};

export async function renderRankingPanel(
	state: PanelState,
): Promise<PanelRenderResult> {
	const { variant } = state;
	const meta = VARIANT_META[variant];

	const [{ entries, total }, seasons] = await Promise.all([
		loadEntries(state),
		listSeasons(variant),
	]);

	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const page = Math.min(state.page, totalPages - 1);
	const currentSeason =
		seasons.find((s) => s.key === state.season) ?? seasons[0];

	const subtitle = currentSeason
		? `${currentSeason.label}${currentSeason.sublabel ? ` · ${currentSeason.sublabel}` : ""}`
		: undefined;

	const buffer = await generateLeaderboardCard(entries, {
		variant,
		subtitle,
	});

	const fileName = `classement-${variant}-${state.season}-p${page + 1}.png`;
	const file = new AttachmentBuilder(buffer, { name: fileName });

	const embed = new EmbedBuilder()
		.setColor(meta.color)
		.setTitle(`${meta.emoji} ${meta.title}`)
		.setDescription(
			`Page ${page + 1} / ${totalPages} · ${total} blader${total > 1 ? "s" : ""}`,
		)
		.setImage(`attachment://${fileName}`)
		.setFooter({
			text: `${meta.url} · Mis à jour en temps réel`,
		});

	// ── Action rows ──
	const components: Array<
		ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>
	> = [];

	// Variant switcher (always visible)
	components.push(
		new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
			new StringSelectMenuBuilder()
				.setCustomId(encodeAction("variant", { ...state, page: 0 }))
				.setPlaceholder("Choisir un classement")
				.addOptions(
					{
						label: "RPB · Global",
						value: "rpb",
						default: variant === "rpb",
						emoji: "🏆",
					},
					{
						label: "Ultime Bataille (UB)",
						value: "wb",
						default: variant === "wb",
						emoji: "⚡",
					},
					{
						label: "BBT · SATR",
						value: "satr",
						default: variant === "satr",
						emoji: "🔥",
					},
				),
		),
	);

	// Season selector (only when more than one season exists)
	if (seasons.length > 1) {
		components.push(
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
				new StringSelectMenuBuilder()
					.setCustomId(encodeAction("season", { ...state, page: 0 }))
					.setPlaceholder("Choisir une saison")
					.addOptions(
						seasons.slice(0, 25).map((s) => ({
							label: s.label,
							value: s.key,
							description: s.sublabel,
							default: s.key === state.season,
						})),
					),
			),
		);
	}

	// Pagination buttons
	components.push(
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(
					encodeAction("page", { ...state, page: Math.max(0, page - 1) }),
				)
				.setLabel("◀ Précédent")
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(page === 0),
			new ButtonBuilder()
				.setCustomId("rnk:noop")
				.setLabel(`Page ${page + 1} / ${totalPages}`)
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(true),
			new ButtonBuilder()
				.setCustomId(
					encodeAction("page", {
						...state,
						page: Math.min(totalPages - 1, page + 1),
					}),
				)
				.setLabel("Suivant ▶")
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(page >= totalPages - 1),
			new ButtonBuilder()
				.setLabel("Voir sur le site")
				.setURL(meta.url)
				.setStyle(ButtonStyle.Link),
		),
	);

	return { embed, file, components, totalPages };
}
