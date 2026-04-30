import { createCanvas, GlobalFonts, loadImage } from "@aphrody-code/canvas";
import sharp from "sharp";

import { resolveRootPath } from "./paths.js";

const getAssetPath = (relative: string) => resolveRootPath(relative);

// Register fonts
const fontPath = getAssetPath(
	"public/Google_Sans_Flex/static/GoogleSansFlex_72pt-Bold.ttf",
);
GlobalFonts.registerFromPath(fontPath, "GoogleSans");

// Register emoji font for canvas text rendering
try {
	GlobalFonts.registerFromPath(
		"/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
		"NotoEmoji",
	);
} catch {
	// Emoji font not available — fallback to text symbols
}

// Font string with emoji fallback
const _FONT = (weight: string, size: number) =>
	`${weight} ${size}px GoogleSans, NotoEmoji, sans-serif`;

type CanvasImage = Awaited<ReturnType<typeof loadImage>>;
type CanvasCtx = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

const NON_TRANSPARENT_EXTS = /\.(jpe?g|webp|bmp|tiff?)(\?.*)?$/i;

/**
 * Remove white/light backgrounds from images.
 * Uses sharp unflatten for simple cases, then applies a pixel-level
 * threshold to catch near-white (#F0F0F0+) backgrounds with tolerance.
 */
async function removeWhiteBackground(input: string | Buffer): Promise<Buffer> {
	// First pass: sharp unflatten handles pure white
	const unflattened = await sharp(input).unflatten().png().toBuffer();

	// Second pass: threshold-based removal for near-white pixels
	// This catches light grey backgrounds (#F0F0F0+)
	const { data, info } = await sharp(unflattened)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });

	const threshold = 240; // Pixels with R,G,B all >= 240 → transparent
	const pixels = new Uint8Array(data.buffer, data.byteOffset, data.length);
	for (let i = 0; i < pixels.length; i += 4) {
		const r = pixels[i]!;
		const g = pixels[i + 1]!;
		const b = pixels[i + 2]!;
		if (r >= threshold && g >= threshold && b >= threshold) {
			pixels[i + 3] = 0; // Set alpha to 0
		}
	}

	return sharp(Buffer.from(pixels.buffer), {
		raw: { width: info.width, height: info.height, channels: 4 },
	})
		.png()
		.toBuffer();
}

// Domains where we should NOT apply white background removal (avatars, CDN)
const SKIP_BG_REMOVAL_DOMAINS = [
	"cdn.discordapp.com",
	"cdn.discord.com",
	"images-ext-",
	"media.discordapp.net",
];

async function safeLoadImage(url: string | null): Promise<CanvasImage | null> {
	if (!url) return null;
	try {
		let imageToLoad: string | Buffer = url;
		if (url.startsWith("/")) {
			imageToLoad = getAssetPath(`public${url}`);
		}

		// Skip bg removal for avatar/CDN URLs — they don't need it
		const isExternalAvatar =
			typeof imageToLoad === "string" &&
			SKIP_BG_REMOVAL_DOMAINS.some((d) => imageToLoad.toString().includes(d));

		// Remove white background only for local non-transparent formats
		if (
			!isExternalAvatar &&
			typeof imageToLoad === "string" &&
			NON_TRANSPARENT_EXTS.test(imageToLoad)
		) {
			if (imageToLoad.startsWith("http")) {
				const res = await fetch(imageToLoad);
				const buf = Buffer.from(await res.arrayBuffer());
				imageToLoad = await removeWhiteBackground(buf);
			} else {
				imageToLoad = await removeWhiteBackground(imageToLoad);
			}
		}

		// For HTTP URLs that weren't processed above, fetch as buffer first
		if (typeof imageToLoad === "string" && imageToLoad.startsWith("http")) {
			const res = await fetch(imageToLoad);
			if (!res.ok) return null;
			const buf = Buffer.from(await res.arrayBuffer());
			return await loadImage(buf);
		}

		return await loadImage(imageToLoad);
	} catch (_e) {
		return null;
	}
}

/**
 * Force-remove white background even for PNG images.
 * Use this specifically for character/portrait images that may have
 * white backgrounds even in PNG format.
 */
async function _loadImageNoWhiteBg(
	url: string | null,
): Promise<CanvasImage | null> {
	if (!url) return null;
	try {
		let source: string | Buffer = url;
		if (url.startsWith("/")) {
			source = getAssetPath(`public${url}`);
		}
		if (typeof source === "string" && source.startsWith("http")) {
			const res = await fetch(source);
			source = Buffer.from(await res.arrayBuffer());
		}
		const cleaned = await removeWhiteBackground(source);
		return await loadImage(cleaned);
	} catch (_e) {
		return null;
	}
}

/** Load image directly without white background removal */
async function _loadImageDirect(
	url: string | null,
): Promise<CanvasImage | null> {
	if (!url) return null;
	try {
		let source: string | Buffer = url;
		if (url.startsWith("/")) {
			source = getAssetPath(`public${url}`);
		}
		if (typeof source === "string" && source.startsWith("http")) {
			const res = await fetch(source);
			source = Buffer.from(await res.arrayBuffer());
		}
		return await loadImage(source);
	} catch (_e) {
		return null;
	}
}

export async function generateWelcomeImage(
	displayName: string,
	avatarUrl: string,
	memberCount: number,
) {
	const width = 900;
	const height = 420;
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	const [background, splashLines, avatar] = await Promise.all([
		safeLoadImage("/banner.webp"),
		safeLoadImage(getAssetPath("bot/assets/backgrounds/splash-lines.png")),
		safeLoadImage(avatarUrl),
	]);

	// ── Dark warm background ──
	ctx.fillStyle = "#1d1b1b";
	ctx.fillRect(0, 0, width, height);

	if (background) {
		ctx.globalAlpha = 0.25;
		ctx.drawImage(background, 0, 0, width, height);
		ctx.globalAlpha = 1;
	}

	// ── Speed lines overlay ──
	if (splashLines) {
		ctx.globalAlpha = 0.08;
		ctx.drawImage(splashLines, 0, 0, width, height);
		ctx.globalAlpha = 1;
	}

	// ── Diagonal speed lines (subtle) ──
	ctx.save();
	ctx.globalAlpha = 0.03;
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 1;
	for (let i = -height; i < width + height; i += 14) {
		ctx.beginPath();
		ctx.moveTo(i, 0);
		ctx.lineTo(i + height * 0.5, height);
		ctx.stroke();
	}
	ctx.restore();

	// ── Left radial glow (red/orange) ──
	const glow = ctx.createRadialGradient(
		160,
		height / 2,
		0,
		160,
		height / 2,
		220,
	);
	glow.addColorStop(0, "rgba(206, 12, 7, 0.15)");
	glow.addColorStop(0.6, "rgba(230, 128, 2, 0.05)");
	glow.addColorStop(1, "transparent");
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, width, height);

	// ── Avatar with glow ring ──
	const avatarX = 160;
	const avatarY = height / 2;
	const avatarR = 95;

	// Outer glow
	ctx.save();
	ctx.shadowColor = "#ce0c07";
	ctx.shadowBlur = 25;
	ctx.beginPath();
	ctx.arc(avatarX, avatarY, avatarR + 4, 0, Math.PI * 2);
	ctx.strokeStyle = "#ce0c07";
	ctx.lineWidth = 4;
	ctx.stroke();
	ctx.restore();

	// Avatar clip
	ctx.save();
	ctx.beginPath();
	ctx.arc(avatarX, avatarY, avatarR, 0, Math.PI * 2, true);
	ctx.closePath();
	ctx.clip();
	if (avatar)
		ctx.drawImage(
			avatar,
			avatarX - avatarR,
			avatarY - avatarR,
			avatarR * 2,
			avatarR * 2,
		);
	else {
		ctx.fillStyle = "#2d2929";
		ctx.fill();
	}
	ctx.restore();

	// Gradient border ring (red → orange → yellow)
	ctx.lineWidth = 5;
	const ringGrad = ctx.createConicGradient(0, avatarX, avatarY);
	ringGrad.addColorStop(0, "#ce0c07");
	ringGrad.addColorStop(0.33, "#e68002");
	ringGrad.addColorStop(0.66, "#f7d301");
	ringGrad.addColorStop(1, "#ce0c07");
	ctx.strokeStyle = ringGrad;
	ctx.beginPath();
	ctx.arc(avatarX, avatarY, avatarR, 0, Math.PI * 2, true);
	ctx.stroke();

	// ── Text content (right side) ──
	const textX = 310;

	ctx.font = _FONT("bold", 40);
	ctx.fillStyle = "#f5f0f0";
	ctx.fillText("BIENVENUE À LA", textX, 145);

	// RPB with gradient-like effect
	ctx.font = _FONT("bold", 72);
	ctx.fillStyle = "#ce0c07";
	ctx.fillText("R", textX, 220);
	const rW = ctx.measureText("R").width;
	ctx.fillStyle = "#e68002";
	ctx.fillText("P", textX + rW, 220);
	const pW = ctx.measureText("P").width;
	ctx.fillStyle = "#f7d301";
	ctx.fillText("B !", textX + rW + pW, 220);

	// Username
	const nameText =
		displayName.length > 22
			? `${displayName.substring(0, 22).toUpperCase()}…`
			: displayName.toUpperCase();
	ctx.font = _FONT("bold", 30);
	ctx.fillStyle = "#f5f0f0";
	ctx.fillText(nameText, textX, 275);

	// Member count pill
	const memberText = `MEMBRE #${memberCount}`;
	ctx.font = _FONT("bold", 16);
	const memberW = ctx.measureText(memberText).width + 24;
	ctx.fillStyle = "rgba(206, 12, 7, 0.2)";
	ctx.beginPath();
	ctx.roundRect(textX, 290, memberW, 30, 15);
	ctx.fill();
	ctx.fillStyle = "#a89999";
	ctx.fillText(memberText, textX + 12, 310);

	// ── Bottom branding line ──
	ctx.font = _FONT("bold", 12);
	ctx.fillStyle = "#a8999950";
	ctx.fillText("RÉPUBLIQUE POPULAIRE DU BEYBLADE", textX, height - 25);

	// ── Subtle top/bottom border lines ──
	const borderGrad = ctx.createLinearGradient(0, 0, width, 0);
	borderGrad.addColorStop(0, "#ce0c07");
	borderGrad.addColorStop(0.5, "#e68002");
	borderGrad.addColorStop(1, "#f7d301");
	ctx.fillStyle = borderGrad;
	ctx.fillRect(0, 0, width, 3);
	ctx.fillRect(0, height - 3, width, 3);

	return canvas.toBuffer("image/png");
}

export interface ProfileCardData {
	bladerName: string;
	avatarUrl: string;
	rankTitle: string;
	rank: number;
	wins: number;
	losses: number;
	tournamentWins: number;
	tournamentsPlayed: number;
	rankingPoints: number;
	joinedAt: string;
	currentStreak: number;
	bestStreak: number;
	winRate: string;
	activeDeck?: {
		name: string;
		blades: { name: string; imageUrl: string | null }[];
	} | null;
}

