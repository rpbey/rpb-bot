import {
  createCanvas,
  GlobalFonts,
  loadImage,
  type Canvas,
  type Image as CanvasImageType,
  type SKRSContext2D,
} from "@aphrody-code/canvas";

import { resolveRootPath } from "../paths.js";

export type CanvasCtx = SKRSContext2D;
export type CanvasImage = CanvasImageType;
export type { Canvas };

// ─── Font registration ─────────────────────────────────────────────
// Idempotent: safe to import from multiple modules.

let FONTS_REGISTERED = false;

export function registerCanvasFonts(): void {
  if (FONTS_REGISTERED) return;
  try {
    GlobalFonts.registerFromPath(
      resolveRootPath("public/Google_Sans_Flex/static/GoogleSansFlex_72pt-Bold.ttf"),
      "GoogleSans",
    );
  } catch {
    // Font already registered or path missing — fail soft.
  }
  try {
    GlobalFonts.registerFromPath("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "NotoEmoji");
  } catch {
    // Emoji font unavailable — fallback to text symbols.
  }
  FONTS_REGISTERED = true;
}

registerCanvasFonts();

/** CSS font shorthand with emoji fallback. */
export const FONT = (weight: string, size: number): string =>
  `${weight} ${size}px GoogleSans, NotoEmoji, sans-serif`;

// ─── Palette ───────────────────────────────────────────────────────

export const RPB_COLORS = {
  red: "#ce0c07",
  orange: "#e68002",
  yellow: "#f7d301",
  bg: "#141111",
  surface: "#1d1b1b",
  surfaceAlt: "#252222",
  surfaceRing: "#2d2929",
  text: "#f5f0f0",
  subText: "#a89999",
  muted: "#64748b",
  win: "#22c55e",
  loss: "#ef4444",
  warn: "#e68002",
} as const;

export const MEDAL_COLORS = ["#f7d301", "#C0C0C0", "#CD7F32"] as const;

// ─── Drawing primitives ────────────────────────────────────────────

type Corners = number | [number, number, number, number];

/**
 * Horizontal red→orange→yellow gradient bar (RPB chrome).
 * Used for top/bottom stripes and highlight elements.
 */
export function drawRpbGradientBar(
  ctx: CanvasCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  corners: Corners = 0,
): void {
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, RPB_COLORS.red);
  g.addColorStop(0.5, RPB_COLORS.orange);
  g.addColorStop(1, RPB_COLORS.yellow);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, corners as never);
  ctx.fill();
}

export interface CardChromeOptions {
  pad?: number;
  radius?: number;
  topBar?: boolean;
  bottomBar?: boolean;
  barHeight?: number;
  bgColor?: string;
  surfaceColor?: string;
}

/**
 * Paint the canonical RPB card chrome: dark background, inner rounded
 * surface, and optional top/bottom RPB gradient stripes.
 */
export function drawCardChrome(
  ctx: CanvasCtx,
  width: number,
  height: number,
  opts: CardChromeOptions = {},
): void {
  const {
    pad = 16,
    radius = 16,
    topBar = true,
    bottomBar = true,
    barHeight = 4,
    bgColor = RPB_COLORS.bg,
    surfaceColor = RPB_COLORS.surface,
  } = opts;

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = surfaceColor;
  ctx.beginPath();
  ctx.roundRect(pad, pad, width - pad * 2, height - pad * 2, radius);
  ctx.fill();

  if (topBar) {
    drawRpbGradientBar(ctx, pad, pad, width - pad * 2, barHeight, [radius, radius, 0, 0]);
  }
  if (bottomBar) {
    drawRpbGradientBar(ctx, pad, height - pad - barHeight, width - pad * 2, barHeight, [
      0,
      0,
      radius,
      radius,
    ]);
  }
}

/** Faint diagonal speed lines — classic shonen background texture. */
export function drawSpeedLines(
  ctx: CanvasCtx,
  width: number,
  height: number,
  opts: { alpha?: number; step?: number; slope?: number; color?: string } = {},
): void {
  const { alpha = 0.02, step = 18, slope = 0.4, color = "#ffffff" } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = -height; i < width + height; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + height * slope, height);
    ctx.stroke();
  }
  ctx.restore();
}

