import {
  createCanvas,
  GlobalFonts,
  loadImage,
  type SKRSContext2D,
} from '@aphrody-code/canvas';
import { resolveRootPath } from './paths.js';
import prisma from './prisma.js';

// --- Types ---
interface MetaSynergy {
  name: string;
  score: number;
}

interface MetaComponent {
  name: string;
  score: number;
  position_change: number | 'NEW';
  synergy: MetaSynergy[];
}

interface MetaCategory {
  category: string;
  components: MetaComponent[];
}

interface MetaPeriod {
  metadata: {
    startDate: string;
    endDate: string;
    eventsScanned: number;
    partsAnalyzed: number;
  };
  categories: MetaCategory[];
}

type CanvasImage = Awaited<ReturnType<typeof loadImage>>;

// --- Constants ---
const CATEGORY_COLORS: Record<string, string> = {
  Blade: '#dc2626',
  Ratchet: '#fbbf24',
  Bit: '#22c55e',
  'Lock Chip': '#60a5fa',
  'Assist Blade': '#a855f7',
};

// Manual mappings for bbx-weekly names → DB names
const NAME_ALIASES: Record<string, string> = {
  blast: 'pegasus blast',
  'metal chip': 'metal lock chip - emperor',
  'plastic chip': 'plastic lock chip',
};

// --- Font setup ---
try {
  const fontPath = resolveRootPath(
    'public/Google_Sans_Flex/static/GoogleSansFlex_72pt-Bold.ttf',
  );
  GlobalFonts.registerFromPath(fontPath, 'MetaSans');
} catch {
  // Already registered
}

// --- Image cache ---
let partImageCache: Map<string, string> | null = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

async function getPartImageCache(): Promise<Map<string, string>> {
  const now = Date.now();
  if (partImageCache && now - cacheTime < CACHE_TTL) return partImageCache;

  const map = new Map<string, string>();
  try {
    const parts = await prisma.part.findMany({
      where: { imageUrl: { not: null } },
      select: { name: true, imageUrl: true },
    });
    for (const p of parts) {
      if (!p.imageUrl) continue;
      map.set(p.name.toLowerCase(), p.imageUrl);
      // Also index parenthetical: "H (Heavy)" → "heavy"
      const m = p.name.match(/\(([^)]+)\)/);
      if (m) map.set(m[1].toLowerCase(), p.imageUrl);
    }
  } catch {
    // DB unavailable
  }
  partImageCache = map;
  cacheTime = now;
  return map;
}

async function resolvePartImage(name: string): Promise<string | null> {
  const cache = await getPartImageCache();
  const norm = name.toLowerCase();
  return (
    cache.get(norm) ||
    cache.get(norm.replace(/\s+/g, '')) ||
    cache.get(NAME_ALIASES[norm] || '') ||
    null
  );
}

async function loadPartImage(name: string): Promise<CanvasImage | null> {
  const url = await resolvePartImage(name);
  if (!url) return null;
  return safeLoadImage(url);
}

async function safeLoadImage(
  urlOrPath: string | null,
): Promise<CanvasImage | null> {
  if (!urlOrPath) return null;
  try {
    let target = urlOrPath;
    if (target.startsWith('/')) {
      target = resolveRootPath(`public${target}`);
    }
    return await loadImage(target);
  } catch {
    return null;
  }
}

// Batch load images for a list of names
async function loadImages(
  names: string[],
): Promise<Map<string, CanvasImage | null>> {
  const map = new Map<string, CanvasImage | null>();
  const unique = [...new Set(names)];
  await Promise.all(
    unique.map(async (name) => {
      map.set(name, await loadPartImage(name));
    }),
  );
  return map;
}

// --- Drawing primitives ---
function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawBg(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  bg: CanvasImage | null,
) {
  if (bg) {
    ctx.drawImage(bg, 0, 0, w, h);
    // Dark overlay
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, 0, w, h);
  } else {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#0f0f1a');
    grad.addColorStop(0.5, '#1a1025');
    grad.addColorStop(1, '#0f0f1a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
  // Subtle noise grid
  ctx.strokeStyle = 'rgba(255,255,255,0.015)';
  ctx.lineWidth = 1;
  for (let i = 0; i < w; i += 50) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, h);
    ctx.stroke();
  }
  for (let i = 0; i < h; i += 50) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(w, i);
    ctx.stroke();
  }
}