export async function generateProfileCard(data: ProfileCardData) {
	const width = 1100;
	const height = 700;
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	const [background, avatar, logo, ...bladeImages] = await Promise.all([
		safeLoadImage("/canvas.webp"),
		safeLoadImage(data.avatarUrl),
		safeLoadImage("/logo.webp"),
		...(data.activeDeck?.blades.map((b) => safeLoadImage(b.imageUrl)) || []),
	]);

	// ── Dark warm background ──
	ctx.fillStyle = "#141111";
	ctx.fillRect(0, 0, width, height);

	if (background) {
		ctx.globalAlpha = 0.15;
		ctx.drawImage(background, 0, 0, width, height);
		ctx.globalAlpha = 1;
	}

	// ── Subtle diagonal speed lines ──
	ctx.save();
	ctx.globalAlpha = 0.025;
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 1;
	for (let i = -height; i < width + height; i += 16) {
		ctx.beginPath();
		ctx.moveTo(i, 0);
		ctx.lineTo(i + height * 0.5, height);
		ctx.stroke();
	}
	ctx.restore();

	// ── Main card container (rounded, elevated surface) ──
	ctx.fillStyle = "#1d1b1b";
	ctx.beginPath();
	ctx.roundRect(24, 24, width - 48, height - 48, 16);
	ctx.fill();

	// Inner subtle border
	ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.roundRect(24, 24, width - 48, height - 48, 16);
	ctx.stroke();

	// ── Top gradient accent bar (RPB colors) ──
	const topGrad = ctx.createLinearGradient(24, 0, width - 24, 0);
	topGrad.addColorStop(0, "#ce0c07");
	topGrad.addColorStop(0.5, "#e68002");
	topGrad.addColorStop(1, "#f7d301");
	ctx.fillStyle = topGrad;
	ctx.beginPath();
	ctx.roundRect(24, 24, width - 48, 4, [16, 16, 0, 0]);
	ctx.fill();

	// ── Avatar with gradient ring ──
	const avX = 160;
	const avY = 190;
	const avR = 100;

	// Glow
	ctx.save();
	ctx.shadowColor = "#ce0c0740";
	ctx.shadowBlur = 30;
	ctx.beginPath();
	ctx.arc(avX, avY, avR + 5, 0, Math.PI * 2);
	ctx.strokeStyle = "#ce0c07";
	ctx.lineWidth = 3;
	ctx.stroke();
	ctx.restore();

	// Avatar clip
	ctx.save();
	ctx.beginPath();
	ctx.arc(avX, avY, avR, 0, Math.PI * 2, true);
	ctx.closePath();
	ctx.clip();
	if (avatar) ctx.drawImage(avatar, avX - avR, avY - avR, avR * 2, avR * 2);
	else {
		ctx.fillStyle = "#2d2929";
		ctx.fill();
	}
	ctx.restore();

	// Gradient ring
	const ringG = ctx.createConicGradient(0, avX, avY);
	ringG.addColorStop(0, "#ce0c07");
	ringG.addColorStop(0.33, "#e68002");
	ringG.addColorStop(0.66, "#f7d301");
	ringG.addColorStop(1, "#ce0c07");
	ctx.strokeStyle = ringG;
	ctx.lineWidth = 5;
	ctx.beginPath();
	ctx.arc(avX, avY, avR, 0, Math.PI * 2, true);
	ctx.stroke();

	// ── Blader name ──
	const nameX = 300;
	const nameText =
		data.bladerName.length > 18
			? `${data.bladerName.substring(0, 18).toUpperCase()}…`
			: data.bladerName.toUpperCase();
	ctx.font = _FONT("bold", 48);
	ctx.fillStyle = "#f5f0f0";
	ctx.fillText(nameText, nameX, 110);

	// ── Rank badge pill ──
	let badgeColor = "#64748b";
	let badgeText = "#ffffff";
	if (data.rank === 1) {
		badgeColor = "#f7d301";
		badgeText = "#000000";
	} else if (data.rank === 2) {
		badgeColor = "#C0C0C0";
		badgeText = "#000000";
	} else if (data.rank === 3) {
		badgeColor = "#CD7F32";
		badgeText = "#000000";
	} else if (data.rankTitle === "Champion") {
		badgeColor = "#ce0c07";
		badgeText = "#ffffff";
	} else if (data.rankTitle === "Expert") {
		badgeColor = "#e68002";
		badgeText = "#000000";
	}

	const rankLabel = `RANG #${data.rank} • ${data.rankTitle.toUpperCase()}`;
	ctx.font = _FONT("bold", 16);
	const rankW = ctx.measureText(rankLabel).width + 30;
	ctx.fillStyle = badgeColor;
	ctx.beginPath();
	ctx.roundRect(nameX, 125, rankW, 32, 16);
	ctx.fill();
	ctx.fillStyle = badgeText;
	ctx.fillText(rankLabel, nameX + 15, 146);

	// ── Stats grid (2 rows × 3 cols) ──
	const drawStat = (
		label: string,
		value: string | number,
		x: number,
		y: number,
		color = "#f7d301",
	) => {
		// Label
		ctx.font = _FONT("bold", 13);
		ctx.fillStyle = "#a89999";
		ctx.fillText(label, x, y);
		// Value
		ctx.font = _FONT("bold", 36);
		ctx.fillStyle = color;
		ctx.fillText(value.toString(), x, y + 40);
	};

	const gridX = nameX;
	const gridY = 185;
	const colW = 190;
	const rowH = 85;

	drawStat(
		"POINTS",
		data.rankingPoints.toLocaleString(),
		gridX,
		gridY,
		"#f7d301",
	);
	drawStat("WIN RATE", data.winRate, gridX + colW, gridY, "#f5f0f0");
	drawStat(
		"TOURNOIS",
		`${data.tournamentWins}/${data.tournamentsPlayed}`,
		gridX + colW * 2,
		gridY,
		"#e68002",
	);
	drawStat("VICTOIRES", data.wins, gridX, gridY + rowH, "#22c55e");
	drawStat("DÉFAITES", data.losses, gridX + colW, gridY + rowH, "#ef4444");
	drawStat(
		"TOTAL",
		data.wins + data.losses,
		gridX + colW * 2,
		gridY + rowH,
		"#f5f0f0",
	);

	// ── Streak info (small, below stats) ──
	if (data.currentStreak > 0 || data.bestStreak > 0) {
		ctx.font = _FONT("bold", 14);
		ctx.fillStyle = "#a89999";
		const streakY = gridY + rowH * 2 + 10;
		ctx.fillText(
			`🔥 Série actuelle: ${data.currentStreak}  •  Meilleure: ${data.bestStreak}`,
			gridX,
			streakY,
		);
	}

	// ── Separator line ──
	const sepY = 440;
	ctx.fillStyle = "#252222";
	ctx.fillRect(50, sepY, width - 100, 2);

	// ── Active deck section ──
	if (data.activeDeck) {
		const deckY = sepY + 25;
		ctx.font = _FONT("bold", 15);
		ctx.fillStyle = "#a89999";
		ctx.fillText(
			`DECK ACTIF — ${data.activeDeck.name.toUpperCase()}`,
			50,
			deckY,
		);

		const bladeSize = 110;
		const totalBlades = data.activeDeck.blades.length;
		const deckSpacing = Math.min(300, (width - 100) / Math.max(totalBlades, 1));

		for (let i = 0; i < totalBlades; i++) {
			const blade = data.activeDeck.blades[i];
			const bladeImg = bladeImages[i];
			const cx = 110 + i * deckSpacing;
			const cy = deckY + 85;

			// Dark circle bg
			ctx.fillStyle = "#252222";
			ctx.beginPath();
			ctx.arc(cx, cy, bladeSize / 2 + 6, 0, Math.PI * 2);
			ctx.fill();

			// Blade image
			ctx.save();
			ctx.beginPath();
			ctx.arc(cx, cy, bladeSize / 2, 0, Math.PI * 2);
			ctx.clip();
			if (bladeImg)
				ctx.drawImage(
					bladeImg,
					cx - bladeSize / 2,
					cy - bladeSize / 2,
					bladeSize,
					bladeSize,
				);
			else {
				ctx.fillStyle = "#1d1b1b";
				ctx.fill();
			}
			ctx.restore();

			// Subtle ring
			ctx.strokeStyle = `${badgeColor}60`;
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.arc(cx, cy, bladeSize / 2, 0, Math.PI * 2);
			ctx.stroke();

			// Blade name
			ctx.font = _FONT("bold", 14);
			ctx.fillStyle = "#f5f0f0";
			ctx.textAlign = "center";
			const bladeName =
				blade.name.length > 14
					? `${blade.name.substring(0, 14).toUpperCase()}…`
					: blade.name.toUpperCase();
			ctx.fillText(bladeName, cx, cy + bladeSize / 2 + 25);
			ctx.textAlign = "start";
		}
	}

	// ── Footer: join date + logo ──
	ctx.font = _FONT("", 14);
	ctx.fillStyle = "#a8999960";
	ctx.textAlign = "left";
	ctx.fillText(`Membre depuis le ${data.joinedAt}`, 50, height - 42);

	ctx.font = _FONT("bold", 12);
	ctx.fillStyle = "#a8999940";
	ctx.fillText("RÉPUBLIQUE POPULAIRE DU BEYBLADE", 50, height - 22);

	if (logo) {
		ctx.globalAlpha = 0.6;
		ctx.drawImage(logo, width - 120, height - 110, 80, 80);
		ctx.globalAlpha = 1;
	}

	return canvas.toBuffer("image/png");
}

export interface ComboCardData {
	color: number;
	name: string;
	type: string;
	blade: string;
	ratchet: string;
	bit: string;
	bladeImageUrl: string | null;
	attack: number;
	defense: number;
	stamina: number;
	dash: number;
	weight: number;
}

export async function generateComboCard(data: ComboCardData) {
	const width = 900;
	const height = 520;
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	const hexColor = `#${data.color.toString(16).padStart(6, "0")}`;

	// ── Type color mapping ──
	const typeColors: Record<string, string> = {
		ATTACK: "#ef4444",
		ATTAQUE: "#ef4444",
		DEFENSE: "#3b82f6",
		DÉFENSE: "#3b82f6",
		STAMINA: "#22c55e",
		ENDURANCE: "#22c55e",
		BALANCE: "#a855f7",
		ÉQUILIBRE: "#a855f7",
	};
	const typeColor = typeColors[data.type.toUpperCase()] ?? hexColor;

	// Normalize type name to English for asset path
	const typeNameMap: Record<string, string> = {
		ATTACK: "attack",
		ATTAQUE: "attack",
		DEFENSE: "defense",
		DÉFENSE: "defense",
		STAMINA: "stamina",
		ENDURANCE: "stamina",
		BALANCE: "balance",
		ÉQUILIBRE: "balance",
	};
	const typeAssetName =
		typeNameMap[data.type.toUpperCase()] ?? data.type.toLowerCase();

	const [arenaOverlay, bladeImg, typeIcon, ringGlow] = await Promise.all([
		safeLoadImage(getAssetPath("bot/assets/backgrounds/arena.png")),
		safeLoadImage(data.bladeImageUrl),
		safeLoadImage(getAssetPath(`bot/assets/types/${typeAssetName}.png`)),
		safeLoadImage(getAssetPath("bot/assets/vfx/ring-glow.png")),
	]);

	// ── Background: warm dark + arena overlay ──
	ctx.fillStyle = "#141111";
	ctx.fillRect(0, 0, width, height);

	if (arenaOverlay) {
		ctx.globalAlpha = 0.1;
		ctx.drawImage(arenaOverlay, 0, 0, width, height);
		ctx.globalAlpha = 1;
	}

	// ── Speed lines ──
	ctx.save();
	ctx.globalAlpha = 0.025;
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 1;
	for (let i = -height; i < width + height; i += 16) {
		ctx.beginPath();
		ctx.moveTo(i, 0);
		ctx.lineTo(i + height * 0.5, height);
		ctx.stroke();
	}
	ctx.restore();

	// ── Main card surface (rounded) ──
	ctx.fillStyle = "#1d1b1b";
	ctx.beginPath();
	ctx.roundRect(20, 20, width - 40, height - 40, 16);
	ctx.fill();

	// ── Top gradient accent ──
	const topGrad = ctx.createLinearGradient(20, 20, width - 20, 20);
	topGrad.addColorStop(0, typeColor);
	topGrad.addColorStop(1, `${typeColor}40`);
	ctx.fillStyle = topGrad;
	ctx.beginPath();
	ctx.roundRect(20, 20, width - 40, 4, [16, 16, 0, 0]);
	ctx.fill();

	// ── Radial glow behind blade (type-colored) ──
	const glowX = 180;
	const glowY = 250;
	const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, 160);
	glow.addColorStop(0, `${typeColor}20`);
	glow.addColorStop(0.6, `${typeColor}08`);
	glow.addColorStop(1, "transparent");
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, width, height);

	// ── Blade image (left, circular with glow ring) ──
	const bladeX = 180;
	const bladeY = 240;
	const bladeR = 95;

	// Ring glow VFX
	if (ringGlow) {
		ctx.globalAlpha = 0.3;
		ctx.drawImage(
			ringGlow,
			bladeX - bladeR - 30,
			bladeY - bladeR - 30,
			(bladeR + 30) * 2,
			(bladeR + 30) * 2,
		);
		ctx.globalAlpha = 1;
	}

	// Dark circle bg
	ctx.fillStyle = "#252222";
	ctx.beginPath();
	ctx.arc(bladeX, bladeY, bladeR + 5, 0, Math.PI * 2);
	ctx.fill();

	// Blade clip
	ctx.save();
	ctx.beginPath();
	ctx.arc(bladeX, bladeY, bladeR, 0, Math.PI * 2, true);
	ctx.clip();
	if (bladeImg)
		ctx.drawImage(
			bladeImg,
			bladeX - bladeR,
			bladeY - bladeR,
			bladeR * 2,
			bladeR * 2,
		);
	else {
		ctx.fillStyle = "#1d1b1b";
		ctx.fill();
	}
	ctx.restore();

	// Type-colored ring
	ctx.save();
	ctx.shadowColor = typeColor;
	ctx.shadowBlur = 15;
	ctx.strokeStyle = typeColor;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.arc(bladeX, bladeY, bladeR, 0, Math.PI * 2);
	ctx.stroke();
	ctx.restore();

	// ── Combo name (top center) ──
	ctx.textAlign = "left";
	const nameX = 310;
	ctx.font = _FONT("bold", 38);
	ctx.fillStyle = "#f5f0f0";
	const nameText =
		data.name.length > 20
			? `${data.name.substring(0, 20).toUpperCase()}…`
			: data.name.toUpperCase();
	ctx.fillText(nameText, nameX, 75);

	// ── Type badge pill ──
	ctx.font = _FONT("bold", 14);
	const typeLabel = data.type.toUpperCase();
	const typeBadgeW = ctx.measureText(typeLabel).width + 40;
	ctx.fillStyle = typeColor;
	ctx.beginPath();
	ctx.roundRect(nameX, 88, typeBadgeW, 28, 14);
	ctx.fill();

	// Type icon in pill
	if (typeIcon) {
		ctx.drawImage(typeIcon, nameX + 6, 90, 24, 24);
	}
	ctx.fillStyle = "#ffffff";
	ctx.font = _FONT("bold", 13);
	ctx.fillText(typeLabel, nameX + (typeIcon ? 34 : 12), 107);

	// Weight badge
	ctx.font = _FONT("bold", 13);
	const weightText = `${data.weight}g`;
	const weightW = ctx.measureText(weightText).width + 20;
	ctx.fillStyle = "#2d2929";
	ctx.beginPath();
	ctx.roundRect(nameX + typeBadgeW + 12, 88, weightW, 28, 14);
	ctx.fill();
	ctx.strokeStyle = "#433d3d";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.roundRect(nameX + typeBadgeW + 12, 88, weightW, 28, 14);
	ctx.stroke();
	ctx.fillStyle = "#a89999";
	ctx.fillText(weightText, nameX + typeBadgeW + 22, 107);

	// ── Parts list (right side, aligned) ──
	const partsStartY = 148;
	const partGap = 52;

	const drawPartRow = (
		label: string,
		value: string,
		y: number,
		partColor: string,
	) => {
		// Label
		ctx.font = _FONT("bold", 12);
		ctx.fillStyle = "#64748b";
		ctx.textAlign = "left";
		ctx.fillText(label, nameX, y);
		// Value
		ctx.font = _FONT("bold", 24);
		ctx.fillStyle = "#f5f0f0";
		ctx.fillText(value, nameX, y + 28);
		// Subtle dot
		ctx.fillStyle = partColor;
		ctx.beginPath();
		ctx.arc(nameX - 12, y + 16, 4, 0, Math.PI * 2);
		ctx.fill();
	};

	drawPartRow("BLADE", data.blade, partsStartY, "#ce0c07");
	drawPartRow("RATCHET", data.ratchet, partsStartY + partGap, "#e68002");
	drawPartRow("BIT", data.bit, partsStartY + partGap * 2, "#f7d301");

	// ── Stat bars (bottom section, full width) ──
	const barStartY = 380;
	const barX = 50;
	const barTotalW = width - 100;
	const barH = 10;
	const barGap = 32;

	const drawStatBar = (
		label: string,
		value: number,
		y: number,
		color: string,
	) => {
		const maxVal = 100;
		const ratio = Math.min(value / maxVal, 1);

		// Label
		ctx.font = _FONT("bold", 12);
		ctx.fillStyle = "#a89999";
		ctx.textAlign = "left";
		ctx.fillText(label, barX, y - 2);

		// Value
		ctx.textAlign = "right";
		ctx.fillStyle = color;
		ctx.fillText(value.toString(), barX + barTotalW, y - 2);

		// Track
		ctx.fillStyle = "#252222";
		ctx.beginPath();
		ctx.roundRect(barX, y + 4, barTotalW, barH, barH / 2);
		ctx.fill();

		// Fill with glow
		ctx.save();
		ctx.shadowColor = color;
		ctx.shadowBlur = 8;
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.roundRect(barX, y + 4, barTotalW * ratio, barH, barH / 2);
		ctx.fill();
		ctx.restore();

		// Bright tip
		if (ratio > 0.05) {
			const tipX = barX + barTotalW * ratio;
			ctx.fillStyle = "#ffffff";
			ctx.globalAlpha = 0.6;
			ctx.beginPath();
			ctx.arc(tipX - 2, y + 4 + barH / 2, barH / 2 - 1, 0, Math.PI * 2);
			ctx.fill();
			ctx.globalAlpha = 1;
		}
	};

	drawStatBar("ATK", data.attack, barStartY, "#ef4444");
	drawStatBar("DEF", data.defense, barStartY + barGap, "#3b82f6");
	drawStatBar("STA", data.stamina, barStartY + barGap * 2, "#22c55e");
	drawStatBar("DSH", data.dash, barStartY + barGap * 3, "#eab308");

	// ── Bottom branding ──
	ctx.font = _FONT("bold", 11);
	ctx.fillStyle = "#a8999940";
	ctx.textAlign = "left";
	ctx.fillText("RPB • BEYBLADE X COMBO", 50, height - 28);

	// ── Bottom border accent ──
	const btmGrad = ctx.createLinearGradient(
		20,
		height - 20,
		width - 20,
		height - 20,
	);
	btmGrad.addColorStop(0, "#ce0c07");
	btmGrad.addColorStop(0.5, "#e68002");
	btmGrad.addColorStop(1, "#f7d301");
	ctx.fillStyle = btmGrad;
	ctx.beginPath();
	ctx.roundRect(20, height - 24, width - 40, 4, [0, 0, 16, 16]);
	ctx.fill();

	return canvas.toBuffer("image/png");
}