export interface CircularAvatarOptions {
  borderColor?: string | null;
  borderWidth?: number;
  fallbackColor?: string;
  glow?: boolean;
}

/**
 * Clip to a circle and draw an avatar. Optional border ring on top.
 * If `img` is null, fills the circle with `fallbackColor`.
 */
export function drawCircularAvatar(
  ctx: CanvasCtx,
  img: CanvasImage | null,
  cx: number,
  cy: number,
  radius: number,
  opts: CircularAvatarOptions = {},
): void {
  const { borderColor = null, borderWidth = 2, fallbackColor = "#2d2929", glow = false } = opts;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    ctx.drawImage(img, cx - radius, cy - radius, radius * 2, radius * 2);
  } else {
    ctx.fillStyle = fallbackColor;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }
  ctx.restore();

  if (borderColor) {
    ctx.save();
    if (glow) {
      ctx.shadowColor = borderColor;
      ctx.shadowBlur = 10;
    }
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = borderWidth;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ─── Image loading ─────────────────────────────────────────────────

const SKIP_BG_REMOVAL_DOMAINS = [
  "cdn.discordapp.com",
  "cdn.discord.com",
  "images-ext-",
  "media.discordapp.net",
];

export function shouldSkipBgRemoval(source: string): boolean {
  return SKIP_BG_REMOVAL_DOMAINS.some((d) => source.includes(d));
}

/**
 * Load an image from a URL or a file path, without any post-processing.
 * HTTP sources are pre-fetched to a Buffer so that `loadImage` never
 * performs the network request itself (cleaner error handling, respects
 * `fetch` semantics).
 */
export async function loadImageDirect(url: string | null): Promise<CanvasImage | null> {
  if (!url) return null;
  try {
    let source: string | Buffer = url;
    if (url.startsWith("/")) {
      source = resolveRootPath(`public${url}`);
    }
    if (typeof source === "string" && source.startsWith("http")) {
      const res = await fetch(source);
      if (!res.ok) return null;
      source = Buffer.from(await res.arrayBuffer());
    }
    return await loadImage(source);
  } catch {
    return null;
  }
}

// ─── Canvas factory + PNG encoder ──────────────────────────────────

export function makeCanvas(width: number, height: number): Canvas {
  return createCanvas(width, height);
}

/**
 * Async PNG export — runs in libuv thread pool (non-blocking).
 * Prefer this over `canvas.toBuffer('image/png')` which is sync and
 * stalls the event loop while Skia encodes.
 */
export function encodePng(canvas: Canvas): Promise<Buffer> {
  return canvas.encode("png");
}

/** Async JPEG/WebP/AVIF/GIF encoders — same non-blocking guarantee. */
export function encodeJpeg(canvas: Canvas, quality = 90): Promise<Buffer> {
  return canvas.encode("jpeg", quality);
}

export function encodeWebp(canvas: Canvas, quality = 90): Promise<Buffer> {
  return canvas.encode("webp", quality);
}

// ─── Text helpers ──────────────────────────────────────────────────

/** Truncate + uppercase a blader name for card display. */
export function formatBladerName(name: string, max = 18): string {
  return name.length > max ? `${name.substring(0, max).toUpperCase()}…` : name.toUpperCase();
}

/**
 * Paint a text string with the RPB red→orange→yellow gradient, centered
 * at (cx, y). Measurement is done on the current ctx.font.
 */
export function fillRpbGradientText(ctx: CanvasCtx, text: string, cx: number, y: number): void {
  const w = ctx.measureText(text).width;
  const g = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
  g.addColorStop(0, RPB_COLORS.red);
  g.addColorStop(0.5, RPB_COLORS.orange);
  g.addColorStop(1, RPB_COLORS.yellow);
  const prev = ctx.textAlign;
  ctx.textAlign = "center";
  ctx.fillStyle = g;
  ctx.fillText(text, cx, y);
  ctx.textAlign = prev;
}

/**
 * Paint a text string with an arbitrary horizontal gradient (two stops).
 */
export function fillGradientText(
  ctx: CanvasCtx,
  text: string,
  cx: number,
  y: number,
  from: string,
  to: string,
): void {
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

// ─── Variant themes (aligned with rpbey.fr pages) ──────────────────

export type RankingVariant = "rpb" | "wb" | "satr";

export interface VariantTheme {
  /** Primary hex used for the header title gradient start + points text. */
  primary: string;
  /** Secondary hex for the gradient end + accent glow. */
  secondary: string;
  /** Track / rail tint for progress arcs and filled pills. */
  accent: string;
  /** Chrome stripe colors (top/bottom bar 3-stop gradient). */
  barStops: readonly [string, string, string];
  /** Human-readable tag shown below the title. */
  badge: string;
  /** Footer URL shown at the bottom of the card. */
  footerUrl: string;
}

export const VARIANT_THEMES: Record<RankingVariant, VariantTheme> = {
  rpb: {
    primary: "#ce0c07",
    secondary: "#f7d301",
    accent: "#e68002",
    barStops: ["#ce0c07", "#e68002", "#f7d301"],
    badge: "RPB · CLASSEMENT OFFICIEL",
    footerUrl: "rpbey.fr/rankings",
  },
  wb: {
    // Tailwind violet-500 → purple-500, matches /tournaments/wb theme
    primary: "#8b5cf6",
    secondary: "#c084fc",
    accent: "#a855f7",
    barStops: ["#6d28d9", "#8b5cf6", "#c084fc"],
    badge: "ULTIME BATAILLE · WILD BREAKERS",
    footerUrl: "rpbey.fr/tournaments/wb",
  },
  satr: {
    // Rose-red used on /tournaments/satr (BBT)
    primary: "#ef4444",
    secondary: "#f97316",
    accent: "#f43f5e",
    barStops: ["#be123c", "#ef4444", "#f97316"],
    badge: "BBT · SUN AFTER THE REIGN",
    footerUrl: "rpbey.fr/tournaments/satr",
  },
};

/**
 * Draw a 3-stop horizontal gradient bar using variant colors.
 */
export function drawVariantGradientBar(
  ctx: CanvasCtx,
  theme: VariantTheme,
  x: number,
  y: number,
  w: number,
  h: number,
  corners: Corners = 0,
): void {
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, theme.barStops[0]);
  g.addColorStop(0.5, theme.barStops[1]);
  g.addColorStop(1, theme.barStops[2]);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, corners as never);
  ctx.fill();
}