function drawBar(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  ratio: number,
  color: string,
) {
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fill();
  const fillW = Math.max(h, ratio * w);
  roundRect(ctx, x, y, fillW, h, h / 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawCircleImage(
  ctx: SKRSContext2D,
  img: CanvasImage | null,
  cx: number,
  cy: number,
  r: number,
  borderColor: string,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fill();
  if (img) {
    ctx.clip();
    ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

function drawTrend(
  ctx: SKRSContext2D,
  change: number | 'NEW',
  x: number,
  y: number,
) {
  ctx.font = 'bold 13px MetaSans';
  if (change === 'NEW') {
    ctx.fillStyle = '#22c55e';
    ctx.fillText('NEW', x, y);
  } else if (change > 0) {
    ctx.fillStyle = '#22c55e';
    ctx.fillText(`▲${change}`, x, y);
  } else if (change < 0) {
    ctx.fillStyle = '#ef4444';
    ctx.fillText(`▼${Math.abs(change)}`, x, y);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillText('—', x, y);
  }
}

function truncText(ctx: SKRSContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  for (let i = text.length - 1; i > 0; i--) {
    const t = `${text.slice(0, i)}…`;
    if (ctx.measureText(t).width <= maxW) return t;
  }
  return '…';
}

function dateFr(d: string): string {
  return new Date(d).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
  });
}

function dateRange(start: string, end: string): string {
  const e = new Date(end).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${dateFr(start)} — ${e}`;
}

function headerGradient(ctx: SKRSContext2D, w: number, y: number) {
  const grad = ctx.createLinearGradient(40, y, w - 40, y);
  grad.addColorStop(0, '#dc2626');
  grad.addColorStop(0.25, '#fbbf24');
  grad.addColorStop(0.5, '#22c55e');
  grad.addColorStop(0.75, '#60a5fa');
  grad.addColorStop(1, '#a855f7');
  ctx.fillStyle = grad;
  ctx.fillRect(40, y, w - 80, 2);
}

function footer(ctx: SKRSContext2D, w: number, h: number, scrapedAt: string) {
  ctx.font = '13px MetaSans';
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.textAlign = 'center';
  const updated = new Date(scrapedAt).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  ctx.fillText(
    `rpbey.fr/meta · bbxweekly.com · Mis à jour le ${updated}`,
    w / 2,
    h - 14,
  );
  ctx.textAlign = 'left';
}

const MEDAL_COLORS = ['#fbbf24', '#c0c0c0', '#cd7f32'];

// =============================================================
// generateMetaTopCanvas — Overview of all categories (landscape)
// =============================================================
export async function generateMetaTopCanvas(
  period: MetaPeriod,
  scrapedAt: string,
  pKey: string,
): Promise<Buffer> {
  const PARTS_PER_CAT = 4;
  const ROW_H = 70;
  const catCount = period.categories.length;
  const width = 1400;
  const height = 120 + PARTS_PER_CAT * ROW_H + 50;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bg = await safeLoadImage('/canvas.webp');
  drawBg(ctx, width, height, bg);

  // Collect part names and load images
  const allNames: string[] = [];
  for (const cat of period.categories) {
    for (const c of cat.components.slice(0, PARTS_PER_CAT)) {
      allNames.push(c.name);
    }
  }
  const images = await loadImages(allNames);
  const logo = await safeLoadImage('/logo.webp');

  // --- Header ---
  if (logo) ctx.drawImage(logo, 40, 18, 55, 55);
  ctx.font = 'bold 34px MetaSans';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('MÉTA BEYBLADE X', 108, 52);

  const { metadata } = period;
  const pLabel = pKey === '2weeks' ? '2 sem.' : '4 sem.';
  ctx.font = '16px MetaSans';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText(
    `${dateRange(metadata.startDate, metadata.endDate)} (${pLabel}) · ${metadata.eventsScanned} tournois · ${metadata.partsAnalyzed} pièces`,
    108,
    74,
  );

  headerGradient(ctx, width, 88);

  // --- Category columns ---
  const colW = (width - 80) / catCount;
  const startY = 100;

  for (let ci = 0; ci < catCount; ci++) {
    const cat = period.categories[ci];
    const color = CATEGORY_COLORS[cat.category] || '#888';
    const x = 40 + ci * colW;
    const maxScore = cat.components[0]?.score || 100;

    // Category header bar
    ctx.fillStyle = color;
    ctx.fillRect(x, startY, colW - 12, 3);
    ctx.font = 'bold 14px MetaSans';
    ctx.fillStyle = color;
    ctx.fillText(cat.category.toUpperCase(), x + 2, startY + 20);

    // Parts
    for (
      let pi = 0;
      pi < Math.min(cat.components.length, PARTS_PER_CAT);
      pi++
    ) {
      const comp = cat.components[pi];
      const py = startY + 30 + pi * ROW_H;
      const img = images.get(comp.name) || null;
      const imgR = 22;

      // Rank
      ctx.font = 'bold 18px MetaSans';
      ctx.fillStyle = pi < 3 ? MEDAL_COLORS[pi] : 'rgba(255,255,255,0.25)';
      ctx.fillText(`${pi + 1}`, x + 2, py + imgR + 5);

      // Image
      drawCircleImage(ctx, img, x + 48, py + imgR, imgR, color);

      // Name (properly truncated)
      ctx.font = 'bold 15px MetaSans';
      ctx.fillStyle = '#ffffff';
      const nameMaxW = colW - 155;
      ctx.fillText(truncText(ctx, comp.name, nameMaxW), x + 78, py + 14);

      // Score + trend
      ctx.font = 'bold 22px MetaSans';
      ctx.fillStyle = color;
      const scoreStr = `${comp.score}`;
      ctx.fillText(scoreStr, x + 78, py + 40);

      const scoreW = ctx.measureText(scoreStr).width;
      ctx.font = '12px MetaSans';
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText('/100', x + 80 + scoreW, py + 40);

      drawTrend(ctx, comp.position_change, x + 140, py + 40);

      // Score bar
      drawBar(ctx, x, py + 48, colW - 15, 5, comp.score / maxScore, color);

      // Synergy hints
      if (comp.synergy?.length) {
        ctx.font = '11px MetaSans';
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        const synText = comp.synergy
          .slice(0, 3)
          .map((s) => s.name)
          .join(' · ');
        ctx.fillText(truncText(ctx, synText, colW - 15), x, py + 63);
      }
    }
  }

  footer(ctx, width, height, scrapedAt);
  return canvas.toBuffer('image/png');
}

// =============================================================
// generateMetaCategoryCanvas — Detail of a single category
// =============================================================
export async function generateMetaCategoryCanvas(
  cat: MetaCategory,
  period: MetaPeriod,
  scrapedAt: string,
  pKey: string,
): Promise<Buffer> {
  const partsToShow = cat.components.slice(0, 8);
  const width = 1100;
  const ROW_H = 85;
  const height = 110 + partsToShow.length * ROW_H + 40;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const color = CATEGORY_COLORS[cat.category] || '#888';

  const bg = await safeLoadImage('/canvas.webp');
  drawBg(ctx, width, height, bg);

  // Load images
  const allNames = partsToShow.flatMap((c) => [
    c.name,
    ...c.synergy.slice(0, 4).map((s) => s.name),
  ]);
  const images = await loadImages(allNames);

  // Header
  ctx.fillStyle = color;
  ctx.fillRect(40, 28, 5, 32);
  ctx.font = 'bold 30px MetaSans';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(cat.category.toUpperCase(), 55, 56);

  // Count badge
  ctx.font = 'bold 13px MetaSans';
  const countText = `${cat.components.length} pièces`;
  const titleW = ctx.measureText(cat.category.toUpperCase()).width;
  const badgeX = 60 + titleW + 12;
  const badgeW = ctx.measureText(countText).width + 14;
  roundRect(ctx, badgeX, 38, badgeW, 22, 11);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.2;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillText(countText, badgeX + 7, 54);

  // Period info (right)
  ctx.font = '14px MetaSans';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.textAlign = 'right';
  const pLabel = pKey === '2weeks' ? '2 sem.' : '4 sem.';
  ctx.fillText(
    `${dateRange(period.metadata.startDate, period.metadata.endDate)} (${pLabel}) · ${period.metadata.eventsScanned} tournois`,
    width - 40,
    54,
  );
  ctx.textAlign = 'left';

  ctx.fillStyle = color;
  ctx.fillRect(40, 72, width - 80, 2);

  // Parts
  const maxScore = partsToShow[0]?.score || 100;
  const startY = 90;

  for (let i = 0; i < partsToShow.length; i++) {
    const comp = partsToShow[i];
    const py = startY + i * ROW_H;

    // Alternating row
    if (i % 2 === 0) {
      roundRect(ctx, 35, py, width - 70, ROW_H - 4, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      ctx.fill();
    }

    // Rank
    ctx.font = 'bold 22px MetaSans';
    ctx.fillStyle = i < 3 ? MEDAL_COLORS[i] : 'rgba(255,255,255,0.25)';
    ctx.textAlign = 'center';
    ctx.fillText(`${i + 1}`, 60, py + 35);
    ctx.textAlign = 'left';

    // Part image
    const img = images.get(comp.name) || null;
    drawCircleImage(ctx, img, 108, py + 28, 26, color);

    // Name
    ctx.font = 'bold 18px MetaSans';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(comp.name, 145, py + 25);

    // Score + bar
    ctx.font = 'bold 24px MetaSans';
    ctx.fillStyle = color;
    ctx.fillText(`${comp.score}`, 145, py + 52);
    const sw = ctx.measureText(`${comp.score}`).width;
    ctx.font = '14px MetaSans';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText('/100', 148 + sw, py + 52);
    drawTrend(ctx, comp.position_change, 215, py + 52);
    drawBar(ctx, 145, py + 60, 140, 5, comp.score / maxScore, color);

    // Synergies (right half)
    if (comp.synergy?.length) {
      const synX = 450;
      ctx.font = '11px MetaSans';
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillText('SYNERGIES', synX, py + 10);

      const maxSyn = comp.synergy[0]?.score || 100;
      const synCount = Math.min(comp.synergy.length, 4);

      for (let si = 0; si < synCount; si++) {
        const syn = comp.synergy[si];
        const sy = py + 16 + si * 17;

        // Mini image
        const synImg = images.get(syn.name) || null;
        if (synImg) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(synX + 7, sy + 4, 7, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(synImg, synX, sy - 3, 14, 14);
          ctx.restore();
        }

        // Name
        ctx.font = '12px MetaSans';
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        ctx.fillText(truncText(ctx, syn.name, 110), synX + 20, sy + 9);

        // Bar + score
        drawBar(ctx, synX + 140, sy + 3, 120, 4, syn.score / maxSyn, color);
        ctx.font = '11px MetaSans';
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText(`${syn.score}`, synX + 268, sy + 9);
      }
    }
  }

  footer(ctx, width, height, scrapedAt);
  return canvas.toBuffer('image/png');
}

// =============================================================
// generateMetaComboCanvas — Best combo of the moment
// =============================================================
export async function generateMetaComboCanvas(
  period: MetaPeriod,
  scrapedAt: string,
  pKey: string,
): Promise<Buffer> {
  const width = 1100;
  const height = 420;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bg = await safeLoadImage('/canvas.webp');
  drawBg(ctx, width, height, bg);

  // Gather #1 of each category
  const order = ['Lock Chip', 'Blade', 'Assist Blade', 'Ratchet', 'Bit'];
  const tops = order.map((name) => {
    const cat = period.categories.find((c) => c.category === name);
    return {
      label: name,
      comp: cat?.components[0] || null,
      color: CATEGORY_COLORS[name] || '#888',
    };
  });

  const partNames = tops.map((t) => t.comp?.name).filter(Boolean) as string[];
  const images = await loadImages(partNames);
  const logo = await safeLoadImage('/logo.webp');

  // Header
  if (logo) ctx.drawImage(logo, 40, 16, 48, 48);
  ctx.font = 'bold 32px MetaSans';
  ctx.fillStyle = '#fbbf24';
  ctx.fillText('COMBO DU MOMENT', 100, 48);

  const pLabel = pKey === '2weeks' ? '2 sem.' : '4 sem.';
  ctx.font = '15px MetaSans';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText(
    `${dateRange(period.metadata.startDate, period.metadata.endDate)} (${pLabel}) · ${period.metadata.eventsScanned} tournois`,
    100,
    70,
  );

  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(40, 82, width - 80, 2);

  // Parts in a row
  const spacing = (width - 80) / tops.length;
  const partsY = 110;
  const imgR = 50;

  for (let i = 0; i < tops.length; i++) {
    const { label, comp, color } = tops[i];
    if (!comp) continue;
    const cx = 40 + i * spacing + spacing / 2;

    // Image
    const img = images.get(comp.name) || null;
    drawCircleImage(ctx, img, cx, partsY + imgR, imgR, color);

    // Category
    ctx.font = 'bold 11px MetaSans';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(label.toUpperCase(), cx, partsY + imgR * 2 + 18);

    // Name
    ctx.font = 'bold 17px MetaSans';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(
      truncText(ctx, comp.name, spacing - 20),
      cx,
      partsY + imgR * 2 + 38,
    );

    // Score
    ctx.font = 'bold 26px MetaSans';
    ctx.fillStyle = color;
    ctx.fillText(`${comp.score}`, cx, partsY + imgR * 2 + 66);

    // Bar
    drawBar(
      ctx,
      cx - 45,
      partsY + imgR * 2 + 74,
      90,
      5,
      comp.score / 100,
      color,
    );

    // Top synergies
    if (comp.synergy?.length) {
      ctx.font = '11px MetaSans';
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      const synText = comp.synergy
        .slice(0, 2)
        .map((s) => s.name)
        .join(' · ');
      ctx.fillText(
        truncText(ctx, synText, spacing - 20),
        cx,
        partsY + imgR * 2 + 95,
      );
    }
  }
  ctx.textAlign = 'left';

  footer(ctx, width, height, scrapedAt);
  return canvas.toBuffer('image/png');
}

// =============================================================
// generateMetaPieceCanvas — Single part detail
// =============================================================
export async function generateMetaPieceCanvas(
  comp: MetaComponent,
  categoryName: string,
  period: MetaPeriod,
  scrapedAt: string,
  pKey: string,
): Promise<Buffer> {
  const synCount = Math.min(comp.synergy?.length || 0, 10);
  const width = 900;
  const height = 240 + synCount * 36 + 40;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const color = CATEGORY_COLORS[categoryName] || '#888';

  const bg = await safeLoadImage('/canvas.webp');
  drawBg(ctx, width, height, bg);

  // Load images
  const allNames = [
    comp.name,
    ...comp.synergy.slice(0, synCount).map((s) => s.name),
  ];
  const images = await loadImages(allNames);

  // Main part image (large)
  const img = images.get(comp.name) || null;
  drawCircleImage(ctx, img, 110, 95, 65, color);

  // Name
  ctx.font = 'bold 34px MetaSans';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(comp.name, 195, 72);

  // Category badge
  ctx.font = 'bold 13px MetaSans';
  const badge = categoryName.toUpperCase();
  const bw = ctx.measureText(badge).width + 14;
  roundRect(ctx, 195, 82, bw, 22, 11);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.2;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillText(badge, 202, 97);

  // Score
  ctx.font = 'bold 44px MetaSans';
  ctx.fillStyle = color;
  ctx.fillText(`${comp.score}`, 195, 150);
  const sw = ctx.measureText(`${comp.score}`).width;
  ctx.font = '20px MetaSans';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillText('/100', 198 + sw, 150);
  drawTrend(ctx, comp.position_change, 300, 150);

  // Score bar
  drawBar(ctx, 195, 162, 350, 7, comp.score / 100, color);

  // Period info (top right)
  const pLabel = pKey === '2weeks' ? '2 sem.' : '4 sem.';
  ctx.font = '13px MetaSans';
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.textAlign = 'right';
  ctx.fillText(
    `${dateRange(period.metadata.startDate, period.metadata.endDate)} (${pLabel})`,
    width - 40,
    45,
  );
  ctx.fillText(`${period.metadata.eventsScanned} tournois`, width - 40, 62);
  ctx.textAlign = 'left';

  // Synergies
  if (synCount > 0) {
    const synStartY = 195;
    ctx.fillStyle = color;
    ctx.fillRect(40, synStartY, 3, 22);
    ctx.font = 'bold 16px MetaSans';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`SYNERGIES (${comp.synergy.length})`, 52, synStartY + 18);

    const maxSyn = comp.synergy[0]?.score || 100;

    for (let i = 0; i < synCount; i++) {
      const syn = comp.synergy[i];
      const sy = synStartY + 32 + i * 36;

      // Alternating row
      if (i % 2 === 0) {
        roundRect(ctx, 35, sy - 4, width - 70, 32, 5);
        ctx.fillStyle = 'rgba(255,255,255,0.015)';
        ctx.fill();
      }

      // Rank
      ctx.font = 'bold 13px MetaSans';
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillText(`${i + 1}`, 50, sy + 16);

      // Image
      const synImg = images.get(syn.name) || null;
      drawCircleImage(ctx, synImg, 88, sy + 11, 11, 'rgba(255,255,255,0.1)');

      // Name
      ctx.font = '15px MetaSans';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(truncText(ctx, syn.name, 180), 110, sy + 17);

      // Bar
      drawBar(ctx, 340, sy + 10, 360, 5, syn.score / maxSyn, color);

      // Score
      ctx.font = 'bold 15px MetaSans';
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.fillText(`${syn.score}`, width - 45, sy + 17);
      ctx.textAlign = 'left';
    }
  }

  footer(ctx, width, height, scrapedAt);
  return canvas.toBuffer('image/png');
}