export interface BattleCardData {
	winnerName: string;
	winnerAvatarUrl: string;
	loserName: string;
	loserAvatarUrl: string;
	finishType: string;
	finishMessage: string;
	finishEmoji: string;
	// New fields (optional for backward compat)
	winnerType?: string;
	loserType?: string;
	winnerStats?: {
		attack: number;
		defense: number;
		stamina: number;
		dash: number;
		power: number;
	};
	loserStats?: {
		attack: number;
		defense: number;
		stamina: number;
		dash: number;
		power: number;
	};
	narrative?: string[];
	finishColor?: string;
}

export async function generateBattleCard(data: BattleCardData) {
	const width = 1100;
	const height = 500;
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	const finishColor = data.finishColor ?? "#ce0c07";

	// ── Type color mapping ──
	const typeColors: Record<string, string> = {
		ATTACK: "#ef4444",
		DEFENSE: "#3b82f6",
		STAMINA: "#22c55e",
		BALANCE: "#a855f7",
	};
	const winnerColor = typeColors[data.winnerType ?? ""] ?? "#f7d301";
	const loserColor = typeColors[data.loserType ?? ""] ?? "#64748b";

	// ── Load assets ──
	const [background, arenaOverlay, sparks, flare, winnerAvatar, loserAvatar] =
		await Promise.all([
			safeLoadImage("/banner.webp"),
			safeLoadImage(getAssetPath("bot/assets/backgrounds/arena.png")),
			safeLoadImage(getAssetPath("bot/assets/battle/sparks-0.webp")),
			safeLoadImage(getAssetPath("bot/assets/battle/flare.webp")),
			safeLoadImage(data.winnerAvatarUrl),
			safeLoadImage(data.loserAvatarUrl),
		]);

	// ── Background: dark warm gray + arena overlay ──
	ctx.fillStyle = "#1d1b1b";
	ctx.fillRect(0, 0, width, height);

	if (arenaOverlay) {
		ctx.globalAlpha = 0.15;
		ctx.drawImage(arenaOverlay, 0, 0, width, height);
		ctx.globalAlpha = 1;
	} else if (background) {
		ctx.globalAlpha = 0.3;
		ctx.drawImage(background, 0, 0, width, height);
		ctx.globalAlpha = 1;
	}

	// ── Radial glow behind center (arena energy) ──
	const glow = ctx.createRadialGradient(
		width / 2,
		height / 2,
		0,
		width / 2,
		height / 2,
		300,
	);
	glow.addColorStop(0, `${finishColor}25`);
	glow.addColorStop(0.5, `${finishColor}08`);
	glow.addColorStop(1, "transparent");
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, width, height);

	// ── Diagonal speed lines (halftone-style, subtle) ──
	ctx.save();
	ctx.globalAlpha = 0.04;
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 1;
	for (let i = -height; i < width + height; i += 12) {
		ctx.beginPath();
		ctx.moveTo(i, 0);
		ctx.lineTo(i + height * 0.6, height);
		ctx.stroke();
	}
	ctx.restore();

	// ── Spark VFX overlay at center ──
	if (sparks) {
		ctx.globalAlpha = 0.6;
		ctx.drawImage(sparks, width / 2 - 100, height / 2 - 80, 200, 160);
		ctx.globalAlpha = 1;
	}

	// ── Flare behind winner ──
	if (flare) {
		ctx.globalAlpha = 0.3;
		ctx.drawImage(flare, 50, 40, 400, 350);
		ctx.globalAlpha = 1;
	}

	// ── Helper: draw circular avatar with glow ──
	const drawAvatar = (
		avatar: CanvasImage | null,
		x: number,
		y: number,
		r: number,
		borderColor: string,
		lw: number,
		glowColor: string,
	) => {
		// Outer glow
		ctx.save();
		ctx.shadowColor = glowColor;
		ctx.shadowBlur = 30;
		ctx.beginPath();
		ctx.arc(x, y, r + 2, 0, Math.PI * 2);
		ctx.strokeStyle = borderColor;
		ctx.lineWidth = lw;
		ctx.stroke();
		ctx.restore();

		// Clip and draw avatar
		ctx.save();
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2, true);
		ctx.closePath();
		ctx.clip();
		if (avatar) ctx.drawImage(avatar, x - r, y - r, r * 2, r * 2);
		else {
			ctx.fillStyle = "#2d2929";
			ctx.fill();
		}
		ctx.restore();

		// Border
		ctx.strokeStyle = borderColor;
		ctx.lineWidth = lw;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2, true);
		ctx.stroke();
	};

	// ── Winner avatar (left, larger, golden glow) ──
	drawAvatar(winnerAvatar, 220, 210, 110, winnerColor, 6, winnerColor);

	// ── Loser avatar (right, smaller, dimmed) ──
	drawAvatar(loserAvatar, 880, 210, 90, loserColor, 4, `${loserColor}40`);

	// ── VS text at center ──
	ctx.textAlign = "center";
	ctx.font = _FONT("italic bold", 72);
	ctx.fillStyle = `${finishColor}30`;
	ctx.fillText("VS", width / 2, height / 2 + 20);

	// ── Winner crown + name ──
	ctx.font = _FONT("bold", 28);
	ctx.fillStyle = winnerColor;
	ctx.fillText(`🏆 ${data.winnerName.toUpperCase()}`, 220, 355);

	// ── Loser name ──
	ctx.font = _FONT("bold", 22);
	ctx.fillStyle = "#64748b";
	ctx.fillText(data.loserName.toUpperCase(), 880, 335);

	// ── Stat bars (if provided) ──
	if (data.winnerStats && data.loserStats) {
		const statBarY = 400;
		const barW = 160;
		const barH = 8;
		const statNames = ["ATK", "DEF", "STA", "DSH"] as const;
		const statKeys = ["attack", "defense", "stamina", "dash"] as const;
		const statColors = ["#ef4444", "#3b82f6", "#22c55e", "#eab308"];

		// Winner stats
		for (let i = 0; i < 4; i++) {
			const sx = 70 + i * 80;
			const val = data.winnerStats[statKeys[i]];
			const maxVal = Math.max(val, data.loserStats[statKeys[i]], 200);
			const ratio = val / maxVal;

			ctx.font = _FONT("bold", 11);
			ctx.fillStyle = "#a89999";
			ctx.textAlign = "center";
			ctx.fillText(statNames[i], sx + barW / 8, statBarY);
			ctx.fillStyle = "#2d2929";
			ctx.beginPath();
			ctx.roundRect(sx - barW / 8, statBarY + 4, barW / 4, barH, 4);
			ctx.fill();
			ctx.fillStyle = statColors[i]!;
			ctx.beginPath();
			ctx.roundRect(sx - barW / 8, statBarY + 4, (barW / 4) * ratio, barH, 4);
			ctx.fill();
		}

		// Loser stats
		for (let i = 0; i < 4; i++) {
			const sx = 730 + i * 80;
			const val = data.loserStats[statKeys[i]];
			const maxVal = Math.max(val, data.winnerStats[statKeys[i]], 200);
			const ratio = val / maxVal;

			ctx.font = _FONT("bold", 11);
			ctx.fillStyle = "#64748b";
			ctx.textAlign = "center";
			ctx.fillText(statNames[i], sx + barW / 8, statBarY);
			ctx.fillStyle = "#2d2929";
			ctx.beginPath();
			ctx.roundRect(sx - barW / 8, statBarY + 4, barW / 4, barH, 4);
			ctx.fill();
			ctx.fillStyle = `${statColors[i]!}80`;
			ctx.beginPath();
			ctx.roundRect(sx - barW / 8, statBarY + 4, (barW / 4) * ratio, barH, 4);
			ctx.fill();
		}
	}

	// ── Finish banner (bottom center, pill shape with glow) ──
	const finishText = data.finishMessage.replace(/\*\*/g, "").toUpperCase();
	ctx.font = _FONT("bold", 32);
	const textMetrics = ctx.measureText(finishText);
	const bannerW = textMetrics.width + 60;
	const bannerH = 52;
	const bannerX = (width - bannerW) / 2;
	const bannerY = height - bannerH - 25;

	// Pill background with glow
	ctx.save();
	ctx.shadowColor = finishColor;
	ctx.shadowBlur = 20;
	ctx.fillStyle = finishColor;
	ctx.beginPath();
	ctx.roundRect(bannerX, bannerY, bannerW, bannerH, bannerH / 2);
	ctx.fill();
	ctx.restore();

	// Finish text
	ctx.textAlign = "center";
	ctx.font = _FONT("bold", 28);
	ctx.fillStyle = "#ffffff";
	ctx.fillText(finishText, width / 2, bannerY + 34);

	// ── Top-left: RPB branding ──
	ctx.textAlign = "left";
	ctx.font = _FONT("bold", 14);
	ctx.fillStyle = "#a8999980";
	ctx.fillText("RPB • BEYBLADE X BATTLE", 20, 25);

	return canvas.toBuffer("image/png");
}

export interface DeckBeyData {
	bladeName: string;
	ratchetName: string;
	bitName: string;
	bladeImageUrl: string | null;
	beyType?: string | null;
	atk: number;
	def: number;
	sta: number;
}

export interface DeckCardData {
	name: string;
	ownerName: string;
	isActive: boolean;
	beys: DeckBeyData[];
}

// Keep backward compat for old callers
export interface DeckCardDataLegacy {
	name: string;
	beys: { name: string; imageUrl: string | null; type?: string }[];
}

function isDeckLegacy(
	data: DeckCardData | DeckCardDataLegacy,
): data is DeckCardDataLegacy {
	return (
		"beys" in data &&
		data.beys.length > 0 &&
		"name" in data.beys[0] &&
		!("bladeName" in data.beys[0])
	);
}

const TYPE_COLORS: Record<string, string> = {
	ATTACK: "#ef4444",
	DEFENSE: "#3b82f6",
	STAMINA: "#22c55e",
	BALANCE: "#a855f7",
};

export async function generateDeckCard(
	data: DeckCardData | DeckCardDataLegacy,
) {
	// Handle legacy format
	if (isDeckLegacy(data)) {
		return generateDeckCardLegacy(data);
	}

	const width = 900;
	const boxH = 500;
	const infoH = 180;
	const height = boxH + infoH;
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	// Load images
	const [background, logo, ...beyImages] = await Promise.all([
		safeLoadImage("/deckbox.webp"),
		safeLoadImage("/logo.webp"),
		...data.beys.map((b) => safeLoadImage(b.bladeImageUrl)),
	]);

	// === Deckbox section ===
	if (background) {
		ctx.drawImage(background, 0, 0, width, boxH);
	} else {
		ctx.fillStyle = "#141111";
		ctx.fillRect(0, 0, width, boxH);
	}

	// RPB radial glow (red→orange from center)
	const glowGrad = ctx.createRadialGradient(
		width / 2,
		boxH / 2,
		0,
		width / 2,
		boxH / 2,
		width * 0.6,
	);
	glowGrad.addColorStop(0, "rgba(206, 12, 7, 0.1)");
	glowGrad.addColorStop(0.4, "rgba(230, 128, 2, 0.04)");
	glowGrad.addColorStop(1, "transparent");
	ctx.fillStyle = glowGrad;
	ctx.fillRect(0, 0, width, boxH);

	// Subtle speed lines
	ctx.save();
	ctx.globalAlpha = 0.02;
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 1;
	for (let i = -boxH; i < width + boxH; i += 20) {
		ctx.beginPath();
		ctx.moveTo(i, 0);
		ctx.lineTo(i + boxH * 0.4, boxH);
		ctx.stroke();
	}
	ctx.restore();

	// Draw Beys in slots (3D perspective)
	const positions = [
		{ x: width * 0.21, y: boxH * 0.65 },
		{ x: width * 0.5, y: boxH * 0.65 },
		{ x: width * 0.79, y: boxH * 0.65 },
	];
	const beySize = width * 0.2;

	for (let i = 0; i < 3; i++) {
		const bey = data.beys[i];
		const img = beyImages[i];
		const pos = positions[i];
		if (!pos) continue;

		// Slot shadow (ellipse at bottom)
		ctx.save();
		ctx.beginPath();
		ctx.ellipse(
			pos.x,
			pos.y + beySize * 0.35,
			beySize * 0.4,
			beySize * 0.12,
			0,
			0,
			Math.PI * 2,
		);
		ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
		ctx.filter = "blur(8px)";
		ctx.fill();
		ctx.filter = "none";
		ctx.restore();

		if (img) {
			ctx.save();
			ctx.translate(pos.x, pos.y);
			// 3D tilt perspective (like the website's rotateX(45deg) scaleY(0.85))
			ctx.transform(1, 0, 0, 0.82, 0, 0);

			ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
			ctx.shadowBlur = 18;
			ctx.shadowOffsetY = 12;

			ctx.drawImage(img, -beySize / 2, -beySize / 2, beySize, beySize);
			ctx.restore();
		} else if (bey) {
			// Empty slot indicator
			ctx.save();
			ctx.translate(pos.x, pos.y);
			ctx.transform(1, 0, 0, 0.82, 0, 0);
			ctx.beginPath();
			ctx.arc(0, 0, beySize * 0.35, 0, Math.PI * 2);
			ctx.strokeStyle = "rgba(255,255,255,0.08)";
			ctx.lineWidth = 2;
			ctx.setLineDash([8, 6]);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.restore();
		}
	}

	// === Info section (below deckbox) ===
	ctx.fillStyle = "#1d1b1b";
	ctx.fillRect(0, boxH, width, infoH);

	// RPB gradient separator
	const sepGrad = ctx.createLinearGradient(0, boxH, width, boxH);
	sepGrad.addColorStop(0, "#ce0c07");
	sepGrad.addColorStop(0.5, "#e68002");
	sepGrad.addColorStop(1, "#f7d301");
	ctx.fillStyle = sepGrad;
	ctx.fillRect(0, boxH, width, 3);

	// Deck name + owner
	if (logo) {
		ctx.globalAlpha = 0.7;
		ctx.drawImage(logo, 20, boxH + 15, 40, 40);
		ctx.globalAlpha = 1;
	}
	ctx.font = _FONT("bold", 26);
	ctx.fillStyle = "#f7d301";
	ctx.textAlign = "left";
	ctx.fillText(data.name.toUpperCase(), 70, boxH + 40);

	// Active deck pill
	const ownerText = data.ownerName;
	ctx.font = _FONT("", 14);
	ctx.fillStyle = "#a89999";
	ctx.fillText(ownerText, 70, boxH + 58);

	if (data.isActive) {
		const ownerW = ctx.measureText(ownerText).width;
		ctx.font = _FONT("bold", 10);
		ctx.fillStyle = "#22c55e20";
		ctx.beginPath();
		ctx.roundRect(70 + ownerW + 8, boxH + 47, 70, 18, 9);
		ctx.fill();
		ctx.fillStyle = "#22c55e";
		ctx.fillText("ACTIF", 70 + ownerW + 18, boxH + 59);
	}

	// Bey info columns
	const colW = (width - 40) / 3;

	for (let i = 0; i < Math.min(data.beys.length, 3); i++) {
		const bey = data.beys[i];
		const cx = 20 + i * colW + colW / 2;
		const baseY = boxH + 80;
		const typeColor = TYPE_COLORS[bey.beyType || ""] || "#888";

		// Type indicator dot
		ctx.beginPath();
		ctx.arc(cx - colW / 2 + 10, baseY + 8, 4, 0, Math.PI * 2);
		ctx.fillStyle = typeColor;
		ctx.fill();

		// Combo name
		ctx.font = "bold 15px GoogleSans";
		ctx.fillStyle = "#ffffff";
		ctx.textAlign = "left";
		const combo = `${bey.bladeName} ${bey.ratchetName} ${bey.bitName}`;
		// Truncate if needed
		let displayCombo = combo;
		while (
			ctx.measureText(displayCombo).width > colW - 30 &&
			displayCombo.length > 10
		) {
			displayCombo = `${displayCombo.slice(0, -2)}…`;
		}
		ctx.fillText(displayCombo, cx - colW / 2 + 22, baseY + 13);

		// Stats mini bars
		const stats = [
			{ label: "ATK", value: bey.atk, color: "#ef4444" },
			{ label: "DEF", value: bey.def, color: "#3b82f6" },
			{ label: "STA", value: bey.sta, color: "#22c55e" },
		];
		const barW = colW - 80;

		for (let si = 0; si < stats.length; si++) {
			const stat = stats[si];
			const sy = baseY + 28 + si * 20;

			ctx.font = "11px GoogleSans";
			ctx.fillStyle = "rgba(255,255,255,0.4)";
			ctx.textAlign = "left";
			ctx.fillText(stat.label, cx - colW / 2 + 22, sy + 4);

			// Bar background
			const barX = cx - colW / 2 + 55;
			ctx.beginPath();
			ctx.roundRect(barX, sy - 3, barW, 8, 4);
			ctx.fillStyle = "rgba(255,255,255,0.06)";
			ctx.fill();

			// Bar fill
			const fillW = Math.max(4, (stat.value / 100) * barW);
			ctx.beginPath();
			ctx.roundRect(barX, sy - 3, fillW, 8, 4);
			ctx.fillStyle = stat.color;
			ctx.fill();

			// Value
			ctx.font = "bold 11px GoogleSans";
			ctx.fillStyle = "rgba(255,255,255,0.6)";
			ctx.textAlign = "right";
			ctx.fillText(`${stat.value}`, cx + colW / 2 - 10, sy + 4);
		}
	}

	ctx.textAlign = "left";
	return canvas.toBuffer("image/png");
}

