import { createCanvas, GlobalFonts, loadImage } from "@aphrody-code/canvas";
import sharp from "sharp";

import { resolveRootPath } from "./paths.js";

const getAssetPath = (relative: string) => resolveRootPath(relative);

// Register fonts
const fontPath = getAssetPath("public/Google_Sans_Flex/static/GoogleSansFlex_72pt-Bold.ttf");
GlobalFonts.registerFromPath(fontPath, "GoogleSans");

// Register emoji font for canvas text rendering
try {
  GlobalFonts.registerFromPath("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "NotoEmoji");
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
async function _loadImageNoWhiteBg(url: string | null): Promise<CanvasImage | null> {
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
async function _loadImageDirect(url: string | null): Promise<CanvasImage | null> {
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
  const glow = ctx.createRadialGradient(160, height / 2, 0, 160, height / 2, 220);
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
  if (avatar) ctx.drawImage(avatar, avatarX - avatarR, avatarY - avatarR, avatarR * 2, avatarR * 2);
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

  drawStat("POINTS", data.rankingPoints.toLocaleString(), gridX, gridY, "#f7d301");
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
  drawStat("TOTAL", data.wins + data.losses, gridX + colW * 2, gridY + rowH, "#f5f0f0");

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
    ctx.fillText(`DECK ACTIF — ${data.activeDeck.name.toUpperCase()}`, 50, deckY);

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
        ctx.drawImage(bladeImg, cx - bladeSize / 2, cy - bladeSize / 2, bladeSize, bladeSize);
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
  const typeAssetName = typeNameMap[data.type.toUpperCase()] ?? data.type.toLowerCase();

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
  if (bladeImg) ctx.drawImage(bladeImg, bladeX - bladeR, bladeY - bladeR, bladeR * 2, bladeR * 2);
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

  const drawPartRow = (label: string, value: string, y: number, partColor: string) => {
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

  const drawStatBar = (label: string, value: number, y: number, color: string) => {
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
  const btmGrad = ctx.createLinearGradient(20, height - 20, width - 20, height - 20);
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
  const [background, arenaOverlay, sparks, flare, winnerAvatar, loserAvatar] = await Promise.all([
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
  const glow = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, 300);
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

function isDeckLegacy(data: DeckCardData | DeckCardDataLegacy): data is DeckCardDataLegacy {
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

export async function generateDeckCard(data: DeckCardData | DeckCardDataLegacy) {
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
    ctx.ellipse(pos.x, pos.y + beySize * 0.35, beySize * 0.4, beySize * 0.12, 0, 0, Math.PI * 2);
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
    while (ctx.measureText(displayCombo).width > colW - 30 && displayCombo.length > 10) {
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
  const height = headerH + podiumH + colHeaderH + tableEntries.length * rowH + footerH;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Parallel avatar load (podium + table) — single pass for cache locality.
  const avatars = await Promise.all(entries.map((e) => safeLoadImage(e.avatarUrl)));
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
    const displayName = entry.name.length > 20 ? `${entry.name.substring(0, 20)}…` : entry.name;
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

    const wrColor = wrVal >= 70 ? "#22c55e" : wrVal >= 50 ? "#e68002" : "#ef4444";
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
  ctx.fillText(`${theme.footerUrl} • Mis à jour en temps réel`, width / 2, footerY + 24);

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

function drawLbChrome(ctx: CanvasCtx, theme: LbVariantTheme, w: number, h: number) {
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
  const order = [byRank.get(2) ?? null, byRank.get(1) ?? null, byRank.get(3) ?? null];

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
      ctx.drawImage(entry.avatar, cx + cardW / 2 - avR, avY - avR, avR * 2, avR * 2);
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
    const displayName = entry.name.length > 14 ? `${entry.name.substring(0, 14)}…` : entry.name;
    ctx.fillText(displayName, cx + cardW / 2, avY + avR + 28);

    // Caption
    ctx.font = _FONT("bold", 10);
    ctx.fillStyle = "#a89999";
    ctx.fillText(`BLADER ${theme.title.split(" ")[0] ?? "RPB"}`, cx + cardW / 2, avY + avR + 46);

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

export async function generateInteractionCard(data: InteractionCardData): Promise<Buffer> {
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
  const nameA = data.userAName.length > 14 ? `${data.userAName.slice(0, 13)}…` : data.userAName;
  const nameB = data.userBName.length > 14 ? `${data.userBName.slice(0, 13)}…` : data.userBName;
  ctx.fillText(nameA, avatarAX, avatarY + avatarRadius + 25);
  ctx.fillText(nameB, avatarBX, avatarY + avatarRadius + 25);

  // ── Label ──
  ctx.font = _FONT("bold", 26);
  const labelGrad = ctx.createLinearGradient(centerX - 100, 0, centerX + 100, 0);
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
  ctx.fillText(`${data.total} mentions mutuelles · rpbey.fr`, centerX, height - 32);
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

const ELEMENT_ICONS: Record<string, { symbol: string; color: string; name: string }> = {
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
function drawLightRays(ctx: CanvasCtx, w: number, h: number, color: string, count = 3) {
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
function drawSeparator(ctx: CanvasCtx, x: number, y: number, w: number, color: string) {
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
function drawHoloSeal(ctx: CanvasCtx, cx: number, cy: number, radius: number, color: string) {
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
  const edgeColors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", genColor];
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

export async function generateGachaCard(data: GachaCardData): Promise<Buffer> {
  const W = 640;
  const H = 900;
  const FRAME = 14;
  const PAD = FRAME + 10;
  const INNER_W = W - PAD * 2;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const baseTheme = RARITY_THEMES[data.rarity] || RARITY_THEMES.COMMON!;
  const theme = data.themeOverride ? { ...baseTheme, ...data.themeOverride } : baseTheme;
  const hasStats = data.att != null;
  const genColor = GEN_COLORS[data.series.toUpperCase()] || theme.accentColor;
  const elem = ELEMENT_ICONS[(data.element || "NEUTRAL").toUpperCase()] || ELEMENT_ICONS.NEUTRAL!;
  const weakness = ELEMENT_WEAKNESS[(data.element || "").toUpperCase()];
  const _weakElem = weakness ? ELEMENT_ICONS[weakness] : null;
  const isSecret = data.rarity === "SECRET";
  const isFullArt = data.fullArt || isSecret;
  const isLegendary = data.rarity === "LEGENDARY";
  const isHighRarity = ["SUPER_RARE", "LEGENDARY", "SECRET"].includes(data.rarity);

  // ══════════════════════════════════════════════════════════════════════════
  // 1. CARD BACKGROUND — Dark warm base (RPB design system)
  // ══════════════════════════════════════════════════════════════════════════
  if (isFullArt) {
    ctx.fillStyle = "#0a0809";
    ctx.fillRect(0, 0, W, H);
  } else {
    // Dark warm gradient background from theme
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, theme.bgGradient[0]);
    bgGrad.addColorStop(0.5, theme.bgGradient[1]);
    bgGrad.addColorStop(1, theme.bgGradient[2]);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Subtle diagonal speed lines (Beyblade feel)
    ctx.save();
    ctx.globalAlpha = 0.02;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    for (let i = -H; i < W + H; i += 18) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + H * 0.5, H);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Element-tinted radial glow (non full-art only)
  if (!isFullArt) {
    const elemGlow = ctx.createRadialGradient(W / 2, 300, 20, W / 2, 300, 320);
    elemGlow.addColorStop(0, `${elem.color}12`);
    elemGlow.addColorStop(1, "transparent");
    ctx.fillStyle = elemGlow;
    ctx.fillRect(0, 0, W, H);

    if (isLegendary) {
      drawLightRays(ctx, W, H, theme.accentColor, 5);
    }

    drawNoise(ctx, W, H, 0.015);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1b. FULL-ART BLEED — character art behind everything (contain-fit)
  // ══════════════════════════════════════════════════════════════════════════
  let charImg = isFullArt
    ? await _loadImageDirect(data.imageUrl || null)
    : await _loadImageNoWhiteBg(data.imageUrl || null);
  if (isFullArt && charImg) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(FRAME, FRAME, W - FRAME * 2, H - FRAME * 2, 24);
    ctx.clip();
    // Fill full card height, center horizontally (no black gap at bottom)
    const aspect = charImg.width / charImg.height;
    const dH = H;
    const dW = H * aspect;
    ctx.drawImage(charImg, (W - dW) / 2, 0, dW, dH);
    // Dark overlay for text readability (stronger at bottom for stats)
    const overlay = ctx.createLinearGradient(0, 0, 0, H);
    overlay.addColorStop(0, "rgba(8,6,10,0.25)");
    overlay.addColorStop(0.4, "rgba(8,6,10,0.08)");
    overlay.addColorStop(0.6, "rgba(8,6,10,0.08)");
    overlay.addColorStop(0.78, "rgba(8,6,10,0.5)");
    overlay.addColorStop(1, "rgba(8,6,10,0.88)");
    ctx.fillStyle = overlay;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. OUTER FRAME — Rounded grey border with wave effect
  // ══════════════════════════════════════════════════════════════════════════
  const CORNER_R = 28;

  // Dark border base with subtle warmth
  ctx.strokeStyle = "#383333";
  ctx.lineWidth = FRAME;
  ctx.beginPath();
  ctx.roundRect(FRAME / 2, FRAME / 2, W - FRAME, H - FRAME, CORNER_R);
  ctx.stroke();

  // Wave texture on border only (clipped to border strip)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, FRAME);
  ctx.rect(0, H - FRAME, W, FRAME);
  ctx.rect(0, 0, FRAME, H);
  ctx.rect(W - FRAME, 0, FRAME, H);
  ctx.clip();
  ctx.globalAlpha = 0.18;
  for (let wave = 0; wave < 6; wave++) {
    const waveY0 = wave * (H / 5);
    ctx.strokeStyle = wave % 2 === 0 ? "#433d3d" : "#2d2929";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 2) {
      const y = waveY0 + Math.sin((x / W) * Math.PI * 4 + wave * 1.2) * 6;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Inner frame line (rounded)
  ctx.strokeStyle = `${theme.frameColor}40`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(FRAME + 4, FRAME + 4, W - FRAME * 2 - 8, H - FRAME * 2 - 8, CORNER_R - 4);
  ctx.stroke();

  // Holographic rainbow foil overlay for SR+ (non full-art only)
  if (isHighRarity && !isFullArt) {
    drawHoloFoil(ctx, 0, 0, W, H, isSecret ? 0.35 : isLegendary ? 0.25 : 0.15);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. NAME HEADER BAR — Beyblade name + Character name + ÉQU
  // ══════════════════════════════════════════════════════════════════════════
  const headerY = FRAME;
  const headerH = 52;

  // Dark header background with gen color tint
  const headerGrad = ctx.createLinearGradient(PAD, headerY, PAD + INNER_W, headerY);
  headerGrad.addColorStop(0, theme.headerBg);
  headerGrad.addColorStop(0.6, `${theme.headerBg}E0`);
  headerGrad.addColorStop(1, `${genColor}90`);
  ctx.fillStyle = headerGrad;
  ctx.beginPath();
  ctx.roundRect(PAD, headerY, INNER_W, headerH, [10, 10, 0, 0]);
  ctx.fill();

  // Beyblade image icon (left of character name)
  let nameX = PAD + 12;
  const beyImg = await _loadImageDirect(data.beybladeImageUrl || null);
  if (beyImg) {
    const iconSize = 42;
    const iconX = PAD + 8;
    const iconY = headerY + (headerH - iconSize) / 2;
    // Circle clip for beyblade icon
    ctx.save();
    ctx.beginPath();
    ctx.arc(iconX + iconSize / 2, iconY + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(beyImg, iconX, iconY, iconSize, iconSize);
    ctx.restore();
    // Thin border around icon
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(iconX + iconSize / 2, iconY + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
    ctx.stroke();
    nameX = iconX + iconSize + 8;
  }

  // Character name
  ctx.textAlign = "left";
  ctx.font = "bold 26px GoogleSans";
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 4;
  let displayName = data.name;
  while (
    ctx.measureText(displayName).width > INNER_W - (nameX - PAD) - 120 &&
    displayName.length > 8
  )
    displayName = `${displayName.slice(0, -2)}...`;
  ctx.fillText(displayName, nameX, headerY + 34);
  ctx.shadowBlur = 0;

  // HP display (right side)
  if (hasStats && data.equilibre != null) {
    ctx.textAlign = "right";
    ctx.font = "bold 13px GoogleSans";
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillText("ÉQU", W - PAD - 68, headerY + 22);
    ctx.font = "bold 28px GoogleSans";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${data.equilibre}`, W - PAD - 12, headerY + 24);
    // Balance icon
    ctx.font = "bold 14px GoogleSans, NotoEmoji";
    ctx.fillStyle = "#22c55e";
    ctx.fillText("\u2696", W - PAD - 12, headerY + 44);
  }

  // Rarity label badge (over header right edge)
  ctx.font = "bold 11px GoogleSans";
  const rarityBadgeW = ctx.measureText(theme.label).width + 20;
  const rbX = W - PAD - rarityBadgeW - 6;
  const rbY = headerY - 4;
  drawBox(ctx, rbX, rbY, rarityBadgeW + 12, 18, 9, theme.borderColor);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.fillText(theme.label, rbX + (rarityBadgeW + 12) / 2, rbY + 13);

  // ══════════════════════════════════════════════════════════════════════════
  // 4. ART WINDOW — Character illustration with inner frame
  //    (Skipped for full-art — image is already drawn as card background)
  // ══════════════════════════════════════════════════════════════════════════
  const artY = headerY + headerH + 4;
  const artH = isFullArt ? H - headerY - headerH - 4 - 200 : 440;
  const artX = PAD + 6;
  const artInnerW = INNER_W - 12;

  if (!isFullArt) {
    // Art background (dark)
    drawBox(ctx, artX, artY, artInnerW, artH, 4, "#0a0a12", `${theme.frameColor}50`, 2);

    // Character image
    if (!charImg) charImg = await _loadImageNoWhiteBg(data.imageUrl || null);
    if (charImg) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(artX + 2, artY + 2, artInnerW - 4, artH - 4, 3);
      ctx.clip();

      // Radial spotlight behind character
      const spot = ctx.createRadialGradient(
        W / 2,
        artY + artH * 0.4,
        10,
        W / 2,
        artY + artH * 0.4,
        artH * 0.65,
      );
      spot.addColorStop(0, `${elem.color}20`);
      spot.addColorStop(1, "transparent");
      ctx.fillStyle = spot;
      ctx.fillRect(artX, artY, artInnerW, artH);

      // Draw image (cover-fit — fills the window, crops overflow)
      const aspect = charImg.width / charImg.height;
      const windowW = artInnerW - 4;
      const windowH = artH - 4;
      let dW: number, dH: number, dX: number, dY: number;
      if (aspect > windowW / windowH) {
        dH = windowH;
        dW = windowH * aspect;
        dX = artX + 2 + (windowW - dW) / 2;
        dY = artY + 2;
      } else {
        dW = windowW;
        dH = windowW / aspect;
        dX = artX + 2;
        dY = artY + 2 - (dH - windowH) * 0.15;
      }
      ctx.drawImage(charImg, dX, dY, dW, dH);

      // Bottom vignette
      const vig = ctx.createLinearGradient(0, artY, 0, artY + artH);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(0.75, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(0,0,0,0.6)");
      ctx.fillStyle = vig;
      ctx.fillRect(artX, artY, artInnerW, artH);
      ctx.restore();
    } else {
      ctx.font = "bold 100px GoogleSans";
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.textAlign = "center";
      ctx.fillText("?", W / 2, artY + artH / 2 + 35);
    }

    // Inner art frame highlight (metallic for high rarity)
    if (isHighRarity) {
      const innerFrameGrad = ctx.createLinearGradient(artX, artY, artX + artInnerW, artY + artH);
      innerFrameGrad.addColorStop(0, `${theme.borderColor}60`);
      innerFrameGrad.addColorStop(0.3, `${theme.borderColor}20`);
      innerFrameGrad.addColorStop(0.7, `${theme.borderColor}20`);
      innerFrameGrad.addColorStop(1, `${theme.borderColor}60`);
      ctx.strokeStyle = innerFrameGrad;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(artX, artY, artInnerW, artH, 4);
      ctx.stroke();
      if (isLegendary || isSecret) {
        drawHoloFoil(ctx, artX, artY, artInnerW, artH, isSecret ? 0.2 : 0.12);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. WHITE TEXT ZONE + TYPE STRIP
  // ══════════════════════════════════════════════════════════════════════════
  // Full-art: flush text to very bottom edge
  const contentH = 26 + 4 + (data.description ? 35 : 0) + 4 + (hasStats ? 30 : 0);
  const typeY = isFullArt ? H - FRAME - contentH : artY + artH + 6;
  const typeH = 26;
  const textZoneTop = typeY - 2;
  const textZoneBottom = H - FRAME - 6;

  // Dark surface background for text area below art
  if (!isFullArt) {
    drawBox(ctx, PAD, textZoneTop, INNER_W, textZoneBottom - textZoneTop, 6, "#1d1b1b");
  }

  const typeGrad = ctx.createLinearGradient(PAD, typeY, PAD + INNER_W, typeY);
  typeGrad.addColorStop(0, `${genColor}30`);
  typeGrad.addColorStop(1, `${theme.borderColor}20`);
  ctx.fillStyle = typeGrad;
  ctx.beginPath();
  ctx.roundRect(PAD + 2, typeY, INNER_W - 4, typeH, 3);
  ctx.fill();

  // Text colors — always light on dark now
  const textDark = isFullArt ? "#e0dcd4" : "#f5f0f0";
  const textMuted = isFullArt ? "#a09888" : "#a89999";
  const textSubtle = isFullArt ? "#807868" : "#64748b";

  ctx.font = "bold 12px GoogleSans";
  ctx.textAlign = "left";
  ctx.fillStyle = genColor;
  ctx.fillText(data.series.replace(/_/g, " "), PAD + 10, typeY + 18);

  if (data.beyblade) {
    ctx.textAlign = "right";
    ctx.fillStyle = textDark;
    ctx.font = "bold 12px GoogleSans";
    let bey = data.beyblade;
    while (ctx.measureText(bey).width > INNER_W * 0.5 && bey.length > 12)
      bey = `${bey.slice(0, -2)}...`;
    ctx.fillText(bey, W - PAD - 10, typeY + 18);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. DESCRIPTION (optional, compact)
  // ══════════════════════════════════════════════════════════════════════════
  const descY = typeY + typeH + 4;
  let descBlockH = 0;
  if (data.description) {
    drawSeparator(ctx, PAD, descY, INNER_W, theme.frameColor);
    ctx.font = "11px GoogleSans";
    ctx.fillStyle = textMuted;
    ctx.textAlign = "left";
    const words = data.description.split(" ");
    let descLine = "";
    let ly = descY + 16;
    let lc = 0;
    for (const word of words) {
      if (lc >= 2) break;
      const test = descLine ? `${descLine} ${word}` : word;
      if (ctx.measureText(test).width > INNER_W - 30) {
        ctx.fillText(descLine, PAD + 12, ly);
        descLine = word;
        ly += 15;
        lc++;
      } else descLine = test;
    }
    if (descLine && lc < 2) ctx.fillText(descLine, PAD + 12, ly);
    descBlockH = 20 + lc * 15;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6b. STATS — Single line: ATT / DEF / END / EQL
  // ══════════════════════════════════════════════════════════════════════════
  const statsStartY = descY + descBlockH + 4;
  if (hasStats) {
    drawSeparator(ctx, PAD, statsStartY, INNER_W, theme.frameColor);
    const sy = statsStartY + 16;
    const stats = [
      { label: "ATT", val: data.att!, color: "#dc2626" },
      { label: "DEF", val: data.def!, color: "#2563eb" },
      { label: "END", val: data.end!, color: "#0891b2" },
      { label: "EQL", val: data.equilibre!, color: "#22c55e" },
    ];
    const colW = INNER_W / stats.length;
    for (let i = 0; i < stats.length; i++) {
      const s = stats[i]!;
      const cx = PAD + colW * i + colW / 2;
      // Label
      ctx.font = "bold 10px GoogleSans";
      ctx.fillStyle = isFullArt ? "rgba(255,255,255,0.6)" : textMuted;
      ctx.textAlign = "center";
      ctx.fillText(s.label, cx, sy - 2);
      // Value
      ctx.font = "bold 16px GoogleSans";
      ctx.fillStyle = s.color;
      ctx.fillText(`${s.val}`, cx, sy + 16);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. FOOTER + STATUS BAR (hidden in full-art — text is already at bottom)
  // ══════════════════════════════════════════════════════════════════════════
  const footerY = H - FRAME - 80;
  const statusY = footerY + 32;
  const statusH = 36;

  if (!isFullArt) {
    drawSeparator(ctx, PAD, footerY, INNER_W, theme.frameColor);

    // Card number (left)
    ctx.textAlign = "left";
    ctx.font = "bold 12px GoogleSans";
    ctx.fillStyle = textSubtle;
    ctx.fillText("#???/032", PAD + 10, footerY + 18);

    if (isHighRarity) {
      drawHoloSeal(ctx, W - PAD - 24, footerY + 48, 13, theme.accentColor);
    }

    drawBox(ctx, PAD, statusY, INNER_W, statusH, [0, 0, 8, 8], "rgba(0,0,0,0.15)");
  }

  if (!isFullArt) {
    if (data.balance > 0) {
      ctx.font = "bold 14px GoogleSans";
      ctx.textAlign = "left";
      ctx.fillStyle = textSubtle;
      ctx.fillText(`${data.balance.toLocaleString("fr-FR")} coins`, PAD + 14, statusY + 23);
    }

    if (data.isWished) {
      const wishBadgeW = 90;
      drawBox(
        ctx,
        W - PAD - wishBadgeW - 8,
        statusY + 6,
        wishBadgeW,
        24,
        12,
        "#fbbf2430",
        "#fbbf24",
        1.5,
      );
      ctx.font = "bold 12px GoogleSans";
      ctx.fillStyle = isSecret ? "#fcd34d" : "#b45309";
      ctx.textAlign = "center";
      ctx.fillText("WISHED", W - PAD - wishBadgeW / 2 - 8, statusY + 22);
    } else if (data.isDuplicate) {
      const dupBadgeW = 90;
      drawBox(
        ctx,
        W - PAD - dupBadgeW - 8,
        statusY + 6,
        dupBadgeW,
        24,
        12,
        "rgba(107,114,128,0.15)",
        "#9ca3af",
        1,
      );
      ctx.font = "bold 12px GoogleSans";
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "center";
      ctx.fillText("DOUBLON", W - PAD - dupBadgeW / 2 - 8, statusY + 22);
    }
  }

  // Illu credit (bottom-right on border)
  ctx.textAlign = "right";
  ctx.font = "11px GoogleSans";
  ctx.fillStyle = "#6b7280";
  ctx.fillText("made by Illu", W - FRAME - 6, H - FRAME / 2 + 4);

  // ══════════════════════════════════════════════════════════════════════════
  // 11. SPARKLES & CORNER ORNAMENTS (high rarity)
  // ══════════════════════════════════════════════════════════════════════════
  if (theme.particleCount > 0 && !isFullArt) {
    for (let i = 0; i < theme.particleCount; i++) {
      const sx = FRAME + 20 + Math.random() * (W - FRAME * 2 - 40);
      const sy = FRAME + 20 + Math.random() * (H - FRAME * 2 - 40);
      drawSparkle(
        ctx,
        sx,
        sy,
        3 + Math.random() * 6,
        theme.accentColor,
        0.25 + Math.random() * 0.45,
      );
    }
  }

  if (isHighRarity && !isFullArt) {
    ctx.strokeStyle = `${theme.borderColor}50`;
    ctx.lineWidth = 2.5;
    const c = 35;
    const ox = FRAME + 6;
    const oy = FRAME + 6;
    const corners: [number, number, number, number][] = [
      [ox, oy + c, ox, oy],
      [ox, oy, ox + c, oy],
      [W - ox - c, oy, W - ox, oy],
      [W - ox, oy, W - ox, oy + c],
      [ox, H - oy - c, ox, H - oy],
      [ox, H - oy, ox + c, H - oy],
      [W - ox - c, H - oy, W - ox, H - oy],
      [W - ox, H - oy, W - ox, H - oy - c],
    ];
    for (const [x1, y1, x2, y2] of corners) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  // Copyright on bottom-left border
  ctx.font = "11px GoogleSans";
  ctx.fillStyle = "#6b7280";
  ctx.textAlign = "left";
  ctx.fillText("\u00A9 RPBey 2026", FRAME + 6, H - FRAME / 2 + 4);

  return canvas.toBuffer("image/png");
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATED GACHA CARD — Beyblade X lightning VFX overlay (GIF)
// ─────────────────────────────────────────────────────────────────────────────

type Pt = { x: number; y: number };
const _rand = (a: number, b: number) => a + Math.random() * (b - a);

function _generateBoltPath(
  sx: number,
  sy: number,
  angle: number,
  segs: number,
  segLen: [number, number],
  deviation: number,
): Pt[][] {
  const paths: Pt[][] = [];
  const trunk: Pt[] = [{ x: sx, y: sy }];
  let cx = sx,
    cy = sy;
  for (let s = 0; s < segs; s++) {
    const len = _rand(segLen[0], segLen[1]);
    const a = angle + _rand(-deviation, deviation);
    cx += Math.cos(a) * len;
    cy += Math.sin(a) * len;
    trunk.push({ x: cx, y: cy });
    if (Math.random() < 0.3 && s < segs - 1) {
      const branch: Pt[] = [{ x: cx, y: cy }];
      let bx = cx,
        by = cy;
      const ba = a + _rand(-1.2, 1.2);
      for (let b = 0; b < 2 + Math.floor(_rand(0, 2)); b++) {
        bx += Math.cos(ba + _rand(-0.5, 0.5)) * _rand(segLen[0] * 0.3, segLen[1] * 0.5);
        by += Math.sin(ba + _rand(-0.5, 0.5)) * _rand(segLen[0] * 0.3, segLen[1] * 0.5);
        branch.push({ x: bx, y: by });
      }
      paths.push(branch);
    }
  }
  paths.unshift(trunk);
  return paths;
}

function _drawBoltTriplePass(
  ctx: CanvasCtx,
  pts: Pt[],
  color: string,
  w: number,
  glow: number,
  alpha: number,
) {
  if (pts.length < 2) return;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0]?.x, pts[0]?.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]?.x, pts[i]?.y);
  };
  // Pass 1: outer glow
  ctx.save();
  ctx.globalAlpha = alpha * 0.3;
  ctx.strokeStyle = color;
  ctx.lineWidth = w * 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = glow * 2;
  trace();
  ctx.stroke();
  ctx.restore();
  // Pass 2: main color
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "bevel";
  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  trace();
  ctx.stroke();
  ctx.restore();
  // Pass 3: white-hot core
  ctx.save();
  ctx.globalAlpha = alpha * 0.75;
  ctx.strokeStyle = "#e0f4ff";
  ctx.lineWidth = Math.max(w * 0.35, 1);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "#ffffff";
  ctx.shadowBlur = glow * 0.4;
  trace();
  ctx.stroke();
  ctx.restore();
}

const BX_BOLT_COLORS = ["#00ccff", "#00e5ff", "#40c4ff", "#00b0ff", "#80d8ff"];

function _drawBXLightning(ctx: CanvasCtx, w: number, h: number) {
  ctx.save();
  // Radial glow source
  const gx = w * 0.72,
    gy = h * 0.06;
  const rad = ctx.createRadialGradient(gx, gy, 0, gx, gy, w * 0.5);
  rad.addColorStop(0, "rgba(0,204,255,0.18)");
  rad.addColorStop(0.3, "rgba(0,204,255,0.06)");
  rad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";

  // Main bolts
  for (let i = 0; i < 5; i++) {
    const sx = w * 0.5 + _rand(0, w * 0.45);
    const sy = _rand(-h * 0.02, h * 0.15);
    const angle = Math.PI * 0.6 + _rand(-0.3, 0.3);
    const paths = _generateBoltPath(sx, sy, angle, 4 + Math.floor(_rand(0, 4)), [50, 140], 0.65);
    const color = BX_BOLT_COLORS[Math.floor(_rand(0, 3))]!;
    const mw = _rand(2.5, 5);
    for (let p = 0; p < paths.length; p++) {
      _drawBoltTriplePass(
        ctx,
        paths[p]!,
        color,
        p === 0 ? mw : mw * 0.45,
        p === 0 ? _rand(16, 28) : _rand(6, 14),
        p === 0 ? _rand(0.75, 1) : _rand(0.35, 0.65),
      );
    }
  }
  // Secondary bolts
  for (let i = 0; i < 8; i++) {
    const sx = w * 0.35 + _rand(0, w * 0.6);
    const sy = _rand(-h * 0.01, h * 0.25);
    const angle = Math.PI * 0.55 + _rand(-0.45, 0.45);
    const paths = _generateBoltPath(sx, sy, angle, 3 + Math.floor(_rand(0, 2)), [25, 80], 0.85);
    const color = BX_BOLT_COLORS[Math.floor(_rand(0, BX_BOLT_COLORS.length))]!;
    for (const pts of paths) {
      _drawBoltTriplePass(ctx, pts, color, _rand(1.2, 2.5), _rand(8, 16), _rand(0.3, 0.6));
    }
  }
  // Spark particles
  for (let i = 0; i < 10; i++) {
    const sx = w * 0.4 + _rand(0, w * 0.55);
    const sy = _rand(0, h * 0.4);
    const size = _rand(1.5, 5);
    ctx.save();
    ctx.globalAlpha = _rand(0.4, 1);
    ctx.fillStyle = "#b3e5fc";
    ctx.shadowColor = "#00ccff";
    ctx.shadowBlur = size * 3;
    ctx.beginPath();
    ctx.moveTo(sx, sy - size);
    ctx.lineTo(sx + size * 0.18, sy - size * 0.18);
    ctx.lineTo(sx + size, sy);
    ctx.lineTo(sx + size * 0.18, sy + size * 0.18);
    ctx.lineTo(sx, sy + size);
    ctx.lineTo(sx - size * 0.18, sy + size * 0.18);
    ctx.lineTo(sx - size, sy);
    ctx.lineTo(sx - size * 0.18, sy - size * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Generate an animated GIF from a static gacha card PNG.
 * Overlays Beyblade X lightning VFX + shimmer + border glow.
 * Returns a GIF buffer (~2-3 MB, 18 frames, 65ms delay).
 */
export async function generateAnimatedGachaCard(staticCardPng: Buffer): Promise<Buffer> {
  const W = 640,
    H = 900;
  const FRAMES = 18,
    DELAY = 65;

  const baseImg = await loadImage(staticCardPng);
  const framePngs: Buffer[] = [];

  for (let i = 0; i < FRAMES; i++) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    const t = i / FRAMES;

    // Base card
    ctx.drawImage(baseImg, 0, 0, W, H);

    // Shimmer sweep
    const sx = t * W * 2.2 - W * 0.6;
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const shimmer = ctx.createLinearGradient(sx - 180, 0, sx + 180, H);
    shimmer.addColorStop(0, "rgba(255,255,255,0)");
    shimmer.addColorStop(0.42, "rgba(255,255,255,0)");
    shimmer.addColorStop(0.48, "rgba(0,200,255,0.10)");
    shimmer.addColorStop(0.5, "rgba(255,255,255,0.20)");
    shimmer.addColorStop(0.52, "rgba(0,200,255,0.10)");
    shimmer.addColorStop(0.58, "rgba(255,255,255,0)");
    shimmer.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = shimmer;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // Pulsing border glow
    const pulse = 0.5 + Math.sin(t * Math.PI * 2) * 0.5;
    ctx.save();
    ctx.shadowColor = `rgba(0,204,255,${0.4 * pulse})`;
    ctx.shadowBlur = 12 + pulse * 18;
    ctx.strokeStyle = `rgba(0,204,255,${0.25 * pulse})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(10, 10, W - 20, H - 20, 22);
    ctx.stroke();
    ctx.restore();

    // Lightning VFX (regenerated each frame = crackling)
    _drawBXLightning(ctx, W, H);

    framePngs.push(Buffer.from(canvas.toBuffer("image/png")));
  }

  // Assemble GIF: stack frames → raw RGBA → sharp with pageHeight
  const composites = framePngs.slice(1).map((buf, i) => ({
    input: buf,
    top: (i + 1) * H,
    left: 0,
  }));
  const tallPng = await sharp(framePngs[0]!)
    .extend({
      bottom: H * (FRAMES - 1),
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .composite(composites)
    .png()
    .toBuffer();
  const rawData = await sharp(tallPng).ensureAlpha().raw().toBuffer();

  return sharp(rawData, {
    raw: {
      width: W,
      height: H * FRAMES,
      channels: 4,
      pageHeight: H,
    },
  })
    .gif({
      delay: Array.from({ length: FRAMES }, () => DELAY),
      loop: 0,
      colours: 180,
      dither: 0.4,
      effort: 8,
    })
    .toBuffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// STAR FRAGMENT — Summoning animation for multi-pulls (Metal Fury style)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a "Star Fragment" summoning animation GIF.
 * Realistic meteor-like fragments falling from space with glowing tails,
 * dust particles, and atmospheric entry glow. No text overlay.
 */
/**
 * Rarity → fragment color theme.
 * LEGENDARY = multicolor rainbow, SUPER_RARE = gold, RARE = violet, COMMON/MISS = white
 */
const FRAGMENT_COLORS: Record<
  string,
  {
    hues: number[];
    saturation: number;
    lightness: number;
    size: [number, number];
    tailLen: [number, number];
    brightness: [number, number];
    rainbow?: boolean;
  }
> = {
  LEGENDARY: {
    hues: [0, 30, 60, 120, 200, 280],
    saturation: 90,
    lightness: 80,
    size: [4, 6],
    tailLen: [100, 160],
    brightness: [0.9, 1],
    rainbow: true,
  },
  SUPER_RARE: {
    hues: [40, 45, 50],
    saturation: 85,
    lightness: 75,
    size: [3, 5],
    tailLen: [80, 130],
    brightness: [0.8, 0.95],
  },
  RARE: {
    hues: [270, 280, 290],
    saturation: 70,
    lightness: 70,
    size: [2.5, 4],
    tailLen: [60, 100],
    brightness: [0.6, 0.8],
  },
  COMMON: {
    hues: [210, 220],
    saturation: 15,
    lightness: 90,
    size: [1.5, 3],
    tailLen: [30, 60],
    brightness: [0.4, 0.65],
  },
};

export async function generateStarFragmentGif(rarities?: (string | null)[]): Promise<Buffer> {
  const W = 640,
    H = 400;
  const FRAMES = 24;
  const r = (a: number, b: number) => a + Math.random() * (b - a);

  // Resolve 10 rarities (fallback to COMMON if not provided)
  const slots = Array.from({ length: 10 }, (_, i) => {
    const raw = rarities?.[i] ?? "COMMON";
    return FRAGMENT_COLORS[raw || "COMMON"] || FRAGMENT_COLORS.COMMON!;
  });

  // Background stars (fixed)
  const STARS = Array.from({ length: 120 }, () => ({
    x: Math.random() * W,
    y: Math.random() * H * 0.85,
    size: 0.3 + Math.random() * 1.8,
    brightness: 0.15 + Math.random() * 0.6,
    twinkle: 1 + Math.random() * 4,
  }));

  // Meteor fragments — colored by rarity
  const FRAGMENTS = slots.map((color) => {
    const startX = r(W * 0.05, W * 0.95);
    const startY = r(-H * 0.5, -H * 0.1);
    return {
      sx: startX,
      sy: startY,
      angle: r(0.55, 0.85) * Math.PI,
      speed: r(0.6, 1.2),
      delay: r(0, 0.3),
      len: r(300, 600),
      size: r(color.size[0], color.size[1]),
      tailLen: r(color.tailLen[0], color.tailLen[1]),
      hues: color.hues,
      saturation: color.saturation,
      lightness: color.lightness,
      brightness: r(color.brightness[0], color.brightness[1]),
      rainbow: color.rainbow ?? false,
    };
  });

  // Dust particles spawned along fragment trails
  const DUST_COUNT = 50;
  const dust = Array.from({ length: DUST_COUNT }, () => ({
    fragIdx: Math.floor(Math.random() * FRAGMENTS.length),
    offset: Math.random(), // position along the trail (0=head, 1=tail)
    drift: { x: r(-2, 2), y: r(-1, 1) },
    size: r(0.5, 2),
    alpha: r(0.2, 0.6),
    decay: r(0.3, 0.8),
  }));

  const framePngs: Buffer[] = [];

  for (let f = 0; f < FRAMES; f++) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    const t = f / FRAMES;

    // 1. Deep space background with subtle nebula
    ctx.fillStyle = "#020208";
    ctx.fillRect(0, 0, W, H);

    // Nebula haze
    const neb1 = ctx.createRadialGradient(W * 0.3, H * 0.2, 0, W * 0.3, H * 0.2, W * 0.5);
    neb1.addColorStop(0, "rgba(20,10,50,0.3)");
    neb1.addColorStop(0.5, "rgba(10,5,30,0.1)");
    neb1.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = neb1;
    ctx.fillRect(0, 0, W, H);

    const neb2 = ctx.createRadialGradient(W * 0.75, H * 0.15, 0, W * 0.75, H * 0.15, W * 0.35);
    neb2.addColorStop(0, "rgba(5,15,40,0.25)");
    neb2.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = neb2;
    ctx.fillRect(0, 0, W, H);

    // 2. Planet horizon (subtle curve)
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(W / 2, H + 220, W * 0.95, 350, 0, Math.PI, 0);
    ctx.closePath();
    const pGrad = ctx.createLinearGradient(0, H * 0.72, 0, H);
    pGrad.addColorStop(0, "#0e1228");
    pGrad.addColorStop(0.5, "#0a0e1e");
    pGrad.addColorStop(1, "#060810");
    ctx.fillStyle = pGrad;
    ctx.fill();
    // Thin atmosphere line
    const atm = ctx.createLinearGradient(0, H * 0.73, 0, H * 0.78);
    atm.addColorStop(0, "rgba(80,130,220,0.12)");
    atm.addColorStop(0.5, "rgba(60,100,180,0.06)");
    atm.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = atm;
    ctx.fillRect(0, H * 0.73, W, H * 0.05);
    ctx.restore();

    // 3. Stars
    for (const s of STARS) {
      const tw = 0.4 + Math.sin(t * Math.PI * 2 * s.twinkle + s.x) * 0.4;
      ctx.save();
      ctx.globalAlpha = s.brightness * tw;
      ctx.fillStyle = "#ddeeff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 4. Meteor fragments
    ctx.save();
    ctx.globalCompositeOperation = "screen";

    for (const frag of FRAGMENTS) {
      const fragT = Math.max(0, (t - frag.delay) / (1 - frag.delay));
      if (fragT <= 0) continue;
      const eased = fragT * fragT * (3 - 2 * fragT); // smoothstep

      const headX = frag.sx + Math.cos(frag.angle) * frag.len * eased * frag.speed;
      const headY = frag.sy + Math.sin(frag.angle) * frag.len * eased * frag.speed;

      // Tail: line from head back along trajectory
      const tailX = headX - Math.cos(frag.angle) * frag.tailLen;
      const tailY = headY - Math.sin(frag.angle) * frag.tailLen;

      // Skip if fully off-screen
      if (headY > H + 50) continue;

      const alpha =
        frag.brightness *
        Math.min(fragT * 3, 1) *
        (headY < H * 0.75 ? 1 : Math.max(0, 1 - (headY - H * 0.75) / (H * 0.3)));

      // Pick hue — rainbow cycles through all hues per frame, others use fixed
      const hue = frag.rainbow
        ? frag.hues[Math.floor((fragT * 8 + f * 0.5) % frag.hues.length)]!
        : frag.hues[Math.floor(r(0, frag.hues.length))]!;
      const sat = frag.saturation;
      const lit = frag.lightness;

      // Outer glow trail (wide, faint)
      const tailGrad = ctx.createLinearGradient(tailX, tailY, headX, headY);
      tailGrad.addColorStop(0, "rgba(0,0,0,0)");
      if (frag.rainbow) {
        // Rainbow gradient along the tail
        const rh = frag.hues;
        for (let ci = 0; ci < rh.length; ci++) {
          const stop = 0.3 + (ci / rh.length) * 0.7;
          tailGrad.addColorStop(stop, `hsla(${rh[ci]},${sat}%,${lit}%,${alpha * 0.2})`);
        }
      } else {
        tailGrad.addColorStop(0.3, `hsla(${hue},${sat}%,${lit}%,${alpha * 0.15})`);
        tailGrad.addColorStop(1, `hsla(${hue},${sat - 10}%,${lit + 10}%,${alpha * 0.4})`);
      }
      ctx.save();
      ctx.strokeStyle = tailGrad;
      ctx.lineWidth = frag.size * 5;
      ctx.lineCap = "round";
      ctx.shadowColor = `hsla(${hue},${sat}%,${lit}%,0.6)`;
      ctx.shadowBlur = frag.rainbow ? 25 : 15;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(headX, headY);
      ctx.stroke();
      ctx.restore();

      // Main colored trail
      const mainGrad = ctx.createLinearGradient(tailX, tailY, headX, headY);
      mainGrad.addColorStop(0, "rgba(0,0,0,0)");
      mainGrad.addColorStop(0.5, `hsla(${hue},${sat - 20}%,${lit + 10}%,${alpha * 0.5})`);
      mainGrad.addColorStop(
        1,
        `hsla(${hue},${sat - 30}%,${Math.min(lit + 20, 95)}%,${alpha * 0.8})`,
      );
      ctx.save();
      ctx.strokeStyle = mainGrad;
      ctx.lineWidth = frag.size * 1.5;
      ctx.lineCap = "round";
      ctx.shadowColor = "#ffffff";
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(headX, headY);
      ctx.stroke();
      ctx.restore();

      // White-hot head point
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = `hsla(${hue},${sat}%,${lit + 5}%,1)`;
      ctx.shadowBlur = frag.size * (frag.rainbow ? 10 : 6);
      ctx.beginPath();
      ctx.arc(headX, headY, frag.size * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Atmospheric entry glow (orange-warm near planet)
      if (headY > H * 0.5) {
        const entryAlpha = alpha * ((headY - H * 0.5) / (H * 0.3)) * 0.4;
        ctx.save();
        ctx.globalAlpha = entryAlpha;
        const entryGrad = ctx.createRadialGradient(headX, headY, 0, headX, headY, frag.size * 8);
        entryGrad.addColorStop(0, "rgba(255,180,80,0.6)");
        entryGrad.addColorStop(0.3, "rgba(255,120,40,0.3)");
        entryGrad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = entryGrad;
        ctx.fillRect(headX - frag.size * 8, headY - frag.size * 8, frag.size * 16, frag.size * 16);
        ctx.restore();
      }
    }

    // 5. Dust particles drifting off fragments
    for (const d of dust) {
      const frag = FRAGMENTS[d.fragIdx]!;
      const fragT = Math.max(0, (t - frag.delay) / (1 - frag.delay));
      if (fragT <= 0) continue;
      const eased = fragT * fragT * (3 - 2 * fragT);

      const headX = frag.sx + Math.cos(frag.angle) * frag.len * eased * frag.speed;
      const headY = frag.sy + Math.sin(frag.angle) * frag.len * eased * frag.speed;
      const px = headX - Math.cos(frag.angle) * frag.tailLen * d.offset + d.drift.x * fragT * 30;
      const py = headY - Math.sin(frag.angle) * frag.tailLen * d.offset + d.drift.y * fragT * 30;

      if (py > H || py < 0 || px < 0 || px > W) continue;

      const dustAlpha = d.alpha * Math.max(0, 1 - fragT * d.decay);
      ctx.save();
      ctx.globalAlpha = dustAlpha;
      const dHue = frag.hues[Math.floor(Math.random() * frag.hues.length)]!;
      ctx.fillStyle = `hsla(${dHue},${frag.saturation * 0.6}%,${frag.lightness + 5}%,1)`;
      ctx.beginPath();
      ctx.arc(px, py, d.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    // 6. Impact flash when fragments hit atmosphere
    if (t > 0.6 && t < 0.85) {
      const flashP = (t - 0.6) / 0.25;
      const flashA = flashP < 0.3 ? (flashP / 0.3) * 0.35 : ((1 - flashP) / 0.7) * 0.35;
      ctx.save();
      ctx.globalAlpha = flashA;
      const impactGrad = ctx.createRadialGradient(W / 2, H * 0.75, 0, W / 2, H * 0.75, W * 0.6);
      impactGrad.addColorStop(0, "rgba(255,255,255,0.8)");
      impactGrad.addColorStop(0.2, "rgba(200,220,255,0.4)");
      impactGrad.addColorStop(0.5, "rgba(100,140,220,0.1)");
      impactGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = impactGrad;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    framePngs.push(Buffer.from(canvas.toBuffer("image/png")));
  }

  // Assemble GIF
  const composites = framePngs.slice(1).map((buf, i) => ({
    input: buf,
    top: (i + 1) * H,
    left: 0,
  }));
  const tallPng = await sharp(framePngs[0]!)
    .extend({
      bottom: H * (FRAMES - 1),
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .composite(composites)
    .png()
    .toBuffer();
  const rawData = await sharp(tallPng).ensureAlpha().raw().toBuffer();

  return sharp(rawData, {
    raw: { width: W, height: H * FRAMES, channels: 4, pageHeight: H },
  })
    .gif({
      delay: [
        ...Array.from({ length: 5 }, () => 80), // space intro
        ...Array.from({ length: 12 }, () => 50), // fragments streaking
        ...Array.from({ length: 4 }, () => 45), // impact
        ...Array.from({ length: 3 }, () => 100), // linger
      ],
      loop: 1,
      colours: 160,
      dither: 0.35,
      effort: 8,
    })
    .toBuffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// MISS CARD — RPB Dark Arena "burst out" card for failed pulls
// ─────────────────────────────────────────────────────────────────────────────

export async function generateGachaMissCard(message: string, balance: number): Promise<Buffer> {
  const W = 640;
  const H = 380;
  const PAD = 24;
  const INNER_W = W - PAD * 2;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // ── Dark warm background ──
  ctx.fillStyle = "#141111";
  ctx.fillRect(0, 0, W, H);

  const background = await safeLoadImage("/canvas.webp");
  if (background) {
    ctx.globalAlpha = 0.1;
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

  // ── Top accent bar (muted RPB — failed) ──
  const topGrad = ctx.createLinearGradient(16, 0, W - 16, 0);
  topGrad.addColorStop(0, "#6b3a3a");
  topGrad.addColorStop(0.5, "#8b4545");
  topGrad.addColorStop(1, "#6b3a3a");
  ctx.fillStyle = topGrad;
  ctx.beginPath();
  ctx.roundRect(16, 16, W - 32, 4, [16, 16, 0, 0]);
  ctx.fill();

  // ── Faded X watermark (cracked card feel) ──
  ctx.save();
  ctx.globalAlpha = 0.04;
  ctx.font = _FONT("bold", 220);
  ctx.fillStyle = "#ef4444";
  ctx.textAlign = "center";
  ctx.fillText("\u2715", W / 2, H / 2 + 60);
  ctx.restore();

  // ── Diagonal crack lines ──
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W * 0.3, 0);
  ctx.lineTo(W * 0.6, H);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(W * 0.7, 0);
  ctx.lineTo(W * 0.4, H);
  ctx.stroke();
  ctx.restore();

  // ── Header ──
  ctx.font = _FONT("bold", 32);
  ctx.fillStyle = "#ef4444";
  ctx.textAlign = "center";
  ctx.shadowColor = "#ef444440";
  ctx.shadowBlur = 15;
  ctx.fillText("BURST OUT !", W / 2, PAD + 40);
  ctx.shadowBlur = 0;

  // Separator
  ctx.fillStyle = "#252222";
  ctx.fillRect(PAD + 20, PAD + 54, INNER_W - 40, 2);

  // ── Message text ──
  ctx.font = _FONT("", 14);
  ctx.fillStyle = "#a89999";
  ctx.textAlign = "center";
  const words = message.split(" ");
  let line = "";
  let y = PAD + 85;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > INNER_W - 60) {
      ctx.fillText(line, W / 2, y);
      line = word;
      y += 22;
    } else line = test;
  }
  if (line) ctx.fillText(line, W / 2, y);

  // ── Flavor text ──
  ctx.font = _FONT("bold", 12);
  ctx.fillStyle = "#6b5555";
  ctx.fillText("-- La toupie a quitté le stadium... --", W / 2, H - PAD - 60);

  // ── Bottom status bar ──
  ctx.fillStyle = "#252222";
  ctx.fillRect(PAD + 20, H - PAD - 48, INNER_W - 40, 2);

  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.beginPath();
  ctx.roundRect(PAD, H - PAD - 40, INNER_W, 28, 8);
  ctx.fill();

  ctx.font = _FONT("bold", 13);
  ctx.textAlign = "left";
  ctx.fillStyle = "#a89999";
  ctx.fillText(`${balance.toLocaleString("fr-FR")} coins restants`, PAD + 14, H - PAD - 22);

  ctx.textAlign = "right";
  ctx.fillStyle = "#a8999960";
  ctx.font = _FONT("bold", 11);
  ctx.fillText("RÉPUBLIQUE POPULAIRE DU BEYBLADE", W - PAD - 14, H - PAD - 22);

  return canvas.toBuffer("image/png");
}

// ─── Multi-Pull Canvas (v4 — RPB Dark Arena) ────────────────────────────────

export interface MultiPullSlot {
  rarity: string | null; // null = miss
  name?: string;
  imageUrl?: string | null;
  isDuplicate?: boolean;
  isWished?: boolean;
}

export interface MultiPullData {
  slots: MultiPullSlot[];
  balance: number;
  hitsCount: number;
  missCount: number;
}

export async function generateMultiPullCard(data: MultiPullData): Promise<Buffer> {
  const COLS = 5;
  const ROWS = 2;
  const CARD_W = 200;
  const CARD_H = 280;
  const GAP = 14;
  const PAD = 32;
  const HEADER = 92;
  const FOOTER = 76;
  const W = PAD * 2 + COLS * CARD_W + (COLS - 1) * GAP;
  const H = HEADER + ROWS * CARD_H + (ROWS - 1) * GAP + FOOTER + PAD;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // ── Load VFX assets ──
  const [arenaOverlay, crackVfx] = await Promise.all([
    safeLoadImage(getAssetPath("bot/assets/backgrounds/arena.png")),
    safeLoadImage(getAssetPath("bot/assets/vfx/crack-circle.png")),
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // BACKGROUND — dark warm arena with energy
  // ══════════════════════════════════════════════════════════════════════════
  ctx.fillStyle = "#111010";
  ctx.fillRect(0, 0, W, H);

  // Arena hex grid overlay
  if (arenaOverlay) {
    ctx.globalAlpha = 0.06;
    ctx.drawImage(arenaOverlay, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // Center energy glow (RPB red→orange→yellow)
  const cGlow = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.5);
  cGlow.addColorStop(0, "rgba(206,12,7,0.08)");
  cGlow.addColorStop(0.3, "rgba(230,128,2,0.04)");
  cGlow.addColorStop(0.6, "rgba(247,211,1,0.02)");
  cGlow.addColorStop(1, "transparent");
  ctx.fillStyle = cGlow;
  ctx.fillRect(0, 0, W, H);

  // Diagonal speed lines
  ctx.save();
  ctx.globalAlpha = 0.018;
  ctx.strokeStyle = "#ce0c07";
  ctx.lineWidth = 1;
  for (let i = -H; i < W + H; i += 28) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + H * 0.5, H);
    ctx.stroke();
  }
  ctx.restore();

  // Crack circle VFX overlay (subtle impact feel behind the grid)
  if (crackVfx) {
    ctx.globalAlpha = 0.035;
    const ccS = Math.min(W, H) * 0.8;
    ctx.drawImage(crackVfx, (W - ccS) / 2, (H - ccS) / 2, ccS, ccS);
    ctx.globalAlpha = 1;
  }

  drawNoise(ctx, W, H, 0.01);

  // ══════════════════════════════════════════════════════════════════════════
  // OUTER FRAME — RPB gradient border
  // ══════════════════════════════════════════════════════════════════════════
  const brdG = ctx.createLinearGradient(0, 0, W, H);
  brdG.addColorStop(0, "rgba(206,12,7,0.35)");
  brdG.addColorStop(0.5, "rgba(230,128,2,0.25)");
  brdG.addColorStop(1, "rgba(247,211,1,0.35)");
  ctx.strokeStyle = brdG;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(6, 6, W - 12, H - 12, 16);
  ctx.stroke();

  // ══════════════════════════════════════════════════════════════════════════
  // HEADER — RPB gradient title + pull count badge
  // ══════════════════════════════════════════════════════════════════════════
  ctx.textAlign = "center";
  ctx.font = _FONT("bold", 34);
  const tGrad = ctx.createLinearGradient(W / 2 - 160, 0, W / 2 + 160, 0);
  tGrad.addColorStop(0, "#ce0c07");
  tGrad.addColorStop(0.5, "#e68002");
  tGrad.addColorStop(1, "#f7d301");
  ctx.fillStyle = tGrad;
  ctx.save();
  ctx.shadowColor = "rgba(230,128,2,0.3)";
  ctx.shadowBlur = 15;
  ctx.fillText("MULTI-PULL", W / 2 - 40, 52);
  ctx.restore();

  // ×10 pill badge
  ctx.font = _FONT("bold", 20);
  const bText = `\u00d7${data.slots.length}`;
  const bW = ctx.measureText(bText).width + 24;
  const bX = W / 2 + 80;
  ctx.fillStyle = "#ce0c07";
  ctx.beginPath();
  ctx.roundRect(bX, 34, bW, 28, 14);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = _FONT("bold", 17);
  ctx.fillText(bText, bX + bW / 2, 53);

  // Subtitle
  ctx.font = _FONT("bold", 13);
  ctx.fillStyle = "#64748b";
  ctx.fillText("RPB TCG \u2022 Drop 1", W / 2, 78);

  // Header separator (RPB gradient)
  const hSep = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
  hSep.addColorStop(0, "rgba(206,12,7,0)");
  hSep.addColorStop(0.15, "rgba(206,12,7,0.4)");
  hSep.addColorStop(0.5, "rgba(230,128,2,0.5)");
  hSep.addColorStop(0.85, "rgba(247,211,1,0.4)");
  hSep.addColorStop(1, "rgba(247,211,1,0)");
  ctx.strokeStyle = hSep;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAD, HEADER - 4);
  ctx.lineTo(W - PAD, HEADER - 4);
  ctx.stroke();

  // ══════════════════════════════════════════════════════════════════════════
  // CARD GRID — 10 mini TCG cards (5×2)
  // ══════════════════════════════════════════════════════════════════════════
  for (let i = 0; i < data.slots.length; i++) {
    const slot = data.slots[i]!;
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = PAD + col * (CARD_W + GAP);
    const y = HEADER + row * (CARD_H + GAP);
    const FR = 4;

    if (!slot.rarity) {
      // ── MISS — dark empty card with ghosted X ──
      drawBox(ctx, x, y, CARD_W, CARD_H, 10, "#1a1818", "#2d292940", 1.5);

      // Faded X watermark
      ctx.save();
      ctx.globalAlpha = 0.04;
      ctx.font = _FONT("bold", 100);
      ctx.fillStyle = "#a89999";
      ctx.textAlign = "center";
      ctx.fillText("\u2715", x + CARD_W / 2, y + CARD_H / 2 + 30);
      ctx.restore();

      // Dark header bar
      drawBox(ctx, x + FR, y + FR, CARD_W - FR * 2, 24, [7, 7, 0, 0], "#252222");
      ctx.font = _FONT("bold", 11);
      ctx.fillStyle = "#433d3d";
      ctx.textAlign = "center";
      ctx.fillText("BURST OUT", x + CARD_W / 2, y + FR + 17);

      // Bottom label
      ctx.font = _FONT("bold", 13);
      ctx.fillStyle = "#383333";
      ctx.fillText("RAT\u00c9", x + CARD_W / 2, y + CARD_H - 16);
    } else {
      // ── Card drop — mini TCG card ──
      const t = RARITY_THEMES[slot.rarity] || RARITY_THEMES.COMMON!;
      const isHigh = ["SUPER_RARE", "LEGENDARY", "SECRET"].includes(slot.rarity);
      const isTop = slot.rarity === "LEGENDARY" || slot.rarity === "SECRET";

      // Card background (dark themed from rarity)
      const cG = ctx.createLinearGradient(x, y, x + CARD_W * 0.3, y + CARD_H);
      cG.addColorStop(0, t.bgGradient[0]);
      cG.addColorStop(0.5, t.bgGradient[1]);
      cG.addColorStop(1, t.bgGradient[2]);
      ctx.fillStyle = cG;
      ctx.beginPath();
      ctx.roundRect(x, y, CARD_W, CARD_H, 10);
      ctx.fill();

      // Rarity border with glow
      ctx.save();
      ctx.shadowColor = t.glowColor;
      ctx.shadowBlur = isTop ? 20 : isHigh ? 10 : 0;
      const rbG = ctx.createLinearGradient(x, y, x + CARD_W, y + CARD_H);
      rbG.addColorStop(0, t.borderGradient[0]);
      rbG.addColorStop(0.5, t.borderGradient[1]);
      rbG.addColorStop(1, t.borderGradient[2]);
      ctx.strokeStyle = rbG;
      ctx.lineWidth = isTop ? 3.5 : FR;
      ctx.beginPath();
      ctx.roundRect(x + FR / 2, y + FR / 2, CARD_W - FR, CARD_H - FR, 9);
      ctx.stroke();
      ctx.restore();

      // Name header bar
      const hH = 28;
      ctx.fillStyle = t.headerBg;
      ctx.beginPath();
      ctx.roundRect(x + FR, y + FR, CARD_W - FR * 2, hH, [7, 7, 0, 0]);
      ctx.fill();

      // Card name (left)
      ctx.font = _FONT("bold", 13);
      ctx.fillStyle = "#f5f0f0";
      ctx.textAlign = "left";
      let nm = slot.name || "???";
      const maxNm = CARD_W - 54;
      if (ctx.measureText(nm).width > maxNm) nm = `${nm.substring(0, 14)}\u2026`;
      ctx.fillText(nm, x + FR + 10, y + FR + 19);

      // Rarity stars (right)
      ctx.textAlign = "right";
      ctx.font = _FONT("bold", 10);
      ctx.fillStyle = t.accentColor;
      ctx.fillText("\u2605".repeat(t.stars), x + CARD_W - FR - 8, y + FR + 19);

      // Art window (dark inner)
      const imgY = y + FR + hH + 4;
      const imgH = 155;
      const imgX = x + FR + 4;
      const imgW = CARD_W - FR * 2 - 8;
      drawBox(ctx, imgX, imgY, imgW, imgH, 4, "#0a0a0c", `${t.frameColor}30`, 1.5);

      // Radial spotlight for high rarity
      if (isHigh) {
        const sp = ctx.createRadialGradient(
          x + CARD_W / 2,
          imgY + imgH * 0.4,
          5,
          x + CARD_W / 2,
          imgY + imgH * 0.4,
          imgH * 0.6,
        );
        sp.addColorStop(0, `${t.borderColor}15`);
        sp.addColorStop(1, "transparent");
        ctx.fillStyle = sp;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(imgX + 1, imgY + 1, imgW - 2, imgH - 2, 3);
        ctx.clip();
        ctx.fillRect(imgX, imgY, imgW, imgH);
        ctx.restore();
      }

      // Character image
      if (slot.imageUrl) {
        const img = await _loadImageNoWhiteBg(slot.imageUrl);
        if (img) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(imgX + 1, imgY + 1, imgW - 2, imgH - 2, 3);
          ctx.clip();
          const asp = img.width / img.height;
          let dw = imgW - 2,
            dh = imgH - 2;
          if (asp > dw / dh) dh = dw / asp;
          else dw = dh * asp;
          ctx.drawImage(
            img,
            imgX + 1 + (imgW - 2 - dw) / 2,
            imgY + 1 + (imgH - 2 - dh) / 2,
            dw,
            dh,
          );
          // Bottom vignette
          const vig = ctx.createLinearGradient(0, imgY, 0, imgY + imgH);
          vig.addColorStop(0, "rgba(0,0,0,0)");
          vig.addColorStop(0.75, "rgba(0,0,0,0)");
          vig.addColorStop(1, "rgba(0,0,0,0.55)");
          ctx.fillStyle = vig;
          ctx.fillRect(imgX, imgY, imgW, imgH);
          ctx.restore();
        }
      }

      // Holo foil for high rarity
      if (isHigh) {
        drawHoloFoil(ctx, imgX, imgY, imgW, imgH, isTop ? 0.18 : 0.1);
      }

      // Inner art frame highlight
      if (isHigh) {
        const ifG = ctx.createLinearGradient(imgX, imgY, imgX + imgW, imgY + imgH);
        ifG.addColorStop(0, `${t.borderColor}50`);
        ifG.addColorStop(0.3, `${t.borderColor}10`);
        ifG.addColorStop(0.7, `${t.borderColor}10`);
        ifG.addColorStop(1, `${t.borderColor}50`);
        ctx.strokeStyle = ifG;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(imgX, imgY, imgW, imgH, 4);
        ctx.stroke();
      }

      // Rarity label below art
      const lbY = imgY + imgH + 8;
      ctx.font = _FONT("bold", 10);
      ctx.fillStyle = t.borderColor;
      ctx.textAlign = "center";
      ctx.fillText(t.label, x + CARD_W / 2, lbY + 4);

      // Status badges (WISHED / DOUBLON)
      const stY = lbY + 16;
      if (slot.isWished) {
        drawBox(ctx, x + CARD_W / 2 - 42, stY, 84, 20, 10, "#f7d30118", "#f7d301", 1);
        ctx.font = _FONT("bold", 10);
        ctx.fillStyle = "#f7d301";
        ctx.textAlign = "center";
        ctx.fillText("\u2764 WISHED", x + CARD_W / 2, stY + 14);
      } else if (slot.isDuplicate) {
        drawBox(ctx, x + CARD_W / 2 - 42, stY, 84, 20, 10, "#64748b12", "#64748b", 1);
        ctx.font = _FONT("bold", 10);
        ctx.fillStyle = "#64748b";
        ctx.textAlign = "center";
        ctx.fillText("DOUBLON", x + CARD_W / 2, stY + 14);
      }

      // Bottom accent line
      const acG = ctx.createLinearGradient(x, 0, x + CARD_W, 0);
      acG.addColorStop(0, `${t.borderColor}00`);
      acG.addColorStop(0.5, t.borderColor);
      acG.addColorStop(1, `${t.borderColor}00`);
      ctx.fillStyle = acG;
      ctx.beginPath();
      ctx.roundRect(x + FR + 6, y + CARD_H - FR - 4, CARD_W - FR * 2 - 12, 2, 1);
      ctx.fill();

      // Sparkles for top rarity
      if (isTop) {
        for (let s = 0; s < 5; s++) {
          drawSparkle(
            ctx,
            x + 14 + Math.random() * (CARD_W - 28),
            y + 35 + Math.random() * (CARD_H - 60),
            2 + Math.random() * 3.5,
            t.accentColor,
            0.25 + Math.random() * 0.4,
          );
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FOOTER — Stats summary + balance
  // ══════════════════════════════════════════════════════════════════════════
  const footY = H - FOOTER - PAD + 8;

  // Footer separator
  const fSep = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
  fSep.addColorStop(0, "rgba(206,12,7,0)");
  fSep.addColorStop(0.3, "rgba(206,12,7,0.3)");
  fSep.addColorStop(0.5, "rgba(230,128,2,0.4)");
  fSep.addColorStop(0.7, "rgba(247,211,1,0.3)");
  fSep.addColorStop(1, "rgba(247,211,1,0)");
  ctx.strokeStyle = fSep;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, footY);
  ctx.lineTo(W - PAD, footY);
  ctx.stroke();

  // Footer surface
  ctx.fillStyle = "#1a1818";
  ctx.beginPath();
  ctx.roundRect(PAD, footY + 4, W - PAD * 2, FOOTER - 8, [0, 0, 10, 10]);
  ctx.fill();

  // Hits count (green pill)
  const hitsLabel = `${data.hitsCount} carte${data.hitsCount > 1 ? "s" : ""}`;
  ctx.font = _FONT("bold", 15);
  const hitsW = ctx.measureText(hitsLabel).width + 24;
  ctx.fillStyle = "#22c55e18";
  ctx.beginPath();
  ctx.roundRect(PAD + 16, footY + 16, hitsW, 28, 14);
  ctx.fill();
  ctx.fillStyle = "#22c55e";
  ctx.textAlign = "left";
  ctx.fillText(hitsLabel, PAD + 28, footY + 35);

  // Miss count (muted pill)
  const missLabel = `${data.missCount} rat\u00e9${data.missCount > 1 ? "s" : ""}`;
  const missX = PAD + 16 + hitsW + 12;
  const missW = ctx.measureText(missLabel).width + 24;
  ctx.fillStyle = "#64748b12";
  ctx.beginPath();
  ctx.roundRect(missX, footY + 16, missW, 28, 14);
  ctx.fill();
  ctx.fillStyle = "#64748b";
  ctx.fillText(missLabel, missX + 12, footY + 35);

  // Best pull indicator
  const bestRarity = data.slots
    .filter((s) => s.rarity)
    .sort((a, b) => {
      const order = ["SECRET", "LEGENDARY", "SUPER_RARE", "RARE", "COMMON"];
      return order.indexOf(a.rarity!) - order.indexOf(b.rarity!);
    })[0];
  if (bestRarity?.rarity) {
    const bt = RARITY_THEMES[bestRarity.rarity];
    if (bt) {
      ctx.font = _FONT("bold", 12);
      ctx.fillStyle = bt.borderColor;
      ctx.textAlign = "center";
      ctx.fillText(`\u2728 Meilleur pull : ${bt.label}`, W / 2, footY + 58);
    }
  }

  // Balance (right side)
  ctx.textAlign = "right";
  ctx.font = _FONT("bold", 14);
  ctx.fillStyle = "#a89999";
  ctx.fillText(`${data.balance.toLocaleString("fr-FR")} coins`, W - PAD - 20, footY + 30);

  // Economy note
  ctx.font = _FONT("", 11);
  ctx.fillStyle = "#64748b40";
  ctx.fillText("\u00c9conomie : 50 coins vs tirages individuels", W - PAD - 20, footY + 50);

  // Bottom branding
  ctx.textAlign = "left";
  ctx.font = _FONT("bold", 11);
  ctx.fillStyle = "#a8999925";
  ctx.fillText("RPB TCG", PAD + 16, footY + 66);

  return canvas.toBuffer("image/png");
}
// ─── Collection Canvas (v2 — HD) ────────────────────────────────────────────

export interface CollectionCardData {
  username: string;
  avatarUrl: string;
  currency: number;
  streak: number;
  cards: Array<{
    name: string;
    rarity: string;
    count: number;
    imageUrl: string | null;
  }>;
  totalCards: number;
  badges: string[];
}

const RARITY_BORDER: Record<string, string> = {
  SECRET: "#ef4444",
  LEGENDARY: "#fbbf24",
  SUPER_RARE: "#8b5cf6",
  RARE: "#3b82f6",
  COMMON: "#6b7280",
};

export async function generateCollectionCard(data: CollectionCardData): Promise<Buffer> {
  const COLS = 5;
  const CELL = 110;
  const CELL_GAP = 12;
  const PAD = 28;
  const HEADER = 180;
  const rows = Math.ceil(data.cards.length / COLS);
  const gridH = rows * (CELL + CELL_GAP);
  const W = PAD * 2 + COLS * (CELL + CELL_GAP);
  const H = HEADER + gridH + 60;
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
  ctx.globalAlpha = 0.02;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  for (let i = -H; i < W + H; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + H * 0.5, H);
    ctx.stroke();
  }
  ctx.restore();

  // ── Main container ──
  ctx.fillStyle = "#1d1b1b";
  ctx.beginPath();
  ctx.roundRect(10, 10, W - 20, H - 20, 16);
  ctx.fill();

  // Inner subtle border
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(10, 10, W - 20, H - 20, 16);
  ctx.stroke();

  // ── Top gradient accent bar (RPB colors) ──
  const topGrad = ctx.createLinearGradient(10, 0, W - 10, 0);
  topGrad.addColorStop(0, "#ce0c07");
  topGrad.addColorStop(0.5, "#e68002");
  topGrad.addColorStop(1, "#f7d301");
  ctx.fillStyle = topGrad;
  ctx.beginPath();
  ctx.roundRect(10, 10, W - 20, 4, [16, 16, 0, 0]);
  ctx.fill();

  // ── Header ──
  const avatar = await safeLoadImage(data.avatarUrl);
  const avX = PAD + 36,
    avY = 42,
    avR = 32;

  // Avatar with RPB conic ring
  ctx.save();
  ctx.shadowColor = "#ce0c0740";
  ctx.shadowBlur = 15;
  ctx.beginPath();
  ctx.arc(avX, avY, avR + 3, 0, Math.PI * 2);
  ctx.strokeStyle = "#ce0c07";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avX, avY, avR - 2, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) ctx.drawImage(avatar, avX - avR + 2, avY - avR + 2, (avR - 2) * 2, (avR - 2) * 2);
  else {
    ctx.fillStyle = "#2d2929";
    ctx.fill();
  }
  ctx.restore();

  const ringG = ctx.createConicGradient(0, avX, avY);
  ringG.addColorStop(0, "#ce0c07");
  ringG.addColorStop(0.33, "#e68002");
  ringG.addColorStop(0.66, "#f7d301");
  ringG.addColorStop(1, "#ce0c07");
  ctx.strokeStyle = ringG;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(avX, avY, avR, 0, Math.PI * 2);
  ctx.stroke();

  // Username
  ctx.font = _FONT("bold", 24);
  ctx.fillStyle = "#f5f0f0";
  ctx.textAlign = "left";
  ctx.fillText(data.username, avX + avR + 16, avY + 8);

  // Stats row
  const pct = data.totalCards > 0 ? Math.round((data.cards.length / data.totalCards) * 100) : 0;
  ctx.font = _FONT("bold", 14);
  const statsY = 95;
  ctx.fillStyle = "#f7d301";
  ctx.fillText(`🪙 ${data.currency.toLocaleString("fr-FR")}`, PAD, statsY);
  ctx.fillStyle = "#e68002";
  ctx.fillText(`🔥 ${data.streak}j`, PAD + 140, statsY);
  ctx.fillStyle = "#f5f0f0";
  ctx.fillText(`🃏 ${data.cards.length}/${data.totalCards} (${pct}%)`, PAD + 230, statsY);

  // Progress bar with RPB gradient
  const barY2 = statsY + 18;
  const barW2 = W - PAD * 2;
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.beginPath();
  ctx.roundRect(PAD, barY2, barW2, 10, 5);
  ctx.fill();
  if (pct > 0) {
    const progGrad = ctx.createLinearGradient(PAD, 0, PAD + (barW2 * pct) / 100, 0);
    progGrad.addColorStop(0, "#ce0c07");
    progGrad.addColorStop(0.5, "#e68002");
    progGrad.addColorStop(1, "#f7d301");
    ctx.fillStyle = progGrad;
    ctx.beginPath();
    ctx.roundRect(PAD, barY2, (barW2 * pct) / 100, 10, 5);
    ctx.fill();
  }

  // Badges
  if (data.badges.length > 0) {
    ctx.font = _FONT("", 13);
    ctx.fillStyle = "#a89999";
    ctx.fillText(data.badges.join("  "), PAD, barY2 + 28);
  }

  // Section title
  ctx.font = _FONT("bold", 14);
  ctx.fillStyle = "#a89999";
  ctx.textAlign = "left";
  ctx.fillText("COLLECTION", PAD, HEADER - 10);
  // Decorative line (RPB gradient)
  const titleLineW = ctx.measureText("COLLECTION").width;
  const tlGrad = ctx.createLinearGradient(PAD + titleLineW + 10, 0, W - PAD, 0);
  tlGrad.addColorStop(0, "rgba(206,12,7,0.25)");
  tlGrad.addColorStop(1, "rgba(247,211,1,0)");
  ctx.strokeStyle = tlGrad;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD + titleLineW + 10, HEADER - 14);
  ctx.lineTo(W - PAD, HEADER - 14);
  ctx.stroke();

  // ── Card grid ──
  for (let i = 0; i < data.cards.length; i++) {
    const card = data.cards[i]!;
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = PAD + col * (CELL + CELL_GAP);
    const y = HEADER + row * (CELL + CELL_GAP);
    const borderColor = RARITY_BORDER[card.rarity] || "#6b7280";

    // Card background (dark surface)
    ctx.fillStyle = "#252222";
    ctx.beginPath();
    ctx.roundRect(x, y, CELL, CELL, 10);
    ctx.fill();

    // Card image
    const img = await _loadImageNoWhiteBg(card.imageUrl);
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x + 3, y + 3, CELL - 6, CELL - 24, 8);
      ctx.clip();
      const imgAspect = img.width / img.height;
      let dw = CELL - 6,
        dh = CELL - 24;
      if (imgAspect > 1) dh = dw / imgAspect;
      else dw = dh * imgAspect;
      ctx.drawImage(img, x + 3 + (CELL - 6 - dw) / 2, y + 3 + (CELL - 24 - dh) / 2, dw, dh);
      // Subtle vignette
      const vg = ctx.createLinearGradient(0, y + 3, 0, y + CELL - 24);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(0.8, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.5)");
      ctx.fillStyle = vg;
      ctx.fillRect(x + 3, y + 3, CELL - 6, CELL - 24);
      ctx.restore();
    }

    // Rarity border with glow for high rarities
    if (card.rarity === "LEGENDARY" || card.rarity === "SECRET" || card.rarity === "SUPER_RARE") {
      ctx.shadowColor = `${borderColor}40`;
      ctx.shadowBlur = 6;
    }
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, CELL, CELL, 10);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Name
    ctx.font = _FONT("bold", 10);
    ctx.fillStyle = "#f5f0f0";
    ctx.textAlign = "center";
    let name = card.name.split(" ")[0] || card.name;
    if (ctx.measureText(name).width > CELL - 8) name = `${name.substring(0, 8)}…`;
    ctx.fillText(name, x + CELL / 2, y + CELL - 5);

    // Count badge
    if (card.count > 1) {
      ctx.fillStyle = borderColor;
      ctx.shadowColor = `${borderColor}60`;
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.arc(x + CELL - 10, y + 10, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.font = _FONT("bold", 10);
      ctx.fillStyle = "#fff";
      ctx.fillText(`x${card.count}`, x + CELL - 10, y + 13);
    }
    ctx.textAlign = "left";
  }

  // ── Footer ──
  ctx.font = _FONT("", 12);
  ctx.fillStyle = "#a8999960";
  ctx.textAlign = "center";
  ctx.fillText("RPB Gacha · /gacha collection", W / 2, H - 28);
  ctx.font = _FONT("bold", 11);
  ctx.fillStyle = "#a8999940";
  ctx.fillText("RÉPUBLIQUE POPULAIRE DU BEYBLADE", W / 2, H - 12);

  return canvas.toBuffer("image/png");
}

// ─── Battle Result Canvas (enhanced) ────────────────────────────────────────

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

const BEY_TYPE_COLORS: Record<string, string> = {
  ATTACK: "#ef4444",
  DEFENSE: "#3b82f6",
  STAMINA: "#22c55e",
  BALANCE: "#a855f7",
};

export async function generateBattleResultCard(data: BattleResultData): Promise<Buffer> {
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
    if (ctx.measureText(text).width > W - 100) text = `${text.substring(0, 80)}…`;
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
  ctx.fillText(`🪙 ${data.winnerName} +${data.coinReward} · ${data.loserName} +5`, W / 2, H - 28);

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

export async function generateGachaDuelCard(data: GachaDuelData): Promise<Buffer> {
  const W = 1080,
    H = 520;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // ── Dark warm background ──
  ctx.fillStyle = "#141111";
  ctx.fillRect(0, 0, W, H);

  const background = await safeLoadImage("/canvas.webp");
  if (background) {
    ctx.globalAlpha = 0.1;
    ctx.drawImage(background, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // ── Center energy glow (RPB red→orange) ──
  const vsGlow = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, 250);
  vsGlow.addColorStop(0, "rgba(206,12,7,0.12)");
  vsGlow.addColorStop(0.5, "rgba(230,128,2,0.04)");
  vsGlow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = vsGlow;
  ctx.fillRect(0, 0, W, H);

  // ── Diagonal speed lines ──
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

  // ── Main container ──
  ctx.fillStyle = "#1d1b1b";
  ctx.beginPath();
  ctx.roundRect(10, 10, W - 20, H - 20, 16);
  ctx.fill();

  // Inner subtle border
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(10, 10, W - 20, H - 20, 16);
  ctx.stroke();

  // ── Top gradient accent bar (RPB colors) ──
  const topGrad = ctx.createLinearGradient(10, 0, W - 10, 0);
  topGrad.addColorStop(0, "#ce0c07");
  topGrad.addColorStop(0.5, "#e68002");
  topGrad.addColorStop(1, "#f7d301");
  ctx.fillStyle = topGrad;
  ctx.beginPath();
  ctx.roundRect(10, 10, W - 20, 4, [16, 16, 0, 0]);
  ctx.fill();

  const drawSide = async (
    card: typeof data.cardA,
    player: string,
    x: number,
    isWinner: boolean,
    score: number,
  ) => {
    const t = RARITY_THEMES[card.rarity] || RARITY_THEMES.COMMON!;
    const cW = 400,
      cH = 430,
      cy = 36;

    // Card background (dark surface)
    ctx.fillStyle = "#252222";
    ctx.beginPath();
    ctx.roundRect(x, cy, cW, cH, 14);
    ctx.fill();

    // Border with glow
    if (isWinner) {
      ctx.shadowColor = "#ce0c0760";
      ctx.shadowBlur = 25;
    }
    const cbGrad = ctx.createLinearGradient(x, cy, x + cW, cy + cH);
    cbGrad.addColorStop(0, "#ce0c07");
    cbGrad.addColorStop(0.5, "#e68002");
    cbGrad.addColorStop(1, "#f7d301");
    ctx.strokeStyle = isWinner ? cbGrad : "rgba(255,255,255,0.06)";
    ctx.lineWidth = isWinner ? 3 : 1;
    ctx.beginPath();
    ctx.roundRect(x, cy, cW, cH, 14);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Crown
    if (isWinner) {
      ctx.font = _FONT("", 28);
      ctx.textAlign = "center";
      ctx.fillText("👑", x + cW / 2, cy - 4);
    }

    // Rarity band
    ctx.fillStyle = `${t.borderColor}CC`;
    ctx.beginPath();
    ctx.roundRect(x + 5, cy + 5, cW - 10, 26, [11, 11, 0, 0]);
    ctx.fill();
    ctx.font = _FONT("bold", 12);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(
      `${t.label} · ${"★".repeat(t.stars)}${"☆".repeat(5 - t.stars)}`,
      x + cW / 2,
      cy + 22,
    );

    // Image
    const imgY = cy + 36,
      imgH = 190;
    ctx.fillStyle = "#1d1b1b";
    ctx.beginPath();
    ctx.roundRect(x + 10, imgY, cW - 20, imgH, 10);
    ctx.fill();
    const img = await _loadImageNoWhiteBg(card.imageUrl);
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x + 10, imgY, cW - 20, imgH, 10);
      ctx.clip();
      const a = img.width / img.height;
      let dw = cW - 20,
        dh = imgH;
      if (a > dw / dh) dh = dw / a;
      else dw = dh * a;
      ctx.drawImage(img, x + 10 + (cW - 20 - dw) / 2, imgY + (imgH - dh) / 2, dw, dh);
      // Vignette
      const vig = ctx.createLinearGradient(0, imgY, 0, imgY + imgH);
      vig.addColorStop(0, "rgba(0,0,0,0.1)");
      vig.addColorStop(0.6, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(0,0,0,0.65)");
      ctx.fillStyle = vig;
      ctx.fillRect(x + 10, imgY, cW - 20, imgH);
      ctx.restore();
    }
    if (!isWinner) {
      ctx.fillStyle = "rgba(20,17,17,0.5)";
      ctx.beginPath();
      ctx.roundRect(x + 10, imgY, cW - 20, imgH, 10);
      ctx.fill();
      ctx.font = _FONT("bold", 42);
      ctx.fillStyle = "rgba(206,12,7,0.3)";
      ctx.textAlign = "center";
      ctx.fillText("✕", x + cW / 2, imgY + imgH / 2 + 16);
    }

    // Name + player
    ctx.font = _FONT("bold", 20);
    ctx.fillStyle = isWinner ? "#f5f0f0" : "#6b5555";
    ctx.textAlign = "center";
    let nm = card.name;
    if (ctx.measureText(nm).width > cW - 30) nm = `${nm.substring(0, 20)}…`;
    ctx.fillText(nm, x + cW / 2, imgY + imgH + 28);
    ctx.font = _FONT("", 13);
    ctx.fillStyle = "#a89999";
    ctx.fillText(player, x + cW / 2, imgY + imgH + 48);

    // Beyblade box
    const beyY = imgY + imgH + 58;
    ctx.fillStyle = "#1d1b1b";
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x + 14, beyY, cW - 28, 30, 8);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(x + 14, beyY, cW - 28, 30, 8);
    ctx.stroke();
    ctx.font = _FONT("bold", 12);
    ctx.fillStyle = "#e68002";
    ctx.textAlign = "left";
    let bey = card.beyblade;
    if (ctx.measureText(`🌀 ${bey}`).width > cW - 50) bey = `${bey.substring(0, 24)}…`;
    ctx.fillText(`🌀 ${bey}`, x + 24, beyY + 20);

    // Power bar
    const barY3 = beyY + 40;
    const barW3 = cW - 28;
    const pct = Math.min(score / 100, 1);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.beginPath();
    ctx.roundRect(x + 14, barY3, barW3, 10, 5);
    ctx.fill();
    const pwrColor = isWinner ? "#22c55e" : "#ef4444";
    const pwrGrad = ctx.createLinearGradient(x + 14, 0, x + 14 + barW3 * pct, 0);
    pwrGrad.addColorStop(0, pwrColor);
    pwrGrad.addColorStop(1, `${pwrColor}80`);
    ctx.fillStyle = pwrGrad;
    ctx.beginPath();
    ctx.roundRect(x + 14, barY3, barW3 * pct, 10, 5);
    ctx.fill();
    ctx.font = _FONT("bold", 11);
    ctx.fillStyle = "#a89999";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(score)} PWR`, x + cW / 2, barY3 + 24);

    // Sparkles for winner
    if (isWinner && (card.rarity === "LEGENDARY" || card.rarity === "SECRET")) {
      for (let s = 0; s < 6; s++) {
        drawSparkle(
          ctx,
          x + 15 + Math.random() * (cW - 30),
          cy + 20 + Math.random() * (cH - 40),
          3 + Math.random() * 4,
          t.accentColor,
          0.25 + Math.random() * 0.3,
        );
      }
    }
  };

  await drawSide(data.cardA, data.playerA, 28, data.winner === "A", data.scoreA);
  await drawSide(data.cardB, data.playerB, W - 428, data.winner === "B", data.scoreB);

  // ── Center VS ──
  const vsCircleGrad = ctx.createRadialGradient(W / 2, H / 2 - 10, 5, W / 2, H / 2 - 10, 50);
  vsCircleGrad.addColorStop(0, "rgba(206,12,7,0.15)");
  vsCircleGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = vsCircleGrad;
  ctx.fillRect(W / 2 - 50, H / 2 - 60, 100, 100);

  ctx.font = _FONT("bold", 56);
  ctx.fillStyle = "rgba(206,12,7,0.08)";
  ctx.textAlign = "center";
  ctx.fillText("VS", W / 2, H / 2 - 10);

  // Finish banner (RPB gradient pill)
  const finishGrad = ctx.createLinearGradient(W / 2 - 140, 0, W / 2 + 140, 0);
  finishGrad.addColorStop(0, "#ce0c07");
  finishGrad.addColorStop(1, "#e68002");
  ctx.fillStyle = finishGrad;
  ctx.shadowColor = "#ce0c0740";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.roundRect(W / 2 - 140, H / 2 + 5, 280, 36, 18);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.font = _FONT("bold", 15);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(data.finishMessage, W / 2, H / 2 + 28);

  ctx.font = _FONT("bold", 13);
  ctx.fillStyle = "#f7d301";
  ctx.fillText(`🪙 +${data.coinReward} au gagnant`, W / 2, H / 2 + 56);

  return canvas.toBuffer("image/png");
}

// ═══════════════════════════════════════════════════════════════════════════════
// GACHA LEADERBOARD CARD
// ═══════════════════════════════════════════════════════════════════════════════

export interface GachaLeaderboardEntry {
  rank: number;
  name: string;
  avatarUrl: string | null;
  uniqueCards: number;
  totalCards: number;
  percentage: number;
  isCallerRow?: boolean;
}

export interface GachaRichEntry {
  rank: number;
  name: string;
  avatarUrl: string | null;
  currency: number;
  isCallerRow?: boolean;
}

export interface GachaLeaderboardData {
  collectors: GachaLeaderboardEntry[];
  richest: GachaRichEntry[];
  callerName: string;
  callerRank: number;
  totalAvailableCards: number;
}

export async function generateGachaLeaderboardCard(data: GachaLeaderboardData): Promise<Buffer> {
  const W = 900;
  const ROW_H = 72;
  const HEADER_H = 140;
  const SECTION_GAP = 50;
  const collectorRows = data.collectors.length;
  const richRows = data.richest.length;
  const H = HEADER_H + collectorRows * ROW_H + SECTION_GAP + 40 + richRows * ROW_H + 80;
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
  ctx.globalAlpha = 0.02;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  for (let i = -H; i < W + H; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + H * 0.5, H);
    ctx.stroke();
  }
  ctx.restore();

  // ── Main container ──
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

  // ── Decorative side lines (RPB warm) ──
  ctx.strokeStyle = "rgba(206,12,7,0.06)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(30, 120);
  ctx.lineTo(30, H - 50);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(W - 30, 120);
  ctx.lineTo(W - 30, H - 50);
  ctx.stroke();

  // ── Header ──
  ctx.font = _FONT("bold", 42);
  const titleGrad = ctx.createLinearGradient(W / 2 - 200, 0, W / 2 + 200, 0);
  titleGrad.addColorStop(0, "#ce0c07");
  titleGrad.addColorStop(0.5, "#e68002");
  titleGrad.addColorStop(1, "#f7d301");
  ctx.fillStyle = titleGrad;
  ctx.textAlign = "center";
  ctx.shadowColor = "#ce0c0740";
  ctx.shadowBlur = 15;
  ctx.fillText("CLASSEMENT GACHA", W / 2, 55);
  ctx.shadowBlur = 0;

  ctx.font = _FONT("bold", 16);
  ctx.fillStyle = "#a89999";
  ctx.fillText(`${data.totalAvailableCards} cartes disponibles · rpbey.fr`, W / 2, 82);

  // Divider (RPB gradient)
  const divGrad = ctx.createLinearGradient(60, 0, W - 60, 0);
  divGrad.addColorStop(0, "transparent");
  divGrad.addColorStop(0.3, "rgba(206,12,7,0.3)");
  divGrad.addColorStop(0.5, "rgba(230,128,2,0.4)");
  divGrad.addColorStop(0.7, "rgba(247,211,1,0.3)");
  divGrad.addColorStop(1, "transparent");
  ctx.strokeStyle = divGrad;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(60, 100);
  ctx.lineTo(W - 60, 100);
  ctx.stroke();

  // Section: Top Collectors
  let y = HEADER_H;
  ctx.textAlign = "left";
  ctx.font = _FONT("bold", 22);
  ctx.fillStyle = "#e68002";
  ctx.fillRect(50, y - 22, 10, 14);
  ctx.fillText("  TOP COLLECTIONNEURS", 62, y - 10);

  const medalColors = ["#f7d301", "#e2e8f0", "#cd7f32"];

  const collectorAvatars = await Promise.all(
    data.collectors.map((c) => safeLoadImage(c.avatarUrl)),
  );

  for (let i = 0; i < data.collectors.length; i++) {
    const entry = data.collectors[i]!;
    const avatar = collectorAvatars[i] ?? null;
    const ry = y + i * ROW_H;

    // Row bg
    if (entry.isCallerRow) {
      ctx.fillStyle = "rgba(206,12,7,0.06)";
      ctx.beginPath();
      ctx.roundRect(40, ry - 2, W - 80, ROW_H - 6, 8);
      ctx.fill();
      ctx.strokeStyle = "rgba(206,12,7,0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(40, ry - 2, W - 80, ROW_H - 6, 8);
      ctx.stroke();
    } else if (i % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.015)";
      ctx.beginPath();
      ctx.roundRect(40, ry - 2, W - 80, ROW_H - 6, 8);
      ctx.fill();
    }

    // Rank
    const rankColor = medalColors[i] || "#64748b";
    ctx.fillStyle = rankColor;
    ctx.beginPath();
    ctx.arc(80, ry + 30, 20, 0, Math.PI * 2);
    ctx.fill();
    if (i < 3) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(80, ry + 30, 20, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = _FONT("bold", 18);
    ctx.fillStyle = i < 3 ? "#000" : "#fff";
    ctx.textAlign = "center";
    ctx.fillText(`${entry.rank}`, 80, ry + 37);

    // Avatar
    drawCircularAvatar(ctx, avatar, 138, ry + 30, 22, i < 3 ? rankColor : "rgba(255,255,255,0.1)");

    // Name
    ctx.textAlign = "left";
    ctx.font = _FONT("bold", 20);
    ctx.fillStyle = entry.isCallerRow ? "#f7d301" : "#f5f0f0";
    let eName = entry.name;
    while (ctx.measureText(eName).width > 260 && eName.length > 8) eName = `${eName.slice(0, -2)}…`;
    ctx.fillText(eName, 175, ry + 28);

    // Progress bar (RPB gradient)
    const barX = 175;
    const barY2 = ry + 40;
    const barW = 300;
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.beginPath();
    ctx.roundRect(barX, barY2, barW, 8, 4);
    ctx.fill();
    const fillW = (entry.percentage / 100) * barW;
    const bGrad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);
    bGrad.addColorStop(0, "#ce0c07");
    bGrad.addColorStop(1, "#e68002");
    ctx.fillStyle = bGrad;
    ctx.beginPath();
    ctx.roundRect(barX, barY2, Math.max(fillW, 1), 8, 4);
    ctx.fill();

    // Stats
    ctx.textAlign = "right";
    ctx.font = _FONT("bold", 22);
    ctx.fillStyle = "#e68002";
    ctx.fillText(`${entry.uniqueCards}/${entry.totalCards}`, W - 140, ry + 30);
    ctx.font = _FONT("bold", 18);
    ctx.fillStyle = entry.percentage >= 80 ? "#f7d301" : "#a89999";
    ctx.fillText(`${entry.percentage}%`, W - 60, ry + 30);
  }

  // Section: Top Richest
  y = HEADER_H + collectorRows * ROW_H + SECTION_GAP;
  ctx.textAlign = "left";
  ctx.font = _FONT("bold", 22);
  ctx.fillStyle = "#f7d301";
  // Gold coin icon
  ctx.beginPath();
  ctx.arc(62, y - 15, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = _FONT("bold", 10);
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.fillText("$", 62, y - 12);
  ctx.font = _FONT("bold", 22);
  ctx.fillStyle = "#f7d301";
  ctx.textAlign = "left";
  ctx.fillText("TOP FORTUNES", 78, y - 10);

  const richAvatars = await Promise.all(data.richest.map((r) => safeLoadImage(r.avatarUrl)));

  for (let i = 0; i < data.richest.length; i++) {
    const entry = data.richest[i]!;
    const avatar = richAvatars[i] ?? null;
    const ry = y + i * ROW_H;

    if (entry.isCallerRow) {
      ctx.fillStyle = "rgba(206,12,7,0.06)";
      ctx.beginPath();
      ctx.roundRect(40, ry - 2, W - 80, ROW_H - 6, 8);
      ctx.fill();
    } else if (i % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.015)";
      ctx.beginPath();
      ctx.roundRect(40, ry - 2, W - 80, ROW_H - 6, 8);
      ctx.fill();
    }

    if (i < 3) {
      ctx.fillStyle = medalColors[i]!;
      ctx.beginPath();
      ctx.arc(80, ry + 30, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(80, ry + 30, 20, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = _FONT("bold", 18);
      ctx.fillStyle = "#000";
      ctx.textAlign = "center";
      ctx.fillText(`${entry.rank}`, 80, ry + 37);
    } else {
      ctx.fillStyle = "#64748b";
      ctx.beginPath();
      ctx.arc(80, ry + 30, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = _FONT("bold", 16);
      ctx.fillStyle = "#000";
      ctx.textAlign = "center";
      ctx.fillText(`${entry.rank}`, 80, ry + 36);
    }

    drawCircularAvatar(
      ctx,
      avatar,
      138,
      ry + 30,
      22,
      i < 3 ? medalColors[i]! : "rgba(255,255,255,0.1)",
    );

    ctx.textAlign = "left";
    ctx.font = _FONT("bold", 20);
    ctx.fillStyle = entry.isCallerRow ? "#f7d301" : "#f5f0f0";
    let rName = entry.name;
    while (ctx.measureText(rName).width > 350 && rName.length > 8) rName = `${rName.slice(0, -2)}…`;
    ctx.fillText(rName, 175, ry + 35);

    ctx.textAlign = "right";
    ctx.font = _FONT("bold", 26);
    ctx.fillStyle = "#f7d301";
    ctx.shadowColor = "rgba(247,211,1,0.2)";
    ctx.shadowBlur = 8;
    ctx.fillText(`${entry.currency.toLocaleString("fr-FR")} coins`, W - 60, ry + 38);
    ctx.shadowBlur = 0;
  }

  // Footer
  ctx.textAlign = "center";
  if (data.callerRank > 0) {
    ctx.font = _FONT("bold", 16);
    ctx.fillStyle = "#a89999";
    ctx.fillText(`${data.callerName} — #${data.callerRank} au classement`, W / 2, H - 45);
  } else {
    ctx.font = _FONT("", 14);
    ctx.fillStyle = "#a8999980";
    ctx.fillText("Commence ta collection avec /gacha gacha !", W / 2, H - 45);
  }

  ctx.font = _FONT("bold", 11);
  ctx.fillStyle = "#a8999940";
  ctx.fillText("RÉPUBLIQUE POPULAIRE DU BEYBLADE", W / 2, H - 25);

  return canvas.toBuffer("image/png");
}

// ═══════════════════════════════════════════════════════════════════════════════
// ECONOMY PROFILE CARD
// ═══════════════════════════════════════════════════════════════════════════════

export interface EconomyProfileData {
  name: string;
  avatarUrl: string;
  currency: number;
  streak: number;
  uniqueCards: number;
  totalCards: number;
  totalCopies: number;
  wishlistCount: number;
  dupeCount: number;
  totalSpent: number;
  badge: string;
  nextBadge: string | null;
  rarityBreakdown: { rarity: string; count: number; emoji: string }[];
}

const RARITY_BAR_COLORS: Record<string, string> = {
  SECRET: "#ef4444",
  LEGENDARY: "#f59e0b",
  SUPER_RARE: "#8b5cf6",
  RARE: "#3b82f6",
  COMMON: "#6b7280",
};

export async function generateEconomyProfileCard(data: EconomyProfileData): Promise<Buffer> {
  const W = 700;
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

  // ── Main container ──
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

  // ── Avatar + Name header ──
  const avatar = await safeLoadImage(data.avatarUrl);

  // Avatar with RPB conic ring
  ctx.save();
  ctx.shadowColor = "#ce0c0740";
  ctx.shadowBlur = 15;
  ctx.beginPath();
  ctx.arc(60, 55, 33, 0, Math.PI * 2);
  ctx.strokeStyle = "#ce0c07";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  drawCircularAvatar(ctx, avatar, 60, 55, 30, "#ce0c07");

  const ringG = ctx.createConicGradient(0, 60, 55);
  ringG.addColorStop(0, "#ce0c07");
  ringG.addColorStop(0.33, "#e68002");
  ringG.addColorStop(0.66, "#f7d301");
  ringG.addColorStop(1, "#ce0c07");
  ctx.strokeStyle = ringG;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(60, 55, 30, 0, Math.PI * 2);
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.font = _FONT("bold", 28);
  ctx.fillStyle = "#f5f0f0";
  ctx.fillText(data.name, 105, 50);

  ctx.font = _FONT("bold", 14);
  ctx.fillStyle = data.badge ? "#f7d301" : "#a89999";
  ctx.fillText(data.badge || "Aucun badge", 105, 72);

  // ── Currency + Streak + Wishlist boxes ──
  const statsY = 105;
  const statBoxW = (W - 80) / 3;
  const statBoxes = [
    {
      label: "PIECES",
      value: data.currency.toLocaleString("fr-FR"),
      sym: "$",
      color: "#f7d301",
    },
    {
      label: "STREAK",
      value: `${data.streak} jour${data.streak !== 1 ? "s" : ""}`,
      sym: "x",
      color: "#ce0c07",
    },
    {
      label: "WISHLIST",
      value: `${data.wishlistCount}`,
      sym: "*",
      color: "#e68002",
    },
  ];

  for (let i = 0; i < statBoxes.length; i++) {
    const sb = statBoxes[i]!;
    const sx = 30 + i * (statBoxW + 10);
    ctx.fillStyle = "#252222";
    ctx.beginPath();
    ctx.roundRect(sx, statsY, statBoxW, 60, 10);
    ctx.fill();
    ctx.strokeStyle = `${sb.color}20`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(sx, statsY, statBoxW, 60, 10);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.font = _FONT("bold", 22);
    ctx.fillStyle = sb.color;
    ctx.shadowColor = `${sb.color}40`;
    ctx.shadowBlur = 6;
    // Draw colored circle indicator
    const iconX = sx + statBoxW / 2 - ctx.measureText(sb.value).width / 2 - 14;
    ctx.beginPath();
    ctx.arc(iconX, statsY + 25, 6, 0, Math.PI * 2);
    ctx.fillStyle = sb.color;
    ctx.fill();
    ctx.font = _FONT("bold", 8);
    ctx.fillStyle = "#000";
    ctx.fillText(sb.sym, iconX, statsY + 28);
    ctx.font = _FONT("bold", 22);
    ctx.fillStyle = sb.color;
    ctx.fillText(sb.value, sx + statBoxW / 2 + 4, statsY + 30);
    ctx.shadowBlur = 0;
    ctx.font = _FONT("bold", 10);
    ctx.fillStyle = "#a89999";
    ctx.fillText(sb.label, sx + statBoxW / 2, statsY + 50);
  }

  // ── Collection progress ──
  const collY = 190;
  ctx.textAlign = "left";
  ctx.font = _FONT("bold", 16);
  ctx.fillStyle = "#a89999";
  ctx.fillText("COLLECTION", 30, collY);
  const pct = data.totalCards > 0 ? Math.round((data.uniqueCards / data.totalCards) * 100) : 0;
  ctx.textAlign = "right";
  ctx.font = _FONT("bold", 16);
  ctx.fillStyle = pct >= 80 ? "#f7d301" : pct >= 50 ? "#22c55e" : "#a89999";
  ctx.fillText(`${data.uniqueCards} / ${data.totalCards} (${pct}%)`, W - 30, collY);

  const barY = collY + 12;
  const barW = W - 60;
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.beginPath();
  ctx.roundRect(30, barY, barW, 14, 7);
  ctx.fill();
  if (pct > 0) {
    const fillW = (pct / 100) * barW;
    const pGrad = ctx.createLinearGradient(30, 0, 30 + fillW, 0);
    pGrad.addColorStop(0, "#ce0c07");
    pGrad.addColorStop(0.5, "#e68002");
    pGrad.addColorStop(1, "#f7d301");
    ctx.fillStyle = pGrad;
    ctx.beginPath();
    ctx.roundRect(30, barY, fillW, 14, 7);
    ctx.fill();
  }

  // ── Rarity breakdown — stacked bar ──
  const rarY = collY + 45;
  ctx.font = _FONT("bold", 14);
  ctx.fillStyle = "#a89999";
  ctx.textAlign = "left";
  ctx.fillText("RÉPARTITION PAR RARETÉ", 30, rarY);

  const rarBarY = rarY + 14;
  const rarBarW = W - 60;
  const rarBarH = 22;
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.beginPath();
  ctx.roundRect(30, rarBarY, rarBarW, rarBarH, 6);
  ctx.fill();

  let rx = 30;
  const total = data.rarityBreakdown.reduce((s, r) => s + r.count, 0) || 1;
  for (const r of data.rarityBreakdown) {
    const rw = (r.count / total) * rarBarW;
    if (rw < 1) continue;
    ctx.fillStyle = RARITY_BAR_COLORS[r.rarity] || "#666";
    ctx.fillRect(rx, rarBarY, rw, rarBarH);
    rx += rw;
  }

  // Legend
  const legY = rarBarY + rarBarH + 14;
  let lx = 30;
  for (const r of data.rarityBreakdown) {
    if (r.count === 0) continue;
    const color = RARITY_BAR_COLORS[r.rarity] || "#666";
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx + 5, legY, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = _FONT("bold", 12);
    ctx.fillStyle = "#f5f0f0cc";
    ctx.textAlign = "left";
    const label = `${r.count}`;
    ctx.fillText(label, lx + 14, legY + 4);
    lx += ctx.measureText(label).width + 30;
  }

  // ── Stats grid ──
  const gridY = legY + 30;
  const gW = (W - 80) / 2;
  const gH = 50;
  const gridItems = [
    {
      label: "Total copies",
      value: data.totalCopies.toLocaleString("fr-FR"),
      color: "#a89999",
    },
    { label: "Doublons", value: `${data.dupeCount}`, color: "#e68002" },
    {
      label: "Total dépensé",
      value: `${Math.abs(data.totalSpent).toLocaleString("fr-FR")} coins`,
      color: "#ef4444",
    },
    {
      label: "Prochain badge",
      value: data.nextBadge || "MAX ✓",
      color: "#22c55e",
    },
  ];

  for (let i = 0; i < gridItems.length; i++) {
    const item = gridItems[i]!;
    const col = i % 2;
    const row = Math.floor(i / 2);
    const gx = 30 + col * (gW + 20);
    const gy = gridY + row * (gH + 8);
    ctx.fillStyle = "#252222";
    ctx.beginPath();
    ctx.roundRect(gx, gy, gW, gH, 8);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.font = _FONT("", 12);
    ctx.fillStyle = "#a89999";
    ctx.fillText(item.label.toUpperCase(), gx + 12, gy + 18);
    ctx.font = _FONT("bold", 18);
    ctx.fillStyle = item.color;
    let val = item.value;
    while (ctx.measureText(val).width > gW - 24 && val.length > 5) val = `${val.slice(0, -2)}…`;
    ctx.fillText(val, gx + 12, gy + 38);
  }

  // ── Footer ──
  ctx.textAlign = "center";
  ctx.font = _FONT("", 12);
  ctx.fillStyle = "#a8999960";
  ctx.fillText("Profil Économie · rpbey.fr", W / 2, H - 32);
  ctx.font = _FONT("bold", 11);
  ctx.fillStyle = "#a8999940";
  ctx.fillText("RÉPUBLIQUE POPULAIRE DU BEYBLADE", W / 2, H - 16);

  return canvas.toBuffer("image/png");
}

// ═══════════════════════════════════════════════════════════════════════════════
// DUEL ARENA CARD (Best of 3)
// ═══════════════════════════════════════════════════════════════════════════════

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

export async function generateDuelArenaCard(data: DuelArenaData): Promise<Buffer> {
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
  ctx.fillText(`Best of ${roundCount} · Match #${data.matchId}`, W / 2, headerY + 34);

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
    data.rounds.flatMap((r) => [safeLoadImage(r.cardA.imageUrl), safeLoadImage(r.cardB.imageUrl)]),
  );

  for (let i = 0; i < roundCount; i++) {
    const round = data.rounds[i]!;
    const ry = HEADER_H + i * ROUND_H;
    const imgA = allCardImages[i * 2]!;
    const imgB = allCardImages[i * 2 + 1]!;

    // Row background
    ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.015)" : "rgba(0,0,0,0.06)";
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
      ctx.fillText(DUEL_ELEMENT_ICONS[card.element] ?? "⚪", x + cW - 18, y + 23);

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
    const barAGrad = ctx.createLinearGradient(midX - 40 - barW, 0, midX - 40, 0);
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
    const barBGrad = ctx.createLinearGradient(midX + 40, 0, midX + 40 + barW, 0);
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
      if (ctx.measureText(truncated).width > 550) truncated = `${truncated.slice(0, 65)}…`;
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
  const winnerName = data.winner === "A" ? data.playerA.name : data.playerB.name;
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