/**
 * Card chrome for a ranking variant — surface + top/bottom stripes in
 * the variant's palette.
 */
export function drawVariantChrome(
  ctx: CanvasCtx,
  theme: VariantTheme,
  width: number,
  height: number,
  opts: CardChromeOptions = {},
): void {
  const {
    pad = 16,
    radius = 16,
    topBar = true,
    bottomBar = true,
    barHeight = 4,
    bgColor = RPB_COLORS.bg,
    surfaceColor = RPB_COLORS.surface,
  } = opts;

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = surfaceColor;
  ctx.beginPath();
  ctx.roundRect(pad, pad, width - pad * 2, height - pad * 2, radius);
  ctx.fill();

  if (topBar) {
    drawVariantGradientBar(ctx, theme, pad, pad, width - pad * 2, barHeight, [
      radius,
      radius,
      0,
      0,
    ]);
  }
  if (bottomBar) {
    drawVariantGradientBar(ctx, theme, pad, height - pad - barHeight, width - pad * 2, barHeight, [
      0,
      0,
      radius,
      radius,
    ]);
  }
}

// ─── Podium (mirrors TopRankingsPodium.tsx layout 2-1-3) ───────────

export interface PodiumEntry {
  rank: 1 | 2 | 3;
  name: string;
  points: number;
  avatar: CanvasImage | null;
}