// Legacy version for backward compat (old callers)
async function generateDeckCardLegacy(data: DeckCardDataLegacy) {
	const width = 800;
	const height = 550;
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	const [background, ...beyImages] = await Promise.all([
		safeLoadImage("/deckbox.webp"),
		...data.beys.map((b) => safeLoadImage(b.imageUrl)),
	]);

	if (background) {
		ctx.drawImage(background, 0, 0, width, 500);
	} else {
		ctx.fillStyle = "#dc2626";
		ctx.fillRect(0, 0, width, 500);
	}

	const positions = [
		{ x: width * 0.21, y: 500 * 0.65 },
		{ x: width * 0.5, y: 500 * 0.65 },
		{ x: width * 0.79, y: 500 * 0.65 },
	];
	const beySize = width * 0.22;

	for (let i = 0; i < 3; i++) {
		const img = beyImages[i];
		const pos = positions[i];
		if (img) {
			ctx.save();
			ctx.translate(pos.x, pos.y);
			ctx.transform(1, 0, 0, 0.85, 0, 0);
			ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
			ctx.shadowBlur = 15;
			ctx.shadowOffsetY = 10;
			ctx.drawImage(img, -beySize / 2, -beySize / 2, beySize, beySize);
			ctx.restore();
		}
	}

	ctx.fillStyle = "#0a0a0a";
	ctx.fillRect(0, 500, width, 50);
	ctx.font = "bold 28px GoogleSans";
	ctx.fillStyle = "#fbbf24";
	ctx.textAlign = "left";
	ctx.fillText(data.name.toUpperCase(), 30, 535);
	ctx.textAlign = "right";
	ctx.font = "italic 18px GoogleSans";
	ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
	ctx.fillText(data.beys.map((b) => b.name).join("  |  "), width - 30, 535);

	return canvas.toBuffer("image/png");
}

export interface LeaderboardEntry {
	rank: number;
	name: string;
	points: number;
	winRate: string | number;
	avatarUrl: string | null;
	/** Optional: wins (shown as W-L on WB/SATR variants). */
	wins?: number;
	/** Optional: losses (paired with wins). */
	losses?: number;
	/** Optional: number of tournaments participated (WB/SATR). */
	participations?: number;
}

export interface LeaderboardCardOptions {
	/** Theme + column layout: 'rpb' (red/yellow), 'wb' (purple), 'satr' (rose). */
	variant?: LbVariant;
	/** Override card title shown at the top (defaults to the variant badge). */
	title?: string;
	/** Stats shown next to the title (e.g. "Saison 2 · 401 bladers"). */
	subtitle?: string;
}

export async function generateLeaderboardCard(
	entries: LeaderboardEntry[],
	options: LeaderboardCardOptions = {},
): Promise<Buffer> {
	const variant: LbVariant = options.variant ?? "rpb";
	const theme = LB_VARIANT_THEMES[variant];
	const showWL = variant !== "rpb";
	const showParticipations = variant !== "rpb";

	const podiumEntries = entries.filter((e) => e.rank <= 3);
	const tableEntries = entries.filter((e) => e.rank > 3);

	const width = 1100;
	const headerH = 150;
	const podiumH = podiumEntries.length > 0 ? 240 : 0;
	const colHeaderH = 32;
	const rowH = 64;
	const footerH = 48;
	const height =
		headerH + podiumH + colHeaderH + tableEntries.length * rowH + footerH;

	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	// Parallel avatar load (podium + table) — single pass for cache locality.
	const avatars = await Promise.all(
		entries.map((e) => safeLoadImage(e.avatarUrl)),
	);
	const avatarByRank = new Map<number, CanvasImage | null>();
	entries.forEach((e, i) => avatarByRank.set(e.rank, avatars[i] ?? null));

	// ── Chrome (background + surface + accent stripes) ──
	drawLbChrome(ctx, theme, width, height);
	drawLbSpeedLines(ctx, width, height);

	// ── Header: title + subtitle ──
	const titleY = 76;
	ctx.font = _FONT("bold", 44);
	fillLbGradientText(
		ctx,
		options.title ?? theme.title,
		width / 2,
		titleY,
		theme.primary,
		theme.secondary,
	);

	ctx.font = _FONT("bold", 15);
	ctx.fillStyle = "#a89999";
	ctx.textAlign = "center";
	ctx.fillText(options.subtitle ?? theme.badge, width / 2, titleY + 30);

	// Header separator
	ctx.fillStyle = "#252222";
	ctx.fillRect(40, headerH - 2, width - 80, 1);

	// ── Podium (top 3) ──
	if (podiumH > 0) {
		drawLbPodium(
			ctx,
			theme,
			podiumEntries.map((e) => ({
				rank: e.rank as 1 | 2 | 3,
				name: e.name,
				points: e.points,
				avatar: avatarByRank.get(e.rank) ?? null,
			})),
			{
				x: 60,
				y: headerH + 10,
				width: width - 120,
				height: podiumH - 20,
			},
		);
	}

	// ── Column headers ──
	const tableY = headerH + podiumH;
	const cols = getColumnLayout(variant, width);
	ctx.font = _FONT("bold", 11);
	ctx.fillStyle = "#64748b";
	ctx.textAlign = "left";
	ctx.fillText("RANG", cols.rank - 10, tableY + 20);
	ctx.fillText("BLADER", cols.name, tableY + 20);
	ctx.textAlign = "right";
	ctx.fillText("POINTS", cols.points, tableY + 20);
	if (showWL) {
		ctx.fillText("V-D", cols.wl, tableY + 20);
	}
	if (showParticipations) {
		ctx.fillText("PART", cols.part, tableY + 20);
	}
	ctx.fillText("WR", cols.wr + 24, tableY + 20);

	ctx.fillStyle = "#252222";
	ctx.fillRect(40, tableY + colHeaderH - 2, width - 80, 1);

	// ── Table rows (rank 4+) ──
	for (let i = 0; i < tableEntries.length; i++) {
		const entry = tableEntries[i]!;
		const avatar = avatarByRank.get(entry.rank) ?? null;
		const y = tableY + colHeaderH + i * rowH;
		const cy = y + rowH / 2;

		if (i % 2 === 0) {
			ctx.fillStyle = "#252222";
			ctx.beginPath();
			ctx.roundRect(30, y + 4, width - 60, rowH - 8, 8);
			ctx.fill();
		}

		// Rank pill
		ctx.fillStyle = "#2d2929";
		ctx.beginPath();
		ctx.roundRect(cols.rank - 22, cy - 14, 44, 28, 14);
		ctx.fill();
		ctx.font = _FONT("bold", 14);
		ctx.fillStyle = theme.primary;
		ctx.textAlign = "center";
		ctx.fillText(`#${entry.rank}`, cols.rank, cy + 5);

		// Avatar
		ctx.save();
		ctx.beginPath();
		ctx.arc(cols.avatar, cy, 22, 0, Math.PI * 2, true);
		ctx.clip();
		if (avatar) {
			ctx.drawImage(avatar, cols.avatar - 22, cy - 22, 44, 44);
		} else {
			ctx.fillStyle = "#2d2929";
			ctx.fillRect(cols.avatar - 22, cy - 22, 44, 44);
		}
		ctx.restore();

		// Name
		ctx.textAlign = "left";
		ctx.font = _FONT("bold", 18);
		ctx.fillStyle = "#f5f0f0";
		const displayName =
			entry.name.length > 20 ? `${entry.name.substring(0, 20)}…` : entry.name;
		ctx.fillText(displayName, cols.name, cy + 6);

		// Points
		ctx.textAlign = "right";
		ctx.font = _FONT("bold", 20);
		ctx.fillStyle = theme.primary;
		ctx.fillText(entry.points.toLocaleString(), cols.points, cy + 6);

		// W-L
		if (showWL && typeof entry.wins === "number") {
			ctx.font = _FONT("bold", 14);
			ctx.fillStyle = "#f5f0f0";
			ctx.fillText(`${entry.wins}-${entry.losses ?? 0}`, cols.wl, cy + 6);
		}

		// Participations
		if (showParticipations && typeof entry.participations === "number") {
			ctx.font = _FONT("bold", 14);
			ctx.fillStyle = "#a89999";
			ctx.fillText(`${entry.participations}`, cols.part, cy + 6);
		}

		// Win rate arc + %
		const wrVal = parseFloat(`${entry.winRate}`) || 0;
		const arcCx = cols.wr;
		ctx.strokeStyle = "#252222";
		ctx.lineWidth = 3.5;
		ctx.beginPath();
		ctx.arc(arcCx, cy, 15, -Math.PI / 2, Math.PI * 1.5);
		ctx.stroke();

		const wrColor =
			wrVal >= 70 ? "#22c55e" : wrVal >= 50 ? "#e68002" : "#ef4444";
		const wrAngle = -Math.PI / 2 + (Math.PI * 2 * wrVal) / 100;
		ctx.strokeStyle = wrColor;
		ctx.lineWidth = 3.5;
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.arc(arcCx, cy, 15, -Math.PI / 2, wrAngle);
		ctx.stroke();
		ctx.lineCap = "butt";

		ctx.font = _FONT("bold", 11);
		ctx.fillStyle = "#f5f0f0";
		ctx.textAlign = "center";
		ctx.fillText(`${wrVal}%`, arcCx, cy + 4);
	}

	// ── Footer ──
	const footerY = height - footerH;
	ctx.fillStyle = "#252222";
	ctx.fillRect(40, footerY, width - 80, 1);
	ctx.font = _FONT("", 12);
	ctx.fillStyle = "#a8999999";
	ctx.textAlign = "center";
	ctx.fillText(
		`${theme.footerUrl} • Mis à jour en temps réel`,
		width / 2,
		footerY + 24,
	);

	return canvas.encode("png");
}

// ─── Leaderboard helpers (scoped to this function) ────────────────
// These are duplicated-but-inlined from canvas/primitives.ts to avoid
// touching the rest of this mega-file. They match the primitives
// exactly so we can migrate callers later without visual drift.

type LbVariant = "rpb" | "wb" | "satr";

interface LbVariantTheme {
	primary: string;
	secondary: string;
	barStops: readonly [string, string, string];
	title: string;
	badge: string;
	footerUrl: string;
}

const LB_VARIANT_THEMES: Record<LbVariant, LbVariantTheme> = {
	rpb: {
		primary: "#ce0c07",
		secondary: "#f7d301",
		barStops: ["#ce0c07", "#e68002", "#f7d301"],
		title: "CLASSEMENT OFFICIEL",
		badge: "RÉPUBLIQUE POPULAIRE DU BEYBLADE",
		footerUrl: "rpbey.fr/rankings",
	},
	wb: {
		primary: "#a855f7",
		secondary: "#c084fc",
		barStops: ["#6d28d9", "#8b5cf6", "#c084fc"],
		title: "ULTIME BATAILLE",
		badge: "WILD BREAKERS · CLASSEMENT",
		footerUrl: "rpbey.fr/tournaments/wb",
	},
	satr: {
		primary: "#ef4444",
		secondary: "#f97316",
		barStops: ["#be123c", "#ef4444", "#f97316"],
		title: "BBT · SATR",
		badge: "SUN AFTER THE REIGN",
		footerUrl: "rpbey.fr/tournaments/satr",
	},
};

const MEDAL = ["#f7d301", "#C0C0C0", "#CD7F32"] as const;

function drawLbChrome(
	ctx: CanvasCtx,
	theme: LbVariantTheme,
	w: number,
	h: number,
) {
	ctx.fillStyle = "#141111";
	ctx.fillRect(0, 0, w, h);
	ctx.fillStyle = "#1d1b1b";
	ctx.beginPath();
	ctx.roundRect(16, 16, w - 32, h - 32, 16);
	ctx.fill();

	for (const [corners, y] of [
		[[16, 16, 0, 0] as [number, number, number, number], 16],
		[[0, 0, 16, 16] as [number, number, number, number], h - 20],
	] as const) {
		const g = ctx.createLinearGradient(16, 0, w - 16, 0);
		g.addColorStop(0, theme.barStops[0]);
		g.addColorStop(0.5, theme.barStops[1]);
		g.addColorStop(1, theme.barStops[2]);
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.roundRect(16, y, w - 32, 4, corners);
		ctx.fill();
	}
}

function drawLbSpeedLines(ctx: CanvasCtx, w: number, h: number) {
	ctx.save();
	ctx.globalAlpha = 0.02;
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 1;
	for (let i = -h; i < w + h; i += 18) {
		ctx.beginPath();
		ctx.moveTo(i, 0);
		ctx.lineTo(i + h * 0.4, h);
		ctx.stroke();
	}
	ctx.restore();
}

function fillLbGradientText(
	ctx: CanvasCtx,
	text: string,
	cx: number,
	y: number,
	from: string,
	to: string,
) {
	const w = ctx.measureText(text).width;
	const g = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
	g.addColorStop(0, from);
	g.addColorStop(1, to);
	const prev = ctx.textAlign;
	ctx.textAlign = "center";
	ctx.fillStyle = g;
	ctx.fillText(text, cx, y);
	ctx.textAlign = prev;
}

interface ColumnLayout {
	rank: number;
	avatar: number;
	name: number;
	points: number;
	wl: number;
	part: number;
	wr: number;
}

function getColumnLayout(variant: LbVariant, w: number): ColumnLayout {
	if (variant === "rpb") {
		return {
			rank: 70,
			avatar: 130,
			name: 175,
			points: w - 280,
			wl: -1,
			part: -1,
			wr: w - 110,
		};
	}
	// WB / SATR: denser, with W-L + PART columns
	return {
		rank: 65,
		avatar: 120,
		name: 165,
		points: w - 420,
		wl: w - 290,
		part: w - 195,
		wr: w - 110,
	};
}

function drawLbPodium(
	ctx: CanvasCtx,
	theme: LbVariantTheme,
	entries: Array<{
		rank: 1 | 2 | 3;
		name: string;
		points: number;
		avatar: CanvasImage | null;
	}>,
	opts: { x: number; y: number; width: number; height: number },
) {
	const { x, y, width, height } = opts;

	const byRank = new Map(entries.map((e) => [e.rank, e] as const));
	const order = [
		byRank.get(2) ?? null,
		byRank.get(1) ?? null,
		byRank.get(3) ?? null,
	];

	const gap = 22;
	const cardW = (width - gap * 2) / 3;
	const firstH = height;
	const sideH = Math.round(height * 0.82);

	for (let i = 0; i < 3; i++) {
		const entry = order[i];
		if (!entry) continue;
		const isFirst = entry.rank === 1;
		const cardH = isFirst ? firstH : sideH;
		const cx = x + i * (cardW + gap);
		const cy = y + (firstH - cardH);
		const medal = MEDAL[entry.rank - 1]!;

		// Card body
		ctx.save();
		ctx.fillStyle = "#252222";
		ctx.beginPath();
		ctx.roundRect(cx, cy, cardW, cardH, 20);
		ctx.fill();
		if (isFirst) {
			ctx.shadowColor = medal;
			ctx.shadowBlur = 24;
		}
		ctx.strokeStyle = medal;
		ctx.globalAlpha = isFirst ? 0.9 : 0.55;
		ctx.lineWidth = isFirst ? 2.5 : 1.5;
		ctx.beginPath();
		ctx.roundRect(cx, cy, cardW, cardH, 20);
		ctx.stroke();
		ctx.restore();

		// Trophy circle on top
		const badgeR = 20;
		const badgeCx = cx + cardW / 2;
		const badgeCy = cy - 4;
		ctx.save();
		ctx.fillStyle = medal;
		ctx.shadowColor = medal;
		ctx.shadowBlur = 14;
		ctx.beginPath();
		ctx.arc(badgeCx, badgeCy, badgeR, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
		ctx.font = _FONT("bold", 20);
		ctx.fillStyle = entry.rank === 1 ? "#000" : "#fff";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(`${entry.rank}`, badgeCx, badgeCy + 1);
		ctx.textBaseline = "alphabetic";

		// Avatar
		const avR = isFirst ? 42 : 34;
		const avY = cy + 38 + avR;
		ctx.save();
		ctx.beginPath();
		ctx.arc(cx + cardW / 2, avY, avR, 0, Math.PI * 2, true);
		ctx.clip();
		if (entry.avatar) {
			ctx.drawImage(
				entry.avatar,
				cx + cardW / 2 - avR,
				avY - avR,
				avR * 2,
				avR * 2,
			);
		} else {
			ctx.fillStyle = "#2d2929";
			ctx.fillRect(cx + cardW / 2 - avR, avY - avR, avR * 2, avR * 2);
		}
		ctx.restore();
		ctx.save();
		if (isFirst) {
			ctx.shadowColor = medal;
			ctx.shadowBlur = 12;
		}
		ctx.strokeStyle = medal;
		ctx.lineWidth = 2.5;
		ctx.beginPath();
		ctx.arc(cx + cardW / 2, avY, avR, 0, Math.PI * 2);
		ctx.stroke();
		ctx.restore();

		// Name
		ctx.font = _FONT("bold", isFirst ? 22 : 18);
		ctx.fillStyle = "#f5f0f0";
		ctx.textAlign = "center";
		const displayName =
			entry.name.length > 14 ? `${entry.name.substring(0, 14)}…` : entry.name;
		ctx.fillText(displayName, cx + cardW / 2, avY + avR + 28);

		// Caption
		ctx.font = _FONT("bold", 10);
		ctx.fillStyle = "#a89999";
		ctx.fillText(
			`BLADER ${theme.title.split(" ")[0] ?? "RPB"}`,
			cx + cardW / 2,
			avY + avR + 46,
		);

		// Points pill
		const pillText = `${entry.points.toLocaleString()} PTS`;
		ctx.font = _FONT("bold", isFirst ? 18 : 15);
		const pillW = ctx.measureText(pillText).width + 24;
		const pillH = isFirst ? 32 : 28;
		const pillX = cx + cardW / 2 - pillW / 2;
		const pillY = cy + cardH - pillH - 14;
		ctx.save();
		ctx.fillStyle = `${medal}22`;
		ctx.beginPath();
		ctx.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
		ctx.fill();
		ctx.strokeStyle = `${medal}66`;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
		ctx.stroke();
		ctx.restore();
		ctx.fillStyle = medal;
		ctx.textAlign = "center";
		ctx.fillText(pillText, cx + cardW / 2, pillY + pillH / 2 + 6);
	}
}

// ─── Interaction Card ───

export interface InteractionCardData {
	userAName: string;
	userAAvatarUrl: string;
	userBName: string;
	userBAvatarUrl: string;
	mentionsAtoB: number;
	mentionsBtoA: number;
	total: number;
	score: number;
	label: string;
	color: number;
}

function drawCircularAvatar(
	ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	img: CanvasImage | null,
	cx: number,
	cy: number,
	radius: number,
	borderColor: string,
) {
	// Border
	ctx.beginPath();
	ctx.arc(cx, cy, radius + 5, 0, Math.PI * 2);
	ctx.fillStyle = borderColor;
	ctx.fill();

	// Clip & draw
	ctx.save();
	ctx.beginPath();
	ctx.arc(cx, cy, radius, 0, Math.PI * 2);
	ctx.closePath();
	ctx.clip();
	if (img) {
		ctx.drawImage(img, cx - radius, cy - radius, radius * 2, radius * 2);
	} else {
		ctx.fillStyle = "#374151";
		ctx.fill();
	}
	ctx.restore();
}

export async function generateInteractionCard(
	data: InteractionCardData,
): Promise<Buffer> {
	const width = 800;
	const height = 400;
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	const _hexColor = `#${data.color.toString(16).padStart(6, "0")}`;

	// ── Dark warm background ──
	ctx.fillStyle = "#141111";
	ctx.fillRect(0, 0, width, height);

	const background = await safeLoadImage("/canvas.webp");
	if (background) {
		ctx.globalAlpha = 0.12;
		ctx.drawImage(background, 0, 0, width, height);
		ctx.globalAlpha = 1;
	}

	// ── Subtle diagonal speed lines ──
	ctx.save();
	ctx.globalAlpha = 0.025;
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 1;
	for (let i = -height; i < width + height; i += 16) {
		ctx.beginPath();
		ctx.moveTo(i, 0);
		ctx.lineTo(i + height * 0.5, height);
		ctx.stroke();
	}
	ctx.restore();

	// ── Main card container ──
	ctx.fillStyle = "#1d1b1b";
	ctx.beginPath();
	ctx.roundRect(20, 20, width - 40, height - 40, 16);
	ctx.fill();

	// Inner subtle border
	ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.roundRect(20, 20, width - 40, height - 40, 16);
	ctx.stroke();

	// ── Top gradient accent bar (RPB colors) ──
	const topGrad = ctx.createLinearGradient(20, 0, width - 20, 0);
	topGrad.addColorStop(0, "#ce0c07");
	topGrad.addColorStop(0.5, "#e68002");
	topGrad.addColorStop(1, "#f7d301");
	ctx.fillStyle = topGrad;
	ctx.beginPath();
	ctx.roundRect(20, 20, width - 40, 4, [16, 16, 0, 0]);
	ctx.fill();

	// ── Load avatars ──
	const [avatarA, avatarB] = await Promise.all([
		safeLoadImage(data.userAAvatarUrl),
		safeLoadImage(data.userBAvatarUrl),
	]);

	// ── Avatars with RPB glow ──
	const avatarRadius = 60;
	const avatarY = 115;
	const avatarAX = 160;
	const avatarBX = width - 160;

	// Avatar A — glow + conic ring
	ctx.save();
	ctx.shadowColor = "#ce0c0740";
	ctx.shadowBlur = 20;
	ctx.beginPath();
	ctx.arc(avatarAX, avatarY, avatarRadius + 4, 0, Math.PI * 2);
	ctx.strokeStyle = "#ce0c07";
	ctx.lineWidth = 2;
	ctx.stroke();
	ctx.restore();
	drawCircularAvatar(ctx, avatarA, avatarAX, avatarY, avatarRadius, "#ce0c07");
	const ringA = ctx.createConicGradient(0, avatarAX, avatarY);
	ringA.addColorStop(0, "#ce0c07");
	ringA.addColorStop(0.33, "#e68002");
	ringA.addColorStop(0.66, "#f7d301");
	ringA.addColorStop(1, "#ce0c07");
	ctx.strokeStyle = ringA;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.arc(avatarAX, avatarY, avatarRadius, 0, Math.PI * 2);
	ctx.stroke();

	// Avatar B — same style
	ctx.save();
	ctx.shadowColor = "#ce0c0740";
	ctx.shadowBlur = 20;
	ctx.beginPath();
	ctx.arc(avatarBX, avatarY, avatarRadius + 4, 0, Math.PI * 2);
	ctx.strokeStyle = "#ce0c07";
	ctx.lineWidth = 2;
	ctx.stroke();
	ctx.restore();
	drawCircularAvatar(ctx, avatarB, avatarBX, avatarY, avatarRadius, "#ce0c07");
	const ringB = ctx.createConicGradient(0, avatarBX, avatarY);
	ringB.addColorStop(0, "#ce0c07");
	ringB.addColorStop(0.33, "#e68002");
	ringB.addColorStop(0.66, "#f7d301");
	ringB.addColorStop(1, "#ce0c07");
	ctx.strokeStyle = ringB;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.arc(avatarBX, avatarY, avatarRadius, 0, Math.PI * 2);
	ctx.stroke();

	// ── Connection line between avatars ──
	ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
	ctx.lineWidth = 2;
	ctx.setLineDash([6, 4]);
	ctx.beginPath();
	ctx.moveTo(avatarAX + avatarRadius + 10, avatarY);
	ctx.lineTo(avatarBX - avatarRadius - 10, avatarY);
	ctx.stroke();
	ctx.setLineDash([]);

	// ── Center score circle ──
	const centerX = width / 2;
	const scoreRadius = 40;

	// Glow
	ctx.save();
	ctx.shadowColor = "#ce0c0750";
	ctx.shadowBlur = 25;
	ctx.beginPath();
	ctx.arc(centerX, avatarY, scoreRadius + 6, 0, Math.PI * 2);
	ctx.strokeStyle = "#ce0c07";
	ctx.lineWidth = 2;
	ctx.stroke();
	ctx.restore();

	// Circle bg
	ctx.beginPath();
	ctx.arc(centerX, avatarY, scoreRadius, 0, Math.PI * 2);
	ctx.fillStyle = "#141111";
	ctx.fill();

	// Gradient ring
	const scoreRing = ctx.createConicGradient(0, centerX, avatarY);
	scoreRing.addColorStop(0, "#ce0c07");
	scoreRing.addColorStop(0.5, "#f7d301");
	scoreRing.addColorStop(1, "#ce0c07");
	ctx.strokeStyle = scoreRing;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.arc(centerX, avatarY, scoreRadius, 0, Math.PI * 2);
	ctx.stroke();

	// Score text
	ctx.textAlign = "center";
	ctx.font = _FONT("bold", 34);
	ctx.fillStyle = "#f7d301";
	ctx.fillText(String(data.score), centerX, avatarY + 12);

	// ── Names under avatars ──
	ctx.font = _FONT("bold", 18);
	ctx.fillStyle = "#f5f0f0";
	const nameA =
		data.userAName.length > 14
			? `${data.userAName.slice(0, 13)}…`
			: data.userAName;
	const nameB =
		data.userBName.length > 14
			? `${data.userBName.slice(0, 13)}…`
			: data.userBName;
	ctx.fillText(nameA, avatarAX, avatarY + avatarRadius + 25);
	ctx.fillText(nameB, avatarBX, avatarY + avatarRadius + 25);

	// ── Label ──
	ctx.font = _FONT("bold", 26);
	const labelGrad = ctx.createLinearGradient(
		centerX - 100,
		0,
		centerX + 100,
		0,
	);
	labelGrad.addColorStop(0, "#ce0c07");
	labelGrad.addColorStop(0.5, "#e68002");
	labelGrad.addColorStop(1, "#f7d301");
	ctx.fillStyle = labelGrad;
	ctx.fillText(data.label, centerX, 240);

	// ── Separator ──
	ctx.fillStyle = "#252222";
	ctx.fillRect(80, 252, width - 160, 2);

	// ── Progress bar ──
	const barX = 100;
	const barY = 268;
	const barW = width - 200;
	const barH = 14;
	const barRadius = barH / 2;
	const fill = Math.min(data.score / 100, 1);

	// Bar background
	ctx.beginPath();
	ctx.roundRect(barX, barY, barW, barH, barRadius);
	ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
	ctx.fill();

	// Bar fill with RPB gradient
	if (fill > 0) {
		const fillW = Math.max(barH, barW * fill);
		ctx.beginPath();
		ctx.roundRect(barX, barY, fillW, barH, barRadius);
		const barGrad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);
		barGrad.addColorStop(0, "#ce0c07");
		barGrad.addColorStop(0.5, "#e68002");
		barGrad.addColorStop(1, "#f7d301");
		ctx.fillStyle = barGrad;
		ctx.fill();
	}

	// ── Mention stats ──
	const statsY = 310;
	ctx.font = _FONT("", 14);

	// Left: A → B
	ctx.textAlign = "left";
	ctx.fillStyle = "#a89999";
	ctx.fillText(`💬 ${data.userAName} → ${data.userBName}`, barX, statsY);
	ctx.fillStyle = "#f5f0f0";
	ctx.font = _FONT("bold", 15);
	ctx.fillText(
		`${data.mentionsAtoB} mention${data.mentionsAtoB > 1 ? "s" : ""}`,
		barX,
		statsY + 22,
	);

	// Right: B → A
	ctx.textAlign = "right";
	ctx.font = _FONT("", 14);
	ctx.fillStyle = "#a89999";
	ctx.fillText(`💬 ${data.userBName} → ${data.userAName}`, barX + barW, statsY);
	ctx.fillStyle = "#f5f0f0";
	ctx.font = _FONT("bold", 15);
	ctx.fillText(
		`${data.mentionsBtoA} mention${data.mentionsBtoA > 1 ? "s" : ""}`,
		barX + barW,
		statsY + 22,
	);

	// ── Footer ──
	ctx.textAlign = "center";
	ctx.font = _FONT("", 12);
	ctx.fillStyle = "#a8999960";
	ctx.fillText(
		`${data.total} mentions mutuelles · rpbey.fr`,
		centerX,
		height - 32,
	);
	ctx.font = _FONT("bold", 11);
	ctx.fillStyle = "#a8999940";
	ctx.fillText("RÉPUBLIQUE POPULAIRE DU BEYBLADE", centerX, height - 16);

	return canvas.toBuffer("image/png");
}