export interface DrawPodiumOptions {
  /** X coordinate of the leftmost podium slot. */
  x: number;
  /** Top Y coordinate for the podium band. */
  y: number;
  /** Available width for the whole podium (3 cards + gaps). */
  width: number;
  /** Maximum height for the podium band. */
  height?: number;
}

/**
 * Paint a 3-up podium (order 2-1-3, #1 raised + taller + glowing).
 * Missing ranks are skipped gracefully.
 */
export function drawPodium(
  ctx: CanvasCtx,
  theme: VariantTheme,
  entries: PodiumEntry[],
  opts: DrawPodiumOptions,
): void {
  const { x, y, width, height = 200 } = opts;

  const byRank = new Map(entries.map((e) => [e.rank, e]));
  const order: Array<PodiumEntry | null> = [
    byRank.get(2) ?? null,
    byRank.get(1) ?? null,
    byRank.get(3) ?? null,
  ];

  const gap = 18;
  const cardW = (width - gap * 2) / 3;
  const firstH = height;
  const sideH = Math.round(height * 0.85);

  for (let i = 0; i < 3; i++) {
    const entry = order[i];
    if (!entry) continue;
    const isFirst = entry.rank === 1;
    const cardH = isFirst ? firstH : sideH;
    const cx = x + i * (cardW + gap);
    const cy = y + (firstH - cardH); // bottom-align
    const medal = MEDAL_COLORS[entry.rank - 1]!;

    // Card body
    ctx.save();
    ctx.fillStyle = RPB_COLORS.surfaceAlt;
    ctx.beginPath();
    ctx.roundRect(cx, cy, cardW, cardH, 18);
    ctx.fill();
    if (isFirst) {
      ctx.shadowColor = medal;
      ctx.shadowBlur = 22;
    }
    ctx.strokeStyle = medal;
    ctx.lineWidth = isFirst ? 2.5 : 1.5;
    ctx.globalAlpha = isFirst ? 0.85 : 0.5;
    ctx.beginPath();
    ctx.roundRect(cx, cy, cardW, cardH, 18);
    ctx.stroke();
    ctx.restore();

    // Trophy badge on top
    const badgeR = 18;
    const badgeCx = cx + cardW / 2;
    const badgeCy = cy - 4;
    ctx.save();
    ctx.fillStyle = medal;
    ctx.shadowColor = medal;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(badgeCx, badgeCy, badgeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.font = FONT("bold", 16);
    ctx.fillStyle = entry.rank === 1 ? "#000" : "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🏆", badgeCx, badgeCy + 1);
    ctx.textBaseline = "alphabetic";

    // Avatar
    const avR = isFirst ? 36 : 30;
    const avY = cy + 30 + avR;
    drawCircularAvatar(ctx, entry.avatar, cx + cardW / 2, avY, avR, {
      borderColor: medal,
      borderWidth: 2,
      glow: isFirst,
    });

    // Name
    ctx.font = FONT("bold", isFirst ? 20 : 17);
    ctx.fillStyle = RPB_COLORS.text;
    ctx.textAlign = "center";
    const displayName = formatBladerName(entry.name, 14);
    ctx.fillText(displayName, cx + cardW / 2, avY + avR + 28);

    // "BLADER RPB" caption
    ctx.font = FONT("bold", 10);
    ctx.fillStyle = RPB_COLORS.subText;
    ctx.fillText(`BLADER ${theme.badge.split(" ")[0]}`, cx + cardW / 2, avY + avR + 46);

    // Points pill
    const pillText = `${entry.points.toLocaleString()} PTS`;
    ctx.font = FONT("bold", isFirst ? 18 : 15);
    const pillW = ctx.measureText(pillText).width + 22;
    const pillH = isFirst ? 30 : 26;
    const pillX = cx + cardW / 2 - pillW / 2;
    const pillY = cy + cardH - pillH - 14;
    ctx.save();
    ctx.fillStyle = `${medal}22`; // ~13% alpha
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