// ─── WANTED Poster (One Piece template) ───

export async function generateWantedImage(
	displayName: string,
	avatarUrl: string,
	bounty: string,
	_crime: string,
) {
	// Load the One Piece wanted template
	const templatePath = getAssetPath("bot/assets/wanted-template.png");
	const template = await loadImage(templatePath);

	// Output at a readable size (scale down from 3508x4961)
	const width = 700;
	const height = Math.round((width / template.width) * template.height);
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	// Draw template as background
	ctx.drawImage(template, 0, 0, width, height);

	// Scale factor from original template coordinates
	const sx = width / 3508;
	const sy = height / 4961;

	// ── Photo area ──
	// The black rectangle in template: (330, 1070) to (3180, 3120)
	const frameX = Math.round(330 * sx);
	const frameY = Math.round(1070 * sy);
	const frameW = Math.round((3180 - 330) * sx);
	const frameH = Math.round((3120 - 1070) * sy);

	// Fill the black rectangle with matching parchment color
	ctx.fillStyle = "#bfb196";
	ctx.fillRect(frameX, frameY, frameW, frameH);

	// Draw avatar centered at 60% of frame size
	const avatar = await safeLoadImage(avatarUrl);
	if (avatar) {
		const avatarSize = Math.round(Math.min(frameW, frameH) * 0.6);
		const avatarX = frameX + Math.round((frameW - avatarSize) / 2);
		const avatarY = frameY + Math.round((frameH - avatarSize) / 2);
		ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
	}

	// ── Name (below DEAD OR ALIVE, above the small text) ──
	// Position: centered, approx y=4050 in original
	const nameY = Math.round(4100 * sy);
	ctx.textAlign = "center";
	ctx.fillStyle = "#3b2a14";

	const nameText = displayName.toUpperCase();
	ctx.font = `bold ${Math.round(200 * sx)}px GoogleSans`;
	if (ctx.measureText(nameText).width > width * 0.85) {
		ctx.font = `bold ${Math.round(150 * sx)}px GoogleSans`;
	}
	ctx.fillText(nameText, width / 2, nameY);

	// ── Bounty (below the name) ──
	const bountyY = Math.round(4450 * sy);
	ctx.font = `bold ${Math.round(230 * sx)}px GoogleSans`;
	ctx.fillStyle = "#3b2a14";
	if (ctx.measureText(bounty).width > width * 0.85) {
		ctx.font = `bold ${Math.round(170 * sx)}px GoogleSans`;
	}
	ctx.fillText(bounty, width / 2, bountyY);

	return canvas.toBuffer("image/png");
}

// ─── Gacha Card Generator (v3 — TCG Layout) ─────────────────────────────────

export interface GachaCardData {
	name: string;
	nameJp?: string | null;
	series: string;
	rarity: string;
	beyblade?: string | null;
	description?: string | null;
	imageUrl?: string | null;
	isDuplicate: boolean;
	isWished: boolean;
	balance: number;
	att?: number;
	def?: number;
	end?: number;
	equilibre?: number;
	element?: string | null;
	fullArt?: boolean;
	artist?: string | null;
	beybladeImageUrl?: string | null;
	themeOverride?: {
		headerBg?: string;
		borderColor?: string;
		accentColor?: string;
		frameColor?: string;
	};
}

const ELEMENT_ICONS: Record<
	string,
	{ symbol: string; color: string; name: string }
> = {
	FEU: { symbol: "🔥", color: "#ef4444", name: "Feu" },
	EAU: { symbol: "💧", color: "#3b82f6", name: "Eau" },
	TERRE: { symbol: "🌍", color: "#a16207", name: "Terre" },
	VENT: { symbol: "🌪", color: "#22d3ee", name: "Vent" },
	OMBRE: { symbol: "🌑", color: "#7c3aed", name: "Ombre" },
	LUMIERE: { symbol: "✨", color: "#fbbf24", name: "Lumière" },
	NEUTRAL: { symbol: "⚪", color: "#9ca3af", name: "Neutre" },
};

// Element weakness cycle: Feu > Vent > Terre > Eau > Feu, Ombre <> Lumière
const ELEMENT_WEAKNESS: Record<string, string> = {
	FEU: "EAU",
	EAU: "TERRE",
	TERRE: "VENT",
	VENT: "FEU",
	OMBRE: "LUMIERE",
	LUMIERE: "OMBRE",
};

const RARITY_THEMES: Record<
	string,
	{
		borderColor: string;
		borderGradient: [string, string, string];
		glowColor: string;
		bgGradient: [string, string, string];
		accentColor: string;
		label: string;
		stars: number;
		particleCount: number;
		frameColor: string;
		headerBg: string;
	}
> = {
	COMMON: {
		borderColor: "#64748b",
		borderGradient: ["#64748b", "#94a3b8", "#64748b"],
		glowColor: "rgba(100,116,139,0.25)",
		bgGradient: ["#252222", "#1d1b1b", "#252222"],
		accentColor: "#94a3b8",
		label: "COMMUNE",
		stars: 1,
		particleCount: 0,
		frameColor: "#64748b",
		headerBg: "#2d2929",
	},
	RARE: {
		borderColor: "#3b82f6",
		borderGradient: ["#2563eb", "#60a5fa", "#2563eb"],
		glowColor: "rgba(59,130,246,0.35)",
		bgGradient: ["#1a2236", "#152040", "#1a2236"],
		accentColor: "#60a5fa",
		label: "RARE",
		stars: 2,
		particleCount: 4,
		frameColor: "#2563eb",
		headerBg: "#1e3a8a",
	},
	SUPER_RARE: {
		borderColor: "#8b5cf6",
		borderGradient: ["#7c3aed", "#a78bfa", "#7c3aed"],
		glowColor: "rgba(139,92,246,0.4)",
		bgGradient: ["#1e1530", "#2a1f40", "#1e1530"],
		accentColor: "#a78bfa",
		label: "SUPER RARE",
		stars: 3,
		particleCount: 8,
		frameColor: "#7c3aed",
		headerBg: "#4c1d95",
	},
	LEGENDARY: {
		borderColor: "#e68002",
		borderGradient: ["#ce0c07", "#e68002", "#f7d301"],
		glowColor: "rgba(230,128,2,0.5)",
		bgGradient: ["#2d2010", "#3d2a10", "#2d2010"],
		accentColor: "#f7d301",
		label: "LÉGENDAIRE",
		stars: 4,
		particleCount: 14,
		frameColor: "#e68002",
		headerBg: "#7c2d12",
	},
	SECRET: {
		borderColor: "#ce0c07",
		borderGradient: ["#ce0c07", "#e68002", "#f7d301"],
		glowColor: "rgba(206,12,7,0.55)",
		bgGradient: ["#2a1010", "#3a1515", "#2a1010"],
		accentColor: "#f7d301",
		label: "✦ SECRÈTE ✦",
		stars: 5,
		particleCount: 20,
		frameColor: "#ce0c07",
		headerBg: "#7f1d1d",
	},
};

/** Draw noise texture overlay for depth */
function drawNoise(ctx: CanvasCtx, w: number, h: number, alpha = 0.03) {
	const imgData = ctx.getImageData(0, 0, w, h);
	const d = imgData.data;
	for (let i = 0; i < d.length; i += 4) {
		const noise = (Math.random() - 0.5) * 255 * alpha;
		d[i] = Math.min(255, Math.max(0, d[i]! + noise));
		d[i + 1] = Math.min(255, Math.max(0, d[i + 1]! + noise));
		d[i + 2] = Math.min(255, Math.max(0, d[i + 2]! + noise));
	}
	ctx.putImageData(imgData, 0, 0);
}

/** Draw a 4-point sparkle at given position */
function drawSparkle(
	ctx: CanvasCtx,
	x: number,
	y: number,
	size: number,
	color: string,
	alpha = 0.7,
) {
	ctx.save();
	ctx.globalAlpha = alpha;
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(x, y - size);
	ctx.quadraticCurveTo(x + size * 0.15, y - size * 0.15, x + size, y);
	ctx.quadraticCurveTo(x + size * 0.15, y + size * 0.15, x, y + size);
	ctx.quadraticCurveTo(x - size * 0.15, y + size * 0.15, x - size, y);
	ctx.quadraticCurveTo(x - size * 0.15, y - size * 0.15, x, y - size);
	ctx.closePath();
	ctx.fill();
	ctx.globalAlpha = alpha * 0.5;
	ctx.shadowColor = color;
	ctx.shadowBlur = size * 2;
	ctx.fill();
	ctx.restore();
}

/** Draw light rays from top for legendary/secret */
function drawLightRays(
	ctx: CanvasCtx,
	w: number,
	h: number,
	color: string,
	count = 3,
) {
	ctx.save();
	ctx.globalCompositeOperation = "screen";
	for (let i = 0; i < count; i++) {
		const x = w * 0.2 + (w * 0.6 * i) / (count - 1 || 1);
		const grad = ctx.createLinearGradient(x, 0, x + w * 0.05, h * 0.7);
		grad.addColorStop(0, color);
		grad.addColorStop(0.5, `${color}40`);
		grad.addColorStop(1, "rgba(0,0,0,0)");
		ctx.fillStyle = grad;
		ctx.beginPath();
		ctx.moveTo(x - 15, 0);
		ctx.lineTo(x + 15, 0);
		ctx.lineTo(x + 40, h * 0.7);
		ctx.lineTo(x - 10, h * 0.7);
		ctx.closePath();
		ctx.fill();
	}
	ctx.restore();
}

/** Draw a rounded rect with fill + optional stroke */
function drawBox(
	ctx: CanvasCtx,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number | number[],
	fill: string,
	stroke?: string,
	strokeW = 1,
) {
	ctx.fillStyle = fill;
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, r);
	ctx.fill();
	if (stroke) {
		ctx.strokeStyle = stroke;
		ctx.lineWidth = strokeW;
		ctx.beginPath();
		ctx.roundRect(x, y, w, h, r);
		ctx.stroke();
	}
}

/** Draw a horizontal separator line with gradient fade */
function drawSeparator(
	ctx: CanvasCtx,
	x: number,
	y: number,
	w: number,
	color: string,
) {
	const grad = ctx.createLinearGradient(x, y, x + w, y);
	grad.addColorStop(0, `${color}00`);
	grad.addColorStop(0.15, `${color}60`);
	grad.addColorStop(0.5, color);
	grad.addColorStop(0.85, `${color}60`);
	grad.addColorStop(1, `${color}00`);
	ctx.strokeStyle = grad;
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(x, y);
	ctx.lineTo(x + w, y);
	ctx.stroke();
}

// Generation colors: Bakuten=red, Metal=gold, Burst=green, X=blue
const GEN_COLORS: Record<string, string> = {
	BAKUTEN: "#ef4444",
	BAKUTEN_SHOOT: "#ef4444",
	METAL: "#f59e0b",
	BURST: "#22c55e",
	X: "#3b82f6",
	METAL_MASTERS: "#f59e0b",
	METAL_FURY: "#f59e0b",
	METAL_FUSION: "#f59e0b",
	BEYBLADE_X: "#3b82f6",
	BURST_SURGE: "#22c55e",
	BURST_GT: "#22c55e",
};

/** Draw holographic foil overlay — rainbow conic gradient, screen-blended */
function drawHoloFoil(
	ctx: CanvasCtx,
	x: number,
	y: number,
	w: number,
	h: number,
	intensity: number,
) {
	ctx.save();
	ctx.globalCompositeOperation = "screen";
	ctx.globalAlpha = intensity;
	const holo = ctx.createConicGradient(0, x + w / 2, y + h / 2);
	holo.addColorStop(0, "#ff000040");
	holo.addColorStop(0.12, "#ff880040");
	holo.addColorStop(0.25, "#ffff0040");
	holo.addColorStop(0.37, "#00ff0040");
	holo.addColorStop(0.5, "#00ffff40");
	holo.addColorStop(0.62, "#0044ff40");
	holo.addColorStop(0.75, "#8800ff40");
	holo.addColorStop(0.87, "#ff00ff40");
	holo.addColorStop(1, "#ff000040");
	ctx.fillStyle = holo;
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, 4);
	ctx.fill();
	ctx.restore();
}

/** Draw holographic seal stamp */
function drawHoloSeal(
	ctx: CanvasCtx,
	cx: number,
	cy: number,
	radius: number,
	color: string,
) {
	// Rainbow ring
	ctx.save();
	const sealHolo = ctx.createConicGradient(0, cx, cy);
	sealHolo.addColorStop(0, "#ef4444");
	sealHolo.addColorStop(0.2, "#f59e0b");
	sealHolo.addColorStop(0.4, "#22c55e");
	sealHolo.addColorStop(0.6, "#3b82f6");
	sealHolo.addColorStop(0.8, "#a855f7");
	sealHolo.addColorStop(1, "#ef4444");
	ctx.strokeStyle = sealHolo;
	ctx.lineWidth = 2.5;
	ctx.beginPath();
	ctx.arc(cx, cy, radius, 0, Math.PI * 2);
	ctx.stroke();
	// Inner fill
	ctx.fillStyle = `${color}30`;
	ctx.beginPath();
	ctx.arc(cx, cy, radius - 2, 0, Math.PI * 2);
	ctx.fill();
	// Text
	ctx.font = "bold 9px GoogleSans";
	ctx.fillStyle = color;
	ctx.textAlign = "center";
	ctx.fillText("RPB", cx, cy + 3);
	ctx.restore();
}

/** Draw Battle Edge — row of 6 colored diamonds */
function _drawBattleEdge(
	ctx: CanvasCtx,
	x: number,
	y: number,
	w: number,
	h: number,
	genColor: string,
	glowStars: number,
) {
	// Background bar
	ctx.fillStyle = "rgba(0,0,0,0.5)";
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, [8, 8, 0, 0]);
	ctx.fill();
	const edgeColors = [
		"#ef4444",
		"#f59e0b",
		"#22c55e",
		"#3b82f6",
		"#a855f7",
		genColor,
	];
	const dSize = 7;
	const gap = w / 7;
	for (let i = 0; i < 6; i++) {
		const dx = x + gap * (i + 1);
		const dy = y + h / 2;
		ctx.fillStyle = edgeColors[i]!;
		ctx.beginPath();
		ctx.moveTo(dx, dy - dSize);
		ctx.lineTo(dx + dSize, dy);
		ctx.lineTo(dx, dy + dSize);
		ctx.lineTo(dx - dSize, dy);
		ctx.closePath();
		ctx.fill();
		if (glowStars >= 3) {
			ctx.shadowColor = edgeColors[i]!;
			ctx.shadowBlur = 5;
			ctx.fill();
			ctx.shadowBlur = 0;
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// TCG CARD — Full-size single pull (v4 — Holo foil + Battle Edge + Full-Art)
// ─────────────────────────────────────────────────────────────────────────────

const BEY_TYPE_COLORS: Record<string, string> = {
	ATTACK: "#ef4444",
	DEFENSE: "#3b82f6",
	STAMINA: "#22c55e",
	BALANCE: "#a855f7",
};

export interface BattleResultData {
	winnerName: string;
	winnerAvatarUrl: string;
	winnerCombo: string;
	winnerType: string | null;
	loserName: string;
	loserAvatarUrl: string;
	loserCombo: string;
	loserType: string | null;
	finishMessage: string;
	hpWinner: number;
	hpLoser: number;
	maxHp: number;
	rounds: number;
	coinReward: number;
	log: string[];
}

export async function generateBattleResultCard(
	data: BattleResultData,
): Promise<Buffer> {
	const W = 900;
	const H = 520;
	const canvas = createCanvas(W, H);
	const ctx = canvas.getContext("2d");

	// ── Dark warm background ──
	ctx.fillStyle = "#141111";
	ctx.fillRect(0, 0, W, H);

	const background = await safeLoadImage("/canvas.webp");
	if (background) {
		ctx.globalAlpha = 0.12;
		ctx.drawImage(background, 0, 0, W, H);
		ctx.globalAlpha = 1;
	}

	// ── Subtle diagonal speed lines ──
	ctx.save();
	ctx.globalAlpha = 0.025;
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 1;
	for (let i = -H; i < W + H; i += 16) {
		ctx.beginPath();
		ctx.moveTo(i, 0);
		ctx.lineTo(i + H * 0.5, H);
		ctx.stroke();
	}
	ctx.restore();

	// ── Main card container ──
	ctx.fillStyle = "#1d1b1b";
	ctx.beginPath();
	ctx.roundRect(16, 16, W - 32, H - 32, 16);
	ctx.fill();

	// Inner subtle border
	ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.roundRect(16, 16, W - 32, H - 32, 16);
	ctx.stroke();

	// ── Top gradient accent bar (RPB colors) ──
	const topGrad = ctx.createLinearGradient(16, 0, W - 16, 0);
	topGrad.addColorStop(0, "#ce0c07");
	topGrad.addColorStop(0.5, "#e68002");
	topGrad.addColorStop(1, "#f7d301");
	ctx.fillStyle = topGrad;
	ctx.beginPath();
	ctx.roundRect(16, 16, W - 32, 4, [16, 16, 0, 0]);
	ctx.fill();

	// ── Center diagonal slash accents ──
	ctx.save();
	ctx.globalAlpha = 0.06;
	ctx.strokeStyle = "#ce0c07";
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.moveTo(W * 0.4, 0);
	ctx.lineTo(W * 0.6, H);
	ctx.stroke();
	ctx.strokeStyle = "#e6800240";
	ctx.beginPath();
	ctx.moveTo(W * 0.42, 0);
	ctx.lineTo(W * 0.62, H);
	ctx.stroke();
	ctx.restore();

	// ── Finish banner (RPB gradient pill) ──
	const bannerGrad = ctx.createLinearGradient(W / 2 - 180, 0, W / 2 + 180, 0);
	bannerGrad.addColorStop(0, "#ce0c07");
	bannerGrad.addColorStop(1, "#e68002");
	ctx.fillStyle = bannerGrad;
	ctx.shadowColor = "#ce0c0750";
	ctx.shadowBlur = 15;
	ctx.beginPath();
	ctx.roundRect(W / 2 - 180, 28, 360, 40, 20);
	ctx.fill();
	ctx.shadowBlur = 0;
	ctx.font = _FONT("bold", 20);
	ctx.fillStyle = "#ffffff";
	ctx.textAlign = "center";
	ctx.fillText(data.finishMessage, W / 2, 55);

	// ── Winner side (left) ──
	const wAvatar = await safeLoadImage(data.winnerAvatarUrl);
	const wColor = BEY_TYPE_COLORS[data.winnerType || ""] || "#f7d301";

	// Glow + conic ring
	ctx.save();
	ctx.shadowColor = `${wColor}60`;
	ctx.shadowBlur = 25;
	ctx.strokeStyle = wColor;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.arc(150, 180, 65, 0, Math.PI * 2);
	ctx.stroke();
	ctx.restore();

	// Avatar
	ctx.save();
	ctx.beginPath();
	ctx.arc(150, 180, 63, 0, Math.PI * 2);
	ctx.clip();
	if (wAvatar) ctx.drawImage(wAvatar, 87, 117, 126, 126);
	else {
		ctx.fillStyle = "#2d2929";
		ctx.fill();
	}
	ctx.restore();

	// RPB conic ring
	const wRing = ctx.createConicGradient(0, 150, 180);
	wRing.addColorStop(0, "#ce0c07");
	wRing.addColorStop(0.33, "#e68002");
	wRing.addColorStop(0.66, "#f7d301");
	wRing.addColorStop(1, "#ce0c07");
	ctx.strokeStyle = wRing;
	ctx.lineWidth = 4;
	ctx.beginPath();
	ctx.arc(150, 180, 63, 0, Math.PI * 2);
	ctx.stroke();

	// Crown
	ctx.font = _FONT("", 30);
	ctx.fillText("👑", 150, 100);

	// Winner name
	ctx.font = _FONT("bold", 22);
	ctx.fillStyle = "#f7d301";
	ctx.fillText(data.winnerName, 150, 270);

	// Combo
	ctx.font = _FONT("", 12);
	ctx.fillStyle = "#a89999";
	ctx.fillText(data.winnerCombo, 150, 290);

	// HP bar winner
	const hpBarW = 200;
	const wPct = data.hpWinner / data.maxHp;
	ctx.fillStyle = "rgba(255,255,255,0.06)";
	ctx.beginPath();
	ctx.roundRect(50, 305, hpBarW, 10, 5);
	ctx.fill();
	ctx.fillStyle = "#22c55e";
	ctx.beginPath();
	ctx.roundRect(50, 305, hpBarW * wPct, 10, 5);
	ctx.fill();
	ctx.font = _FONT("", 10);
	ctx.fillStyle = "#a89999";
	ctx.fillText(`${Math.round(data.hpWinner)}/${data.maxHp} PV`, 150, 330);

	// ── VS ──
	ctx.font = _FONT("bold", 50);
	ctx.fillStyle = "rgba(206,12,7,0.08)";
	ctx.fillText("VS", W / 2, 200);

	// ── Loser side (right) ──
	const lAvatar = await safeLoadImage(data.loserAvatarUrl);
	const lColor = BEY_TYPE_COLORS[data.loserType || ""] || "#6b7280";

	ctx.strokeStyle = `${lColor}50`;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.arc(W - 150, 180, 55, 0, Math.PI * 2);
	ctx.stroke();

	ctx.save();
	ctx.beginPath();
	ctx.arc(W - 150, 180, 53, 0, Math.PI * 2);
	ctx.clip();
	if (lAvatar) ctx.drawImage(lAvatar, W - 203, 127, 106, 106);
	else {
		ctx.fillStyle = "#2d2929";
		ctx.fill();
	}
	ctx.restore();

	// Dark overlay on loser
	ctx.fillStyle = "rgba(20,17,17,0.4)";
	ctx.beginPath();
	ctx.arc(W - 150, 180, 53, 0, Math.PI * 2);
	ctx.fill();

	ctx.font = _FONT("bold", 18);
	ctx.fillStyle = "#6b5555";
	ctx.fillText(data.loserName, W - 150, 260);

	ctx.font = _FONT("", 12);
	ctx.fillStyle = "#a8999980";
	ctx.fillText(data.loserCombo, W - 150, 280);

	// HP bar loser
	ctx.fillStyle = "rgba(255,255,255,0.06)";
	ctx.beginPath();
	ctx.roundRect(W - 250, 295, hpBarW, 10, 5);
	ctx.fill();
	const lPct = data.hpLoser / data.maxHp;
	if (lPct > 0) {
		ctx.fillStyle = "#ef4444";
		ctx.beginPath();
		ctx.roundRect(W - 250, 295, hpBarW * lPct, 10, 5);
		ctx.fill();
	}
	ctx.font = _FONT("", 10);
	ctx.fillStyle = "#a8999980";
	ctx.fillText(`${Math.round(data.hpLoser)}/${data.maxHp} PV`, W - 150, 320);

	// ── Battle log (dark surface) ──
	ctx.fillStyle = "#252222";
	ctx.beginPath();
	ctx.roundRect(30, 350, W - 60, 115, 10);
	ctx.fill();
	ctx.strokeStyle = "rgba(255,255,255,0.04)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.roundRect(30, 350, W - 60, 115, 10);
	ctx.stroke();

	ctx.font = _FONT("bold", 11);
	ctx.fillStyle = "#a89999";
	ctx.textAlign = "left";
	ctx.fillText(`COMBAT · ${data.rounds} TOURS`, 50, 370);

	ctx.font = _FONT("", 12);
	ctx.fillStyle = "#f5f0f0cc";
	const logLines = data.log.slice(-4);
	for (let i = 0; i < logLines.length; i++) {
		let text = logLines[i]!;
		if (ctx.measureText(text).width > W - 100)
			text = `${text.substring(0, 80)}…`;
		ctx.fillText(text, 50, 390 + i * 18);
	}

	// ── Reward bar (RPB gradient tint) ──
	const rewardGrad = ctx.createLinearGradient(30, 0, W - 30, 0);
	rewardGrad.addColorStop(0, "rgba(206,12,7,0.08)");
	rewardGrad.addColorStop(0.5, "rgba(230,128,2,0.08)");
	rewardGrad.addColorStop(1, "rgba(247,211,1,0.08)");
	ctx.fillStyle = rewardGrad;
	ctx.beginPath();
	ctx.roundRect(30, H - 48, W - 60, 30, 8);
	ctx.fill();
	ctx.font = _FONT("bold", 13);
	ctx.fillStyle = "#f7d301";
	ctx.textAlign = "center";
	ctx.fillText(
		`🪙 ${data.winnerName} +${data.coinReward} · ${data.loserName} +5`,
		W / 2,
		H - 28,
	);

	return canvas.toBuffer("image/png");
}

// ─── Gacha Duel Canvas (v2 — HD) ────────────────────────────────────────────

export interface GachaDuelData {
	cardA: {
		name: string;
		rarity: string;
		beyblade: string;
		imageUrl: string | null;
		series: string;
	};
	cardB: {
		name: string;
		rarity: string;
		beyblade: string;
		imageUrl: string | null;
		series: string;
	};
	playerA: string;
	playerB: string;
	winner: "A" | "B";
	finishMessage: string;
	scoreA: number;
	scoreB: number;
	coinReward: number;
}

const DUEL_ELEMENT_COLORS: Record<string, string> = {
	FEU: "#ef4444",
	EAU: "#3b82f6",
	TERRE: "#a16207",
	VENT: "#22d3ee",
	OMBRE: "#7c3aed",
	LUMIERE: "#fbbf24",
	NEUTRAL: "#6b7280",
};

const DUEL_ELEMENT_ICONS: Record<string, string> = {
	FEU: "🔥",
	EAU: "💧",
	TERRE: "🌍",
	VENT: "🌪",
	OMBRE: "🌑",
	LUMIERE: "✨",
	NEUTRAL: "⚪",
};

const DUEL_RARITY_BORDER: Record<string, string> = {
	COMMON: "#6b7280",
	RARE: "#3b82f6",
	SUPER_RARE: "#8b5cf6",
	LEGENDARY: "#f59e0b",
	SECRET: "#ef4444",
};

export interface DuelArenaRoundCard {
	name: string;
	rarity: string;
	element: string;
	imageUrl: string | null;
	power: number;
	beyblade: string | null;
}

export interface DuelArenaData {
	playerA: { name: string; avatarUrl: string };
	playerB: { name: string; avatarUrl: string };
	rounds: Array<{
		cardA: DuelArenaRoundCard;
		cardB: DuelArenaRoundCard;
		winner: "A" | "B";
		events: string[];
	}>;
	score: [number, number];
	winner: "A" | "B";
	bet: number;
	coinReward: number;
	finishMessage: string;
	matchId: string;
}

export async function generateDuelArenaCard(
	data: DuelArenaData,
): Promise<Buffer> {
	const W = 1400;
	const roundCount = data.rounds.length;
	const ROUND_H = 260;
	const HEADER_H = 120;
	const FOOTER_H = 155;
	const H = HEADER_H + roundCount * ROUND_H + FOOTER_H;

	const canvas = createCanvas(W, H);
	const ctx = canvas.getContext("2d");

	// ── Background — warm dark (RPB design system) ──
	const bg = ctx.createLinearGradient(0, 0, W, H);
	bg.addColorStop(0, "#141111");
	bg.addColorStop(0.3, "#1a1515");
	bg.addColorStop(0.6, "#161212");
	bg.addColorStop(1, "#141111");
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, W, H);

	// Center energy glow (RPB red→orange)
	const glow = ctx.createRadialGradient(W / 2, H / 2, 30, W / 2, H / 2, 500);
	glow.addColorStop(0, "rgba(206,12,7,0.12)");
	glow.addColorStop(0.4, "rgba(230,128,2,0.04)");
	glow.addColorStop(1, "rgba(0,0,0,0)");
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, W, H);

	// Diagonal energy lines
	ctx.save();
	ctx.globalAlpha = 0.02;
	ctx.strokeStyle = "#ce0c07";
	ctx.lineWidth = 1;
	for (let i = -H; i < W + H; i += 40) {
		ctx.beginPath();
		ctx.moveTo(i, 0);
		ctx.lineTo(i + H * 0.7, H);
		ctx.stroke();
	}
	ctx.restore();

	// Center vertical energy line
	ctx.save();
	const centerGrad = ctx.createLinearGradient(0, 0, 0, H);
	centerGrad.addColorStop(0, "rgba(206,12,7,0)");
	centerGrad.addColorStop(0.3, "rgba(206,12,7,0.06)");
	centerGrad.addColorStop(0.7, "rgba(206,12,7,0.06)");
	centerGrad.addColorStop(1, "rgba(206,12,7,0)");
	ctx.fillStyle = centerGrad;
	ctx.fillRect(W / 2 - 1.5, 0, 3, H);
	ctx.restore();

	drawNoise(ctx, W, H, 0.012);

	// Border (RPB gradient)
	const brd = ctx.createLinearGradient(0, 0, W, H);
	brd.addColorStop(0, "rgba(206,12,7,0.25)");
	brd.addColorStop(0.5, "rgba(230,128,2,0.35)");
	brd.addColorStop(1, "rgba(247,211,1,0.25)");
	ctx.strokeStyle = brd;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.roundRect(8, 8, W - 16, H - 16, 16);
	ctx.stroke();

	// ── Load avatars ──
	const [avatarA, avatarB] = await Promise.all([
		safeLoadImage(data.playerA.avatarUrl),
		safeLoadImage(data.playerB.avatarUrl),
	]);

	// ── Header ──
	const drawAvatar = (
		img: Awaited<ReturnType<typeof safeLoadImage>>,
		cx: number,
		cy: number,
		r: number,
		isWinner: boolean,
	) => {
		ctx.save();
		if (isWinner) {
			ctx.shadowColor = "rgba(247,211,1,0.6)";
			ctx.shadowBlur = 22;
		}
		ctx.beginPath();
		ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
		ctx.fillStyle = isWinner ? "#f7d301" : "rgba(255,255,255,0.15)";
		ctx.fill();
		ctx.shadowBlur = 0;

		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.clip();
		if (img) {
			ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
		} else {
			ctx.fillStyle = "#2d2929";
			ctx.fill();
		}
		ctx.restore();
	};

	const avatarR = 38;
	const headerY = 56;

	drawAvatar(avatarA, 65, headerY, avatarR, data.winner === "A");
	drawAvatar(avatarB, W - 65, headerY, avatarR, data.winner === "B");

	// Player names
	ctx.font = "bold 28px GoogleSans, NotoEmoji, sans-serif";
	ctx.textAlign = "left";
	ctx.fillStyle = data.winner === "A" ? "#fbbf24" : "#ffffff";
	let nameA = data.playerA.name;
	if (ctx.measureText(nameA).width > 360) nameA = `${nameA.slice(0, 18)}…`;
	ctx.fillText(nameA, 115, headerY + 10);

	ctx.textAlign = "right";
	ctx.fillStyle = data.winner === "B" ? "#fbbf24" : "#ffffff";
	let nameB = data.playerB.name;
	if (ctx.measureText(nameB).width > 360) nameB = `${nameB.slice(0, 18)}…`;
	ctx.fillText(nameB, W - 115, headerY + 10);

	// Title
	ctx.textAlign = "center";
	ctx.font = _FONT("italic bold", 36);
	const titleGrad = ctx.createLinearGradient(W / 2 - 120, 0, W / 2 + 120, 0);
	titleGrad.addColorStop(0, "#ce0c07");
	titleGrad.addColorStop(0.5, "#e68002");
	titleGrad.addColorStop(1, "#f7d301");
	ctx.fillStyle = titleGrad;
	ctx.fillText("RPB ARENA", W / 2, headerY + 10);

	ctx.font = "15px GoogleSans, sans-serif";
	ctx.fillStyle = "rgba(255,255,255,0.35)";
	ctx.fillText(
		`Best of ${roundCount} · Match #${data.matchId}`,
		W / 2,
		headerY + 34,
	);

	// Header separator (RPB gradient)
	const sepY = HEADER_H - 6;
	const sep = ctx.createLinearGradient(50, 0, W - 50, 0);
	sep.addColorStop(0, "rgba(206,12,7,0)");
	sep.addColorStop(0.2, "rgba(206,12,7,0.5)");
	sep.addColorStop(0.5, "rgba(230,128,2,0.7)");
	sep.addColorStop(0.8, "rgba(247,211,1,0.5)");
	sep.addColorStop(1, "rgba(247,211,1,0)");
	ctx.fillStyle = sep;
	ctx.fillRect(50, sepY, W - 100, 2);

	// ── Rounds ──
	const allCardImages = await Promise.all(
		data.rounds.flatMap((r) => [
			safeLoadImage(r.cardA.imageUrl),
			safeLoadImage(r.cardB.imageUrl),
		]),
	);

	for (let i = 0; i < roundCount; i++) {
		const round = data.rounds[i]!;
		const ry = HEADER_H + i * ROUND_H;
		const imgA = allCardImages[i * 2]!;
		const imgB = allCardImages[i * 2 + 1]!;

		// Row background
		ctx.fillStyle =
			i % 2 === 0 ? "rgba(255,255,255,0.015)" : "rgba(0,0,0,0.06)";
		ctx.fillRect(14, ry, W - 28, ROUND_H);

		// Round label
		ctx.font = "bold 18px GoogleSans, sans-serif";
		ctx.fillStyle = "rgba(251,191,36,0.6)";
		ctx.textAlign = "left";
		ctx.fillText(`ROUND ${i + 1}`, 30, ry + 28);

		// ── Mini card renderer ──
		const drawMiniCard = (
			card: DuelArenaRoundCard,
			img: Awaited<ReturnType<typeof safeLoadImage>>,
			x: number,
			y: number,
			isWinner: boolean,
		) => {
			const cW = 140;
			const cH = 190;
			const borderColor = DUEL_RARITY_BORDER[card.rarity] ?? "#6b7280";

			// Glow for winner
			if (isWinner) {
				ctx.save();
				ctx.shadowColor = `${borderColor}90`;
				ctx.shadowBlur = 24;
				ctx.beginPath();
				ctx.roundRect(x, y, cW, cH, 10);
				ctx.fillStyle = "rgba(0,0,0,0.01)";
				ctx.fill();
				ctx.restore();
			}

			// Card bg
			ctx.fillStyle = isWinner ? "rgba(10,10,20,0.85)" : "rgba(10,10,20,0.5)";
			ctx.beginPath();
			ctx.roundRect(x, y, cW, cH, 10);
			ctx.fill();

			// Border
			ctx.strokeStyle = isWinner ? borderColor : `${borderColor}40`;
			ctx.lineWidth = isWinner ? 3 : 2;
			ctx.beginPath();
			ctx.roundRect(x, y, cW, cH, 10);
			ctx.stroke();

			// Card image area
			const imgPad = 6;
			const imgAreaH = cH - 48;
			if (img) {
				ctx.save();
				ctx.beginPath();
				ctx.roundRect(x + imgPad, y + imgPad, cW - imgPad * 2, imgAreaH, 7);
				ctx.clip();
				const ar = img.width / img.height;
				let dw = cW - imgPad * 2;
				let dh = imgAreaH;
				if (ar > dw / dh) dh = dw / ar;
				else dw = dh * ar;
				ctx.drawImage(
					img,
					x + imgPad + (cW - imgPad * 2 - dw) / 2,
					y + imgPad + (imgAreaH - dh) / 2,
					dw,
					dh,
				);
				ctx.restore();
			}

			// Loser overlay
			if (!isWinner) {
				ctx.fillStyle = "rgba(0,0,0,0.55)";
				ctx.beginPath();
				ctx.roundRect(x + imgPad, y + imgPad, cW - imgPad * 2, imgAreaH, 7);
				ctx.fill();
				ctx.font = "bold 48px GoogleSans, sans-serif";
				ctx.fillStyle = "rgba(239,68,68,0.35)";
				ctx.textAlign = "center";
				ctx.fillText("✕", x + cW / 2, y + imgPad + imgAreaH / 2 + 18);
			}

			// Element badge
			const elColor = DUEL_ELEMENT_COLORS[card.element] ?? "#6b7280";
			ctx.beginPath();
			ctx.arc(x + cW - 18, y + 18, 14, 0, Math.PI * 2);
			ctx.fillStyle = `${elColor}DD`;
			ctx.fill();
			ctx.strokeStyle = "rgba(0,0,0,0.4)";
			ctx.lineWidth = 1.5;
			ctx.stroke();
			ctx.font = "14px NotoEmoji, sans-serif";
			ctx.textAlign = "center";
			ctx.fillText(
				DUEL_ELEMENT_ICONS[card.element] ?? "⚪",
				x + cW - 18,
				y + 23,
			);

			// Card name
			ctx.font = "bold 15px GoogleSans, sans-serif";
			ctx.fillStyle = isWinner ? "#ffffff" : "rgba(255,255,255,0.45)";
			ctx.textAlign = "center";
			let nm = card.name;
			if (ctx.measureText(nm).width > cW + 30) nm = `${nm.slice(0, 16)}…`;
			ctx.fillText(nm, x + cW / 2, y + cH - 10);

			// Rarity stars
			const t = RARITY_THEMES[card.rarity];
			if (t && t.stars > 0) {
				ctx.font = "12px GoogleSans, sans-serif";
				ctx.fillStyle = isWinner ? t.accentColor : `${t.accentColor}60`;
				ctx.fillText("★".repeat(t.stars), x + cW / 2, y + cH - 26);
			}
		};

		const cardY = ry + 40;
		const isWinA = round.winner === "A";
		drawMiniCard(round.cardA, imgA, 60, cardY, isWinA);
		drawMiniCard(round.cardB, imgB, W - 200, cardY, !isWinA);

		// ── Center VS + Power comparison ──
		const midX = W / 2;
		const midY = cardY + 70;

		// VS glow
		const vsGlowG = ctx.createRadialGradient(midX, midY, 5, midX, midY, 45);
		vsGlowG.addColorStop(0, "rgba(220,38,38,0.25)");
		vsGlowG.addColorStop(1, "rgba(0,0,0,0)");
		ctx.fillStyle = vsGlowG;
		ctx.fillRect(midX - 45, midY - 45, 90, 90);

		ctx.font = "italic bold 32px GoogleSans, sans-serif";
		ctx.fillStyle = "rgba(255,255,255,0.10)";
		ctx.textAlign = "center";
		ctx.fillText("VS", midX, midY + 12);

		// Power values (large)
		ctx.font = "bold 30px GoogleSans, sans-serif";
		ctx.textAlign = "right";
		ctx.fillStyle = isWinA ? "#22c55e" : "#ef4444";
		ctx.fillText(String(round.cardA.power), midX - 45, midY - 14);

		ctx.textAlign = "center";
		ctx.font = "bold 20px GoogleSans, NotoEmoji, sans-serif";
		ctx.fillStyle = "rgba(255,255,255,0.25)";
		ctx.fillText("⚔️", midX, midY - 14);

		ctx.textAlign = "left";
		ctx.font = "bold 30px GoogleSans, sans-serif";
		ctx.fillStyle = !isWinA ? "#22c55e" : "#ef4444";
		ctx.fillText(String(round.cardB.power), midX + 45, midY - 14);

		// Power bars (thicker)
		const barW = 190;
		const barH = 10;
		const barY2 = midY + 16;
		const maxPwr = Math.max(round.cardA.power, round.cardB.power, 1);

		// Bar A
		const pctA = round.cardA.power / maxPwr;
		ctx.fillStyle = "rgba(255,255,255,0.06)";
		ctx.beginPath();
		ctx.roundRect(midX - 40 - barW, barY2, barW, barH, 5);
		ctx.fill();
		const barAGrad = ctx.createLinearGradient(
			midX - 40 - barW,
			0,
			midX - 40,
			0,
		);
		barAGrad.addColorStop(0, isWinA ? "#22c55e20" : "#ef444420");
		barAGrad.addColorStop(1, isWinA ? "#22c55e" : "#ef4444");
		ctx.fillStyle = barAGrad;
		ctx.beginPath();
		ctx.roundRect(midX - 40 - barW * pctA, barY2, barW * pctA, barH, 5);
		ctx.fill();

		// Bar B
		const pctB = round.cardB.power / maxPwr;
		ctx.fillStyle = "rgba(255,255,255,0.06)";
		ctx.beginPath();
		ctx.roundRect(midX + 40, barY2, barW, barH, 5);
		ctx.fill();
		const barBGrad = ctx.createLinearGradient(
			midX + 40,
			0,
			midX + 40 + barW,
			0,
		);
		barBGrad.addColorStop(0, !isWinA ? "#22c55e" : "#ef4444");
		barBGrad.addColorStop(1, !isWinA ? "#22c55e20" : "#ef444420");
		ctx.fillStyle = barBGrad;
		ctx.beginPath();
		ctx.roundRect(midX + 40, barY2, barW * pctB, barH, 5);
		ctx.fill();

		// Winner indicator
		ctx.font = "bold 22px GoogleSans, NotoEmoji, sans-serif";
		const winX = isWinA ? 220 : W - 220;
		ctx.fillStyle = "#22c55e";
		ctx.textAlign = "center";
		ctx.fillText("✓", winX, cardY + 90);

		// Events (larger text, brighter)
		if (round.events.length > 0) {
			ctx.font = "15px GoogleSans, NotoEmoji, sans-serif";
			ctx.fillStyle = "rgba(251,191,36,0.75)";
			ctx.textAlign = "center";
			const evText = round.events.slice(0, 2).join("  ·  ");
			let truncated = evText;
			if (ctx.measureText(truncated).width > 550)
				truncated = `${truncated.slice(0, 65)}…`;
			ctx.fillText(truncated, midX, barY2 + 38);
		}

		// Round separator
		if (i < roundCount - 1) {
			const rsY = ry + ROUND_H - 2;
			ctx.fillStyle = "rgba(255,255,255,0.05)";
			ctx.fillRect(50, rsY, W - 100, 1.5);
		}
	}

	// ── Footer ──
	const fy = HEADER_H + roundCount * ROUND_H;

	// Separator
	const footSep = ctx.createLinearGradient(50, 0, W - 50, 0);
	footSep.addColorStop(0, "rgba(251,191,36,0)");
	footSep.addColorStop(0.3, "rgba(251,191,36,0.45)");
	footSep.addColorStop(0.5, "rgba(251,191,36,0.65)");
	footSep.addColorStop(0.7, "rgba(251,191,36,0.45)");
	footSep.addColorStop(1, "rgba(251,191,36,0)");
	ctx.fillStyle = footSep;
	ctx.fillRect(50, fy + 8, W - 100, 2);

	// Finish banner
	ctx.fillStyle = "rgba(220,38,38,0.88)";
	ctx.shadowColor = "rgba(220,38,38,0.35)";
	ctx.shadowBlur = 16;
	ctx.beginPath();
	ctx.roundRect(W / 2 - 220, fy + 22, 440, 42, 21);
	ctx.fill();
	ctx.shadowBlur = 0;
	ctx.font = "bold 22px GoogleSans, NotoEmoji, sans-serif";
	ctx.fillStyle = "#ffffff";
	ctx.textAlign = "center";
	ctx.fillText(data.finishMessage, W / 2, fy + 50);

	// Score (big)
	ctx.font = "bold 52px GoogleSans, sans-serif";
	const scoreGrad = ctx.createLinearGradient(W / 2 - 80, 0, W / 2 + 80, 0);
	scoreGrad.addColorStop(0, data.winner === "A" ? "#22c55e" : "#ef4444");
	scoreGrad.addColorStop(0.42, "#ffffff");
	scoreGrad.addColorStop(0.58, "#ffffff");
	scoreGrad.addColorStop(1, data.winner === "B" ? "#22c55e" : "#ef4444");
	ctx.fillStyle = scoreGrad;
	ctx.fillText(`${data.score[0]}  —  ${data.score[1]}`, W / 2, fy + 108);

	// Winner name
	const winnerName =
		data.winner === "A" ? data.playerA.name : data.playerB.name;
	ctx.font = "bold 20px GoogleSans, NotoEmoji, sans-serif";
	ctx.fillStyle = "#fbbf24";
	ctx.fillText(`🏆 ${winnerName} remporte le duel !`, W / 2, fy + 134);

	// Reward (right)
	ctx.textAlign = "right";
	ctx.font = "bold 18px GoogleSans, NotoEmoji, sans-serif";
	ctx.fillStyle = "#fbbf24";
	ctx.fillText(`+${data.coinReward} 🪙`, W - 40, fy + 134);

	// Bet info (left)
	if (data.bet > 0) {
		ctx.textAlign = "left";
		ctx.font = "16px GoogleSans, NotoEmoji, sans-serif";
		ctx.fillStyle = "rgba(255,255,255,0.40)";
		ctx.fillText(`🎰 Mise : ${data.bet} 🪙`, 40, fy + 134);
	}

	// Footer brand
	ctx.textAlign = "center";
	ctx.font = "13px GoogleSans, sans-serif";
	ctx.fillStyle = "rgba(255,255,255,0.18)";
	ctx.fillText("rpbey.fr · République Populaire du Beyblade", W / 2, H - 14);

	return canvas.toBuffer("image/png");
}
